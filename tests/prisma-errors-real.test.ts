import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { after, describe, it } from "node:test";

// P7X-5: the PR-10 matchers read meta.modelName and
// meta.driverAdapterError.cause.constraint.index, which Prisma and adapter-pg
// fill internally rather than as a public contract. tests/prisma-errors.test.ts
// builds that meta by hand, so this drives real errors through Prisma 7 and
// adapter-pg on in-memory Postgres (PGlite) with every migration. A Prisma
// upgrade that changes the shape fails here instead of sending benign races
// back to the error page.

process.env.DATABASE_URL ??= "postgresql://user:pass@localhost:5432/celluloid_test";

const { PGlite } = await import("@electric-sql/pglite");
const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
const { PrismaPg } = await import("@prisma/adapter-pg");
const { PrismaClient } = await import("../src/generated/prisma/client");
const { isRecordNotFound, isUniqueViolation } = await import("../src/lib/prisma-errors");

const db = await PGlite.create();
const migrations = new URL("../prisma/migrations/", import.meta.url);
for (const name of readdirSync(migrations).filter((entry) => /^\d/.test(entry)).sort()) {
  await db.exec(readFileSync(new URL(`${name}/migration.sql`, migrations), "utf8"));
}
// One connection: PGlite runs one session at a time.
const server = new PGLiteSocketServer({ db, port: 0 });
await server.start();
const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: `postgresql://postgres:postgres@${server.getServerConn()}/postgres`,
    max: 1,
  }),
});

after(async () => {
  await prisma.$disconnect();
  await server.stop();
  await db.close();
});

await prisma.user.create({ data: { id: "owner", name: "Owner", email: "owner@example.test" } });
const title = await prisma.title.create({
  data: { userId: "owner", tmdbId: 1, mediaType: "MOVIE", name: "Film", status: "WATCHED" },
});
const tag = await prisma.tag.create({ data: { userId: "owner", name: "comfort" } });

/** The error `run` rejects with; fails the test if it resolves. */
async function caught(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("expected a Prisma error");
}

describe("PR-10 matchers against real Prisma errors (P7X-5)", { concurrency: false }, () => {
  it("matches the toggleTag upsert race's P2002 on TitleTag_pkey", async () => {
    // The race: the other toggle's insert lands between the upsert's read and
    // its insert. A trigger inserts the same pair just before the upsert does.
    await db.exec(`
      CREATE FUNCTION race_title_tag() RETURNS trigger AS $$
      BEGIN
        IF pg_trigger_depth() = 1 THEN
          INSERT INTO "TitleTag" ("titleId", "tagId") VALUES (NEW."titleId", NEW."tagId");
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql;
      CREATE TRIGGER race_title_tag BEFORE INSERT ON "TitleTag"
        FOR EACH ROW EXECUTE FUNCTION race_title_tag();
    `);
    // In a transaction: PGlite's socket server drops the connection after a
    // failed statement outside one.
    const error = await caught(() =>
      prisma.$transaction((tx) =>
        tx.titleTag.upsert({
          where: { titleId_tagId: { titleId: title.id, tagId: tag.id } },
          create: { titleId: title.id, tagId: tag.id },
          update: {},
        }),
      ),
    );
    await db.exec(`DROP TRIGGER race_title_tag ON "TitleTag"; DROP FUNCTION race_title_tag();`);

    assert.equal((error as { code?: unknown }).code, "P2002");
    assert.equal(isUniqueViolation(error, "TitleTag", "TitleTag_pkey"), true);
    // Still narrow: another model or constraint doesn't match.
    assert.equal(isUniqueViolation(error, "Tag", "TitleTag_pkey"), false);
    assert.equal(isUniqueViolation(error, "TitleTag", "Tag_userId_name_key"), false);
  });

  it("doesn't match a real P2002 on another model's constraint", async () => {
    const error = await caught(() =>
      prisma.$transaction((tx) => tx.tag.create({ data: { userId: "owner", name: "comfort" } })),
    );
    assert.equal((error as { code?: unknown }).code, "P2002");
    assert.equal(isUniqueViolation(error, "TitleTag", "TitleTag_pkey"), false);
    assert.equal(isUniqueViolation(error, "Tag", "Tag_userId_name_key"), true);
  });

  for (const op of ["delete", "update"] as const) {
    it(`matches the P2025 of a WatchEvent ${op} that lost the race`, async () => {
      const event = await prisma.watchEvent.create({
        data: {
          userId: "owner",
          titleId: title.id,
          kind: "TITLE_COMPLETED",
          occurredAt: new Date("2026-01-01T00:00:00Z"),
        },
      });
      await prisma.watchEvent.delete({ where: { id: event.id } }); // the other tab

      // As deleteWatchEvent and updateWatchEvent run it: under the title lock,
      // catching the error and carrying on in the same transaction.
      const { error, notes } = await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Title" WHERE id = ${title.id} FOR UPDATE`;
        const error = await caught(() =>
          op === "delete"
            ? tx.watchEvent.delete({ where: { id: event.id } })
            : tx.watchEvent.update({ where: { id: event.id }, data: { note: "x" } }),
        );
        const updated = await tx.title.update({
          where: { id: title.id },
          data: { notes: `after ${op}` },
          select: { notes: true },
        });
        return { error, notes: updated.notes };
      });

      assert.equal((error as { code?: unknown }).code, "P2025");
      assert.equal(isRecordNotFound(error, "WatchEvent"), true);
      assert.equal(isRecordNotFound(error, "Title"), false);
      // The transaction stayed usable and committed.
      assert.equal(notes, `after ${op}`);
      const stored = await prisma.title.findUniqueOrThrow({ where: { id: title.id } });
      assert.equal(stored.notes, `after ${op}`);
    });
  }
});

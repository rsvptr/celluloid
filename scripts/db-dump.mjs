// Full read-only data dump of every application table to a timestamped JSON
// file under backups/ (gitignored). This is the pre-migration safety copy:
// small personal DB, so a complete JSON snapshot via the existing Prisma
// client is a faithful, restorable record of the data (auth tables included —
// the file stays local and is never committed).
//
// Usage: node --env-file=.env.local --import tsx scripts/db-dump.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = join(process.cwd(), "backups");
mkdirSync(outDir, { recursive: true });

const tables = {
  user: () => prisma.user.findMany(),
  session: () => prisma.session.findMany(),
  account: () => prisma.account.findMany(),
  verification: () => prisma.verification.findMany(),
  twoFactor: () => prisma.twoFactor.findMany(),
  title: () => prisma.title.findMany(),
  season: () => prisma.season.findMany(),
  episode: () => prisma.episode.findMany(),
  tag: () => prisma.tag.findMany(),
  titleTag: () => prisma.titleTag.findMany(),
  shareList: () => prisma.shareList.findMany(),
};

const dump = { takenAt: new Date().toISOString(), tables: {} };
const counts = {};
for (const [name, fetch] of Object.entries(tables)) {
  try {
    const rows = await fetch();
    dump.tables[name] = rows;
    counts[name] = rows.length;
  } catch (err) {
    counts[name] = `SKIPPED: ${err.message?.slice(0, 80)}`;
    dump.tables[name] = null;
  }
}

const file = join(outDir, `pre-migration-${stamp}.json`);
writeFileSync(file, JSON.stringify(dump, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
console.log(JSON.stringify({ file, counts }, null, 1));
await prisma.$disconnect();

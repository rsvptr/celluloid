/**
 * Creates a full, read-only JSON snapshot before a schema migration.
 *
 * The target is deliberately explicit: DATABASE_URL is the development branch
 * and PROD_DATABASE_URL is production. The script prints only a sanitized
 * host/database description, requires an interactive confirmation by default,
 * and writes the credential-bearing result under the gitignored backups/
 * directory with owner-only permissions where the platform supports them.
 *
 * Usage:
 *   npm run db:dump -- --target dev
 *   npm run db:dump -- --target prod
 *
 * Add --yes only after independently verifying the printed target.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client.ts";
import { loadEnv } from "./load-env.mjs";

const TARGETS = {
  dev: { envName: "DATABASE_URL", label: "DEVELOPMENT" },
  prod: { envName: "PROD_DATABASE_URL", label: "PRODUCTION" },
};

const USAGE = `Usage: npm run db:dump -- --target dev|prod [--yes]

  --target dev   Read DATABASE_URL
  --target prod  Read PROD_DATABASE_URL
  --yes          Skip the interactive confirmation after checking the target
  --help         Show this help without connecting to a database`;

export function parseArgs(argv) {
  let target;
  let yes = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--yes") {
      yes = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    let value;
    if (arg === "--target") {
      value = argv[index + 1];
      index += 1;
      if (!value || value.startsWith("--")) {
        throw new Error("--target requires either dev or prod.");
      }
    } else if (arg.startsWith("--target=")) {
      value = arg.slice("--target=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }

    if (target !== undefined) {
      throw new Error("--target may be supplied only once.");
    }
    if (!(value in TARGETS)) {
      throw new Error(`Invalid target ${JSON.stringify(value)}; expected dev or prod.`);
    }
    target = value;
  }

  if (help) return { help: true, target, yes };
  if (target === undefined) {
    throw new Error("An explicit --target dev|prod is required.");
  }
  return { help: false, target, yes };
}

/** Credentials and query parameters are deliberately excluded. */
export function describeTarget(connectionString) {
  let parsed;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("The selected database URL is not a valid URL.");
  }

  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname) {
    throw new Error("The selected database URL must be a PostgreSQL connection string.");
  }
  return `${parsed.host}${parsed.pathname}`;
}

function delegateName(modelName) {
  return `${modelName[0].toLowerCase()}${modelName.slice(1)}`;
}

/**
 * Prisma 7 no longer exports Prisma.dmmf, but every generated client carries
 * the same DMMF-derived runtime data model used to construct its delegates.
 * Driving the plan from it means a newly generated model cannot be omitted by
 * a stale, hand-maintained table list.
 */
export function buildModelPlan(runtimeDataModel) {
  const models = runtimeDataModel?.models;
  if (!models || typeof models !== "object" || Object.keys(models).length === 0) {
    throw new Error("The generated Prisma client exposed no runtime model metadata.");
  }

  const plan = Object.entries(models)
    .map(([model, metadata]) => ({
      model,
      delegate: delegateName(model),
      table: metadata.dbName ?? model,
    }))
    .sort((left, right) => left.model.localeCompare(right.model));

  const tableNames = new Set();
  for (const item of plan) {
    if (!item.model || !item.table) {
      throw new Error("Prisma model metadata contains an empty model or table name.");
    }
    if (tableNames.has(item.table)) {
      throw new Error(`Multiple Prisma models map to table ${JSON.stringify(item.table)}.`);
    }
    tableNames.add(item.table);
  }

  return plan;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function messageFrom(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the current database schema, not the generated client's field list.
 * This matters immediately before a migration: production may legitimately be
 * missing a newly-added model or column that is already present in the client.
 * Missing future models are recorded explicitly in the manifest; present
 * application tables must all map back to the DMMF or the snapshot aborts.
 */
export async function collectSnapshot(prisma, modelPlan) {
  return prisma.$transaction(
    async (tx) => {
      const catalogRows = await tx.$queryRawUnsafe(
        `SELECT tablename AS "tableName"
           FROM pg_catalog.pg_tables
          WHERE schemaname = current_schema()`,
      );
      const presentTables = new Set(catalogRows.map((row) => row.tableName));
      const plannedTables = new Set(modelPlan.map((item) => item.table));
      const unmappedTables = [...presentTables]
        .filter((table) => table !== "_prisma_migrations" && !plannedTables.has(table))
        .sort();

      if (unmappedTables.length > 0) {
        throw new Error(
          `Refusing an incomplete dump: database table(s) are absent from the Prisma DMMF: ${unmappedTables.join(
            ", ",
          )}. Regenerate/reconcile the client before retrying.`,
        );
      }

      const tables = {};
      const models = [];

      for (const item of modelPlan) {
        if (!presentTables.has(item.table)) {
          models.push({ ...item, status: "not-present", rowCount: null });
          continue;
        }

        let rows;
        try {
          rows = await tx.$queryRawUnsafe(`SELECT * FROM ${quoteIdentifier(item.table)}`);
        } catch (error) {
          throw new Error(
            `Failed to read Prisma model ${item.model} (table ${item.table}): ${messageFrom(error)}`,
            { cause: error },
          );
        }
        if (!Array.isArray(rows)) {
          throw new Error(`Reading Prisma model ${item.model} did not return a row array.`);
        }

        tables[item.model] = rows;
        models.push({ ...item, status: "dumped", rowCount: rows.length });
      }

      const missingModels = models
        .filter((item) => item.status === "not-present")
        .map((item) => item.model);

      return {
        manifest: {
          expectedModelCount: modelPlan.length,
          dumpedModelCount: modelPlan.length - missingModels.length,
          missingModels,
          models,
        },
        tables,
      };
    },
    {
      isolationLevel: "RepeatableRead",
      maxWait: 10_000,
      timeout: 300_000,
    },
  );
}

async function confirmDump({ input = stdin, output = stdout, target, yes }) {
  if (yes) return;
  if (!input.isTTY) {
    throw new Error(
      "Refusing to dump: stdin is not interactive, so the confirmation cannot be answered. " +
        "Re-run in a terminal, or pass --yes only after verifying the printed target.",
    );
  }

  const rl = createInterface({ input, output });
  const answer = await rl.question(`Type "dump ${target}" to continue: `);
  rl.close();
  if (answer.trim() !== `dump ${target}`) {
    throw new Error("Aborted; no database data was read and no file was written.");
  }
}

function writeDump({ dump, target }) {
  const stamp = new Date(dump.takenAt).toISOString().replace(/[:.]/g, "-");
  const outDir = join(process.cwd(), "backups");
  const file = join(outDir, `pre-migration-${target}-${stamp}.json`);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    file,
    `${JSON.stringify(dump, (_, value) => (typeof value === "bigint" ? value.toString() : value), 1)}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
  return file;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const targetConfig = TARGETS[options.target];
  const connectionString = env[targetConfig.envName];
  if (!connectionString) {
    throw new Error(
      `${targetConfig.envName} is not set. Configure the ${options.target} database connection before retrying.`,
    );
  }

  const targetDescription = describeTarget(connectionString);
  console.log(
    `About to create a full credential-bearing dump from ${targetConfig.label}: ${targetDescription}`,
  );
  console.warn(
    "The output includes password hashes, active sessions, OAuth tokens, 2FA material, and personal library data.\n" +
      "Keep it off shared storage and delete it securely when the migration/restore window closes.\n",
  );
  await confirmDump({ target: options.target, yes: options.yes });

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
  });

  let snapshot;
  try {
    const modelPlan = buildModelPlan(prisma._runtimeDataModel);
    snapshot = await collectSnapshot(prisma, modelPlan);
  } finally {
    await prisma.$disconnect();
  }

  const takenAt = new Date().toISOString();
  const dump = {
    format: "celluloid-prisma-dump",
    version: 1,
    takenAt,
    target: {
      environment: options.target,
      database: targetDescription,
    },
    ...snapshot,
  };
  const file = writeDump({ dump, target: options.target });

  const counts = Object.fromEntries(
    dump.manifest.models.map((item) => [
      item.model,
      item.status === "dumped" ? item.rowCount : "NOT PRESENT IN PRE-MIGRATION SCHEMA",
    ]),
  );
  console.log(JSON.stringify({ file, target: dump.target, counts }, null, 2));
  if (dump.manifest.missingModels.length > 0) {
    console.warn(
      `Snapshot completed with schema model(s) not yet present in this pre-migration database: ${dump.manifest.missingModels.join(
        ", ",
      )}. Their absence is recorded in the manifest.`,
    );
  }
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    loadEnv();
    await main();
  } catch (error) {
    console.error(`Database dump failed: ${messageFrom(error)}`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
/**
 * Ensure the NocoDB Incubators table has columns for source fields that
 * detail pages were missing (activity type, CAAI, ownership, service type,
 * activity page). Idempotent.
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_TABLE_ID  — default m3zt5vqlyja927x
 *
 * Usage:
 *   node scripts/ensure-incubators-schema.mjs
 *   node scripts/ensure-incubators-schema.mjs --dry-run
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOk, parsePositiveInt } from "./lib/http-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DEFAULT_TABLE_ID = "m3zt5vqlyja927x";

/** Columns to create when missing (matched by title). */
const DESIRED_COLUMNS = [
  {
    column_name: "inc_activity_type",
    title: "inc_activity_type",
    uidt: "SingleLineText",
  },
  { column_name: "inc_caai", title: "inc_caai", uidt: "SingleLineText" },
  {
    column_name: "inc_service_type",
    title: "inc_service_type",
    uidt: "SingleLineText",
  },
  { column_name: "inc_ownership", title: "inc_ownership", uidt: "LongText" },
  {
    column_name: "inc_activity_page",
    title: "inc_activity_page",
    uidt: "URL",
  },
  {
    column_name: "inc_cycle_label",
    title: "inc_cycle_label",
    uidt: "SingleLineText",
  },
];

function loadDotEnv() {
  const envPath = join(repoRoot, ".env");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Failed to read .env: ${error.message}`);
    }
  }
}

function parseArgs(argv) {
  const args = { dryRun: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/ensure-incubators-schema.mjs [--dry-run]

Creates missing Incubators columns:
  inc_activity_type, inc_caai, inc_service_type, inc_ownership, inc_activity_page
`);
}

async function getTableMeta({ baseUrl, tableId, token, timeoutMs }) {
  const response = await fetchOk(
    `${baseUrl}/api/v2/meta/tables/${tableId}`,
    { headers: { "xc-token": token } },
    { timeoutMs, label: `NocoDB meta ${tableId}` }
  );
  return response.json();
}

async function createColumn({ baseUrl, tableId, token, column, timeoutMs }) {
  const response = await fetchOk(
    `${baseUrl}/api/v2/meta/tables/${tableId}/columns`,
    {
      method: "POST",
      headers: {
        "xc-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(column),
    },
    { timeoutMs, label: `NocoDB create column ${column.title}` }
  );
  return response.json();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  loadDotEnv();
  const token = process.env.NOCODB_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing NOCODB_API_TOKEN. Create one at https://nocodb.nfdi.de/dashboard/#/account/tokens"
    );
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const tableId = process.env.NOCODB_TABLE_ID ?? DEFAULT_TABLE_ID;
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );

  const meta = await getTableMeta({ baseUrl, tableId, token, timeoutMs });
  const existing = new Set(
    (meta.columns ?? []).map((c) => String(c.title ?? "").trim())
  );

  console.log(`Table: ${meta.title} (${tableId})`);
  console.log(`Existing columns: ${existing.size}`);

  const missing = DESIRED_COLUMNS.filter((col) => !existing.has(col.title));
  const skipped = DESIRED_COLUMNS.filter((col) => existing.has(col.title));

  console.log(
    `Already present: ${skipped.map((c) => c.title).join(", ") || "(none)"}`
  );
  console.log(
    `To create: ${missing.map((c) => c.title).join(", ") || "(none)"}`
  );

  if (args.dryRun) {
    console.log("Dry-run — no columns created.");
    return;
  }

  let created = 0;
  for (const column of missing) {
    process.stdout.write(`Creating ${column.title}… `);
    await createColumn({ baseUrl, tableId, token, column, timeoutMs });
    console.log("ok");
    created += 1;
  }

  console.log(`Done. Created ${created} column(s).`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}

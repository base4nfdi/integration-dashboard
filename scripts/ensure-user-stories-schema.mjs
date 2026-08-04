#!/usr/bin/env node
/**
 * Ensure the NocoDB User_Stories table has columns aligned with Incubators
 * (plus a few use-case-specific fields). Idempotent: skips existing titles.
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_USER_STORIES_TABLE_ID  — default mtq40pxpo5p0jmx
 *
 * Usage:
 *   node scripts/ensure-user-stories-schema.mjs
 *   node scripts/ensure-user-stories-schema.mjs --dry-run
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOk, parsePositiveInt } from "./lib/http-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const DEFAULT_TABLE_ID = "mtq40pxpo5p0jmx";

/** Columns to create when missing (matched by title). */
const DESIRED_COLUMNS = [
  { column_name: "inc_name", title: "inc_name", uidt: "SingleLineText" },
  {
    column_name: "basic_service",
    title: "basic_service",
    uidt: "SingleSelect",
    dtxp: "'TS','IAM','Jupyter','DMP','KGI','RDMT','Accounting','PID'",
    colOptions: {
      options: [
        { title: "TS", color: "#cfdffe" },
        { title: "IAM", color: "#d0f1fd" },
        { title: "Jupyter", color: "#c2f5e8" },
        { title: "DMP", color: "#ffdaf6" },
        { title: "KGI", color: "#ffdce5" },
        { title: "RDMT", color: "#fee2d5" },
        { title: "Accounting", color: "#ffeab6" },
        { title: "PID", color: "#d1f7c4" },
      ],
    },
  },
  {
    column_name: "related_institutions",
    title: "related_institutions",
    uidt: "SingleLineText",
  },
  { column_name: "logo_project", title: "logo_project", uidt: "URL" },
  { column_name: "logo_consortia", title: "logo_consortia", uidt: "URL" },
  { column_name: "key_article", title: "key_article", uidt: "SingleLineText" },
  {
    column_name: "inc_start",
    title: "inc_start",
    uidt: "Date",
    meta: { date_format: "YYYY-MM-DD" },
  },
  {
    column_name: "inc_end",
    title: "inc_end",
    uidt: "Date",
    meta: { date_format: "YYYY-MM-DD" },
  },
  { column_name: "inc_cycle", title: "inc_cycle", uidt: "Number" },
  {
    column_name: "inc_status",
    title: "inc_status",
    uidt: "SingleSelect",
    dtxp: "'In preparation','Running','Finished'",
    colOptions: {
      options: [
        { title: "In preparation", color: "#96B5F2FF" },
        { title: "Running", color: "#FF8209FF" },
        { title: "Finished", color: "#8FEF49FF" },
      ],
    },
  },
  { column_name: "inc_descr", title: "inc_descr", uidt: "LongText" },
  { column_name: "inc_goals", title: "inc_goals", uidt: "LongText" },
  { column_name: "inc_results", title: "inc_results", uidt: "LongText" },
  // Text partners (no Links/Lookup setup yet; dashboard reads this as partners[])
  { column_name: "partners", title: "partners", uidt: "LongText" },
  // Use-case extras from PID4NFDI cards
  { column_name: "uc_labels", title: "uc_labels", uidt: "LongText" },
  { column_name: "pid_providers", title: "pid_providers", uidt: "SingleLineText" },
  {
    column_name: "research_field",
    title: "research_field",
    uidt: "SingleLineText",
  },
  {
    column_name: "resource_types",
    title: "resource_types",
    uidt: "SingleLineText",
  },
  { column_name: "source_url", title: "source_url", uidt: "URL" },
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
  node scripts/ensure-user-stories-schema.mjs [--dry-run]

Creates missing User_Stories columns aligned with the Incubators table.
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
  const tableId =
    process.env.NOCODB_USER_STORIES_TABLE_ID ?? DEFAULT_TABLE_ID;
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );

  const meta = await getTableMeta({ baseUrl, tableId, token, timeoutMs });
  const existing = new Set(
    (meta.columns ?? []).map((c) => String(c.title ?? "").trim())
  );

  const missing = DESIRED_COLUMNS.filter((col) => !existing.has(col.title));
  const skipped = DESIRED_COLUMNS.filter((col) => existing.has(col.title));

  console.log(`Table: ${meta.title} (${tableId})`);
  console.log(`Existing columns: ${existing.size}`);
  console.log(`Already present: ${skipped.map((c) => c.title).join(", ") || "(none)"}`);
  console.log(
    `To create: ${missing.map((c) => c.title).join(", ") || "(none)"}`
  );

  if (args.dryRun) {
    console.log("Dry-run — no columns created.");
    return;
  }

  for (const column of missing) {
    process.stdout.write(`Creating ${column.title}… `);
    await createColumn({ baseUrl, tableId, token, column, timeoutMs });
    console.log("ok");
  }

  console.log(`Done. Created ${missing.length} column(s).`);
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

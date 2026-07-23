#!/usr/bin/env node
/**
 * One-time / maintenance: fill empty NocoDB key_article values.
 *
 * Pattern: "{basic_service}-{inc_name}" lowercased/slugified
 *   e.g. TS + RADAR → ts-radar
 *
 * Existing non-empty key_article values are left unchanged.
 *
 * Usage:
 *   node scripts/fill-key-articles.mjs            # dry-run
 *   node scripts/fill-key-articles.mjs --apply    # PATCH NocoDB
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchNocoDbRecords,
  fetchOk,
  parsePositiveInt,
} from "./lib/http-utils.mjs";
import {
  buildKeyArticle,
  claimUniqueKeyArticle,
  repoRoot,
  writeJson,
} from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
    // optional
  }
}

function parseArgs(argv) {
  const args = { apply: false };
  for (const arg of argv) {
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

async function updateRecords({ baseUrl, tableId, token, records, timeoutMs }) {
  const url = `${baseUrl}/api/v2/tables/${tableId}/records`;
  const response = await fetchOk(
    url,
    {
      method: "PATCH",
      headers: {
        "xc-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    },
    { timeoutMs, label: `NocoDB update ${tableId}` }
  );
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`NocoDB update returned non-JSON: ${error.message}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/fill-key-articles.mjs [--apply]

Fills empty key_article cells as "{service}-{inc_name}" (lowercase slug).
Does not overwrite existing key_article values.
`);
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
    console.error("Missing NOCODB_API_TOKEN");
    process.exit(1);
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const tableId = process.env.NOCODB_TABLE_ID ?? "m3zt5vqlyja927x";
  const viewId = process.env.NOCODB_VIEW_ID ?? "vwiouc4g6dgp01qp";
  const pageSize = parsePositiveInt(
    process.env.NOCODB_PAGE_SIZE,
    100,
    "NOCODB_PAGE_SIZE"
  );
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );

  const rawRecords = await fetchNocoDbRecords({
    baseUrl,
    tableId,
    viewId,
    token,
    pageSize,
    timeoutMs,
  });

  const usedKeys = new Set(
    rawRecords
      .map((r) => String(r.key_article ?? "").trim())
      .filter(Boolean)
  );

  const updates = [];
  const skipped = [];

  for (const row of rawRecords) {
    const existing = String(row.key_article ?? "").trim();
    if (existing) {
      skipped.push({ id: row.id, reason: "already_set", key_article: existing });
      continue;
    }

    const baseKey = buildKeyArticle(row.basic_service, row.inc_name);
    if (!baseKey) {
      skipped.push({
        id: row.id,
        reason: "missing_service_or_name",
        basic_service: row.basic_service ?? "",
        inc_name: row.inc_name ?? "",
      });
      continue;
    }

    const key = claimUniqueKeyArticle(baseKey, usedKeys);
    updates.push({
      id: row.id,
      basic_service: row.basic_service ?? "",
      inc_name: row.inc_name ?? "",
      key_article: key,
    });
  }

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    planned_at: new Date().toISOString(),
    totals: {
      rows: rawRecords.length,
      to_fill: updates.length,
      skipped: skipped.length,
    },
    updates,
    skipped,
  };

  const reportPath = join(repoRoot, "data/parsed/fill-key-articles-report.json");
  writeJson(reportPath, report);

  console.log(
    `Rows=${rawRecords.length} fill=${updates.length} skipped=${skipped.length} mode=${report.mode}`
  );
  for (const u of updates.slice(0, 12)) {
    console.log(`  #${u.id}: ${u.key_article}`);
  }
  if (updates.length > 12) console.log(`  … +${updates.length - 12} more`);
  console.log(`Wrote ${reportPath}`);

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to update NocoDB.");
    return;
  }

  if (updates.length === 0) {
    console.log("\nNothing to update.");
    return;
  }

  const batchSize = 25;
  let updated = 0;
  for (let i = 0; i < updates.length; i += batchSize) {
    const batch = updates
      .slice(i, i + batchSize)
      .map((u) => ({ id: u.id, key_article: u.key_article }));
    await updateRecords({
      baseUrl,
      tableId,
      token,
      records: batch,
      timeoutMs,
    });
    updated += batch.length;
    console.log(`Updated batch ${i / batchSize + 1}: ${batch.length} row(s)`);
  }

  console.log(`\nDone. Filled key_article on ${updated} row(s).`);
  console.log("Tip: refresh local data with: node scripts/fetch-nocodb-data.mjs");
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

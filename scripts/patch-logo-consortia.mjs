#!/usr/bin/env node
/**
 * PATCH logo_consortia / logo_project on existing NocoDB incubator rows
 * from parsed sources.
 *
 * Matches parsed records (data/parsed/*.json) to NocoDB rows, then updates
 * logo fields where the source value is non-empty and differs.
 *
 * Required env (for live NocoDB / --apply):
 *   NOCODB_API_TOKEN  — xc-token from https://nocodb.nfdi.de/dashboard/#/account/tokens
 *
 * Optional env:
 *   NOCODB_BASE_URL, NOCODB_TABLE_ID, NOCODB_VIEW_ID, NOCODB_PAGE_SIZE, FETCH_TIMEOUT_MS
 *
 * Usage:
 *   node scripts/patch-logo-consortia.mjs                         # dry-run (live or .env)
 *   node scripts/patch-logo-consortia.mjs --local                 # dry-run vs static/data.json
 *   node scripts/patch-logo-consortia.mjs --service dmp4nfdi,ts4nfdi
 *   node scripts/patch-logo-consortia.mjs --only-host https://www.dmp4nfdi.de/
 *   node scripts/patch-logo-consortia.mjs --service ts4nfdi --apply
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
  loadNocoDbRecords,
  matchAgainstNocoDb,
  readJson,
  repoRoot,
  writeJson,
} from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LOGO_FIELDS = ["logo_consortia", "logo_project"];

const SOURCES = [
  {
    id: "dmp4nfdi",
    basic_service: "DMP",
    parsed: join(repoRoot, "data/parsed/dmp4nfdi.json"),
  },
  {
    id: "iam4nfdi",
    basic_service: "IAM",
    parsed: join(repoRoot, "data/parsed/iam4nfdi.json"),
    // One image per card: when it is classified as a project logo, any
    // logo_consortia in NocoDB is stale and must be cleared.
    clearsStaleConsortia: true,
  },
  {
    id: "ts4nfdi",
    basic_service: "TS",
    parsed: join(repoRoot, "data/parsed/ts4nfdi.json"),
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
  const args = {
    apply: false,
    local: false,
    limit: null,
    services: null,
    onlyHost: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--local") args.local = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
      if (!Number.isFinite(args.limit) || args.limit < 0) {
        throw new Error("--limit must be a non-negative number");
      }
    } else if (arg === "--service" || arg === "--services") {
      args.services = new Set(
        String(argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      );
    } else if (arg === "--only-host") {
      args.onlyHost = String(argv[++i] ?? "").trim();
      if (!args.onlyHost) {
        throw new Error("--only-host requires a URL prefix");
      }
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function asString(value) {
  if (value == null) return "";
  return String(value).trim();
}

function normalizeRecord(raw) {
  return {
    id: raw.id ?? null,
    inc_name: asString(raw.inc_name),
    basic_service: asString(raw.basic_service),
    logo_consortia: asString(raw.logo_consortia),
    logo_project: asString(raw.logo_project),
    key_article: asString(raw.key_article),
    inc_cycle: raw.inc_cycle ?? null,
    inc_status: asString(raw.inc_status),
    inc_descr: asString(raw.inc_descr),
    inc_goals: asString(raw.inc_goals),
    partners: Array.isArray(raw.partners)
      ? raw.partners.map(String)
      : Array.isArray(raw["name (from REF_Partners)"])
        ? raw["name (from REF_Partners)"].map(String)
        : [],
  };
}

/**
 * Decide whether a single logo field should be patched.
 * Empty NocoDB values are always eligible when source has a URL
 * (even with --only-host), so missing logos can be filled.
 */
function planFieldUpdate(field, next, prev, onlyHost) {
  if (!next) return { skip: "source_empty" };
  if (next === prev) return { skip: "unchanged" };
  // Only filter existing URLs by host; empty prev means "fill missing".
  if (onlyHost && prev && !prev.startsWith(onlyHost)) {
    return { skip: "host_mismatch" };
  }
  return { from: prev, to: next, field };
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
  node scripts/patch-logo-consortia.mjs [options]

Sync logo_consortia and logo_project from parsed source JSON onto matched
NocoDB rows. A logo_consortia that the source now reports as logo_project is
cleared (for IAM, any logo_consortia on a row whose card image is a project
logo is cleared). Default is dry-run; pass --apply to PATCH.

Options:
  --apply                 PATCH NocoDB (default is dry-run)
  --local                 Compare against static/data.json (no live fetch)
  --service <ids>         Comma-separated: dmp4nfdi,iam4nfdi,ts4nfdi
  --only-host <prefix>    Only rewrite existing logos whose URL starts with prefix
                          (empty NocoDB logos are still filled from source)
                          e.g. --only-host https://www.dmp4nfdi.de/
  --limit <n>             Cap number of row updates
  --help                  Show this help
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

  if (args.apply && !token) {
    throw new Error("NOCODB_API_TOKEN is required for --apply");
  }
  if (args.apply && args.local) {
    throw new Error("--local cannot be combined with --apply (need live row ids)");
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

  const sources = SOURCES.filter(
    (s) => !args.services || args.services.has(s.id)
  );
  if (sources.length === 0) {
    throw new Error("No matching --service values");
  }

  let nocoRecords;
  if (args.local || !token) {
    nocoRecords = loadNocoDbRecords().map(normalizeRecord);
    console.log(
      `Loaded ${nocoRecords.length} NocoDB row(s) from static/data.json` +
        (token ? "" : " (no API token)")
    );
  } else {
    const raw = await fetchNocoDbRecords({
      baseUrl,
      tableId,
      viewId,
      token,
      pageSize,
      timeoutMs,
    });
    nocoRecords = raw.map(normalizeRecord);
    console.log(`Fetched ${nocoRecords.length} NocoDB row(s) from ${baseUrl}`);
  }

  const planned = [];
  const skipped = [];
  let fieldUpdateCount = 0;

  for (const source of sources) {
    const parsed = readJson(source.parsed, {
      hint: "Run: node scripts/parse-source-pages.mjs",
    });
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const match = matchAgainstNocoDb(records, nocoRecords, source.basic_service);

    for (const { score, source: src, nocodb } of match.matches) {
      if (nocodb.id == null) {
        skipped.push({
          source: source.id,
          id: null,
          inc_name: nocodb.inc_name,
          reason: "missing_id",
        });
        continue;
      }

      const fields = {};
      const prevConsortia = asString(nocodb.logo_consortia);
      const srcProject = asString(src.logo_project);
      const staleConsortia =
        !asString(src.logo_consortia) &&
        prevConsortia !== "" &&
        srcProject !== "" &&
        (prevConsortia === srcProject || source.clearsStaleConsortia);
      if (staleConsortia) {
        fields.logo_consortia = { from: prevConsortia, to: "" };
      }
      for (const field of LOGO_FIELDS) {
        if (fields[field]) continue;
        const decision = planFieldUpdate(
          field,
          asString(src[field]),
          asString(nocodb[field]),
          args.onlyHost
        );
        if (decision.skip) {
          skipped.push({
            source: source.id,
            id: nocodb.id,
            inc_name: nocodb.inc_name,
            field,
            reason: decision.skip,
            ...(decision.skip === "host_mismatch"
              ? { [field]: asString(nocodb[field]) }
              : {}),
          });
          continue;
        }
        fields[field] = { from: decision.from, to: decision.to };
      }

      if (Object.keys(fields).length === 0) continue;

      fieldUpdateCount += Object.keys(fields).length;
      planned.push({
        source: source.id,
        score,
        id: nocodb.id,
        inc_name: nocodb.inc_name,
        key_article: nocodb.key_article,
        fields,
      });
    }

    for (const src of match.only_in_source) {
      skipped.push({
        source: source.id,
        id: null,
        inc_name: src.inc_name,
        reason: "unmatched_source",
      });
    }
  }

  const limited =
    args.limit == null ? planned : planned.slice(0, args.limit);
  const limitedFieldCount = limited.reduce(
    (n, row) => n + Object.keys(row.fields).length,
    0
  );

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    compared_against: args.local || !token ? "static/data.json" : "live-nocodb",
    only_host: args.onlyHost,
    logo_fields: LOGO_FIELDS,
    planned_at: new Date().toISOString(),
    totals: {
      to_patch_rows: planned.length,
      will_patch_rows: limited.length,
      to_patch_fields: fieldUpdateCount,
      will_patch_fields: limitedFieldCount,
      skipped: skipped.length,
    },
    by_source: Object.fromEntries(
      sources.map((s) => [
        s.id,
        {
          to_patch_rows: planned.filter((p) => p.source === s.id).length,
          will_patch_rows: limited.filter((p) => p.source === s.id).length,
        },
      ])
    ),
    updates: limited,
    skipped,
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/patch-logo-consortia-report.json"
  );
  writeJson(reportPath, report);

  console.log(
    `rows=${limited.length}/${planned.length} ` +
      `fields=${limitedFieldCount}/${fieldUpdateCount} ` +
      `skipped=${skipped.length} mode=${report.mode}`
  );
  for (const u of limited.slice(0, 15)) {
    console.log(`  #${u.id} ${u.inc_name}`);
    for (const [field, change] of Object.entries(u.fields)) {
      console.log(`    ${field}:`);
      console.log(`      - ${change.from || "(empty)"}`);
      console.log(`      + ${change.to || "(cleared)"}`);
    }
  }
  if (limited.length > 15) {
    console.log(`  … +${limited.length - 15} more row(s)`);
  }
  console.log(`Wrote ${reportPath}`);

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to PATCH NocoDB.");
    return;
  }

  if (limited.length === 0) {
    console.log("\nNothing to update.");
    return;
  }

  const batchSize = 25;
  let updated = 0;
  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize).map((u) => {
      const payload = { id: u.id };
      for (const [field, change] of Object.entries(u.fields)) {
        payload[field] = change.to;
      }
      return payload;
    });
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

  console.log(
    `\nDone. Patched logos on ${updated} row(s) (${limitedFieldCount} field(s)).`
  );
  console.log("Tip: refresh local data with:");
  console.log("  node scripts/fetch-nocodb-data.mjs");
  console.log("  node scripts/generate-incubator-pages.mjs --force");
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

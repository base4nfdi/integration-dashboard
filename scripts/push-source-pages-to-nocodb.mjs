#!/usr/bin/env node
/**
 * Push incubator records that exist in parsed source pages but not yet in
 * NocoDB into the incubators table.
 *
 * Reads:
 *   data/parsed/{dmp4nfdi,iam4nfdi,ts4nfdi}.json
 *
 * Required env:
 *   NOCODB_API_TOKEN  — xc-token from https://nocodb.nfdi.de/dashboard/#/account/tokens
 *
 * Optional env:
 *   NOCODB_BASE_URL, NOCODB_TABLE_ID, NOCODB_VIEW_ID, NOCODB_PAGE_SIZE
 *   NOCODB_PARTNERS_TABLE_ID  — default pf8ggs9jduxse4x (REF_Partners)
 *
 * Usage:
 *   node scripts/push-source-pages-to-nocodb.mjs            # dry-run
 *   node scripts/push-source-pages-to-nocodb.mjs --apply    # create rows
 *   node scripts/push-source-pages-to-nocodb.mjs --service dmp4nfdi,ts4nfdi
 *   node scripts/push-source-pages-to-nocodb.mjs --limit 5 --apply
 *   node scripts/push-source-pages-to-nocodb.mjs --local    # compare vs static/data.json
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
  loadNocoDbRecords,
  matchAgainstNocoDb,
  normalizePartnerName,
  readJson,
  repoRoot,
  writeJson,
} from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PARTNERS_FIELD = "name (from REF_Partners)";
const ENTITIES_FIELD = "name (from REF_Entities)";

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
  },
  {
    id: "ts4nfdi",
    basic_service: "TS",
    parsed: join(repoRoot, "data/parsed/ts4nfdi.json"),
  },
];

/** Scalar / select fields we can write on create. Linked lookups are omitted. */
const WRITE_FIELDS = [
  "inc_name",
  "basic_service",
  "related_institutions",
  "logo_project",
  "logo_consortia",
  "key_article",
  "inc_start",
  "inc_end",
  "inc_cycle",
  "inc_cycle_label",
  "inc_status",
  "inc_descr",
  "inc_goals",
  "inc_results",
  "inc_activity_type",
  "inc_caai",
  "inc_ownership",
  "inc_service_type",
  "inc_activity_page",
];

const VALID_STATUSES = new Set(["In preparation", "Running", "Finished"]);
const VALID_SERVICES = new Set([
  "TS",
  "IAM",
  "Jupyter",
  "DMP",
  "KGI",
  "RDMT",
  "Accounting",
  "PID",
]);

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
    // .env is optional when vars are exported in the shell/CI
  }
}

function parseArgs(argv) {
  const args = {
    apply: false,
    local: false,
    limit: null,
    services: null,
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
  return String(value);
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item == null ? "" : String(item).replace(/\r/g, "").trim()))
    .filter(Boolean);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeRecord(raw) {
  return {
    id: raw.id ?? null,
    inc_name: asString(raw.inc_name),
    basic_service: asString(raw.basic_service),
    related_institutions: asString(raw.related_institutions),
    logo_project: asString(raw.logo_project),
    logo_consortia: asString(raw.logo_consortia),
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_status: asString(raw.inc_status),
    inc_descr: asString(raw.inc_descr),
    inc_goals: asString(raw.inc_goals),
    inc_results: asString(raw.inc_results),
    inc_partner_publications: asNumber(raw.inc_partner_publications) ?? 0,
    linked_partners: asNumber(raw.linked_partners),
    linked_entities: asNumber(raw.linked_entities),
    partners: asStringList(raw[PARTNERS_FIELD]),
    entities: asStringList(raw[ENTITIES_FIELD]),
  };
}

function partnerLookupKeys(name) {
  const raw = String(name ?? "")
    .replace(/\r/g, "")
    .trim();
  if (!raw) return [];

  const keys = new Set();
  const add = (value) => {
    const v = String(value ?? "")
      .replace(/\r/g, "")
      .trim()
      .toLowerCase();
    if (v) keys.add(v);
  };

  add(raw);
  add(normalizePartnerName(raw));

  const compact = raw.toLowerCase().replace(/[^a-z0-9@+]/g, "");
  if (compact) keys.add(compact);

  if (/^nfdi[- ]?/i.test(raw)) {
    add(raw.replace(/^nfdi[- ]?/i, ""));
  } else {
    add(`NFDI-${raw}`);
    add(`NFDI${raw}`);
  }

  return [...keys];
}

function buildPartnerIdIndex(partnerRows) {
  const byKey = new Map();
  for (const row of partnerRows) {
    const id = row.id;
    if (id == null) continue;
    for (const key of partnerLookupKeys(row.name)) {
      if (!byKey.has(key)) byKey.set(key, id);
    }
  }
  return byKey;
}

function resolvePartnerIds(partnerNames, partnerIndex) {
  const ids = [];
  const unresolved = [];

  for (const name of partnerNames ?? []) {
    let found = null;
    for (const key of partnerLookupKeys(name)) {
      if (partnerIndex.has(key)) {
        found = partnerIndex.get(key);
        break;
      }
    }
    if (found == null) unresolved.push(name);
    else if (!ids.includes(found)) ids.push(found);
  }

  return { ids, unresolved };
}

function emptyToNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

/**
 * Map a parsed source record to a NocoDB create payload.
 * Missing / empty cells become null (left empty in NocoDB).
 * key_article is auto-generated when absent.
 * Linked entities / publications are left unset.
 */
function toCreatePayload(record, partnerIndex, usedKeyArticles) {
  const payload = {};

  for (const field of WRITE_FIELDS) {
    let value = record[field];

    if (field === "inc_status") {
      value = asString(value).trim();
      if (value && !VALID_STATUSES.has(value)) value = null;
      payload[field] = emptyToNull(value);
      continue;
    }

    if (field === "basic_service") {
      value = asString(value).trim();
      if (value && !VALID_SERVICES.has(value)) value = null;
      payload[field] = emptyToNull(value);
      continue;
    }

    if (field === "inc_cycle") {
      payload[field] =
        value == null || value === "" ? null : asNumber(value);
      continue;
    }

    if (field === "key_article") {
      continue;
    }

    payload[field] = emptyToNull(asString(value));
  }

  const baseKey =
    asString(record.key_article).trim() ||
    buildKeyArticle(record.basic_service, record.inc_name);
  payload.key_article = emptyToNull(
    claimUniqueKeyArticle(baseKey, usedKeyArticles)
  );

  const { ids, unresolved } = resolvePartnerIds(
    record.partners ?? [],
    partnerIndex
  );
  if (ids.length > 0) {
    // Links (mm) field — NocoDB accepts an array of related record ids.
    payload.linked_partners = ids;
  }

  return { payload, unresolvedPartners: unresolved };
}

async function createRecords({ baseUrl, tableId, token, records, timeoutMs }) {
  const url = `${baseUrl}/api/v2/tables/${tableId}/records`;
  const response = await fetchOk(
    url,
    {
      method: "POST",
      headers: {
        "xc-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(records),
    },
    { timeoutMs, label: `NocoDB create ${tableId}` }
  );

  try {
    return await response.json();
  } catch (error) {
    throw new Error(`NocoDB create returned non-JSON: ${error.message}`);
  }
}

function printHelp() {
  console.log(`Usage:
  node scripts/push-source-pages-to-nocodb.mjs [options]

Options:
  --apply              Actually create rows (default is dry-run)
  --dry-run            Preview only (default)
  --local              Compare against static/data.json instead of live NocoDB
  --service <ids>      Comma-separated source ids (dmp4nfdi,iam4nfdi,ts4nfdi)
  --limit <n>          Max records to push (after filtering)
  -h, --help           Show this help
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
  if (!token && !args.local) {
    console.error(
      "Missing NOCODB_API_TOKEN. Create one at https://nocodb.nfdi.de/dashboard/#/account/tokens"
    );
    process.exit(1);
  }
  if (args.apply && !token) {
    console.error("NOCODB_API_TOKEN is required for --apply");
    process.exit(1);
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const tableId = process.env.NOCODB_TABLE_ID ?? "m3zt5vqlyja927x";
  const viewId = process.env.NOCODB_VIEW_ID ?? "vwiouc4g6dgp01qp";
  const partnersTableId =
    process.env.NOCODB_PARTNERS_TABLE_ID ?? "pf8ggs9jduxse4x";
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
    nocoRecords = loadNocoDbRecords();
    console.log(`Loaded ${nocoRecords.length} NocoDB row(s) from static/data.json`);
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

  let partnerIndex = new Map();
  if (token) {
    const partnerRows = await fetchNocoDbRecords({
      baseUrl,
      tableId: partnersTableId,
      viewId: "",
      token,
      pageSize,
      timeoutMs,
    });
    partnerIndex = buildPartnerIdIndex(partnerRows);
    console.log(
      `Loaded ${partnerRows.length} partner(s) for linked_partners resolution`
    );
  } else {
    console.log(
      "No API token — partner links will be omitted (scalar fields only)"
    );
  }

  const planned = [];
  const skippedMatched = [];
  const usedKeyArticles = new Set(
    nocoRecords
      .map((r) => asString(r.key_article).trim())
      .filter(Boolean)
  );

  for (const source of sources) {
    const parsed = readJson(source.parsed, {
      hint: "Run: node scripts/parse-source-pages.mjs",
    });
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const match = matchAgainstNocoDb(records, nocoRecords, source.basic_service);

    skippedMatched.push({
      source: source.id,
      basic_service: source.basic_service,
      matched: match.matches.length,
    });

    for (const record of match.only_in_source) {
      const { payload, unresolvedPartners } = toCreatePayload(
        record,
        partnerIndex,
        usedKeyArticles
      );
      planned.push({
        source: source.id,
        basic_service: source.basic_service,
        inc_name: record.inc_name,
        partners: record.partners ?? [],
        unresolved_partners: unresolvedPartners,
        payload,
      });
    }
  }

  const limited =
    args.limit == null ? planned : planned.slice(0, args.limit);

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    compared_against: args.local || !token ? "static/data.json" : "live-nocodb",
    planned_at: new Date().toISOString(),
    totals: {
      missing_from_nocodb: planned.length,
      will_push: limited.length,
      skipped_already_matched: skippedMatched.reduce(
        (n, s) => n + s.matched,
        0
      ),
    },
    by_source: Object.fromEntries(
      sources.map((s) => [
        s.id,
        {
          missing: planned.filter((p) => p.source === s.id).length,
          pushing: limited.filter((p) => p.source === s.id).length,
          already_matched:
            skippedMatched.find((m) => m.source === s.id)?.matched ?? 0,
        },
      ])
    ),
    records: limited.map((item) => ({
      source: item.source,
      inc_name: item.inc_name,
      unresolved_partners: item.unresolved_partners,
      payload: item.payload,
    })),
  };

  const reportPath = join(repoRoot, "data/parsed/push-report.json");
  writeJson(reportPath, report);

  console.log("\n=== Push plan ===");
  for (const [id, counts] of Object.entries(report.by_source)) {
    console.log(
      `${id}: missing=${counts.missing} pushing=${counts.pushing} ` +
        `already_matched=${counts.already_matched}`
    );
  }
  console.log(
    `\nTotal missing=${report.totals.missing_from_nocodb} ` +
      `pushing=${report.totals.will_push} mode=${report.mode}`
  );
  console.log(`Wrote plan to ${reportPath}`);

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to create rows in NocoDB.");
    return;
  }

  if (limited.length === 0) {
    console.log("\nNothing to push.");
    return;
  }

  // Create in modest batches to avoid oversized requests.
  const batchSize = 25;
  let created = 0;
  for (let i = 0; i < limited.length; i += batchSize) {
    const batch = limited.slice(i, i + batchSize).map((item) => item.payload);
    const result = await createRecords({
      baseUrl,
      tableId,
      token,
      records: batch,
      timeoutMs,
    });
    const count = Array.isArray(result) ? result.length : batch.length;
    created += count;
    console.log(`Created batch ${i / batchSize + 1}: ${count} row(s)`);
  }

  console.log(`\nDone. Created ${created} row(s) in NocoDB table ${tableId}.`);
  console.log(
    "Tip: refresh local data with: node scripts/fetch-nocodb-data.mjs"
  );
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

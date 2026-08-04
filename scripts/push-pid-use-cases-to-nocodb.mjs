#!/usr/bin/env node
/**
 * Push PID4NFDI use cases from data/parsed/pid4nfdi.json into the NocoDB
 * User_Stories table. Default mode is dry-run; use --apply to insert.
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_USER_STORIES_TABLE_ID  — default mtq40pxpo5p0jmx
 *   NOCODB_USER_STORIES_VIEW_ID  — default empty (full table)
 *
 * Usage:
 *   node scripts/push-pid-use-cases-to-nocodb.mjs
 *   node scripts/push-pid-use-cases-to-nocodb.mjs --apply
 *   node scripts/push-pid-use-cases-to-nocodb.mjs --local
 *   node scripts/push-pid-use-cases-to-nocodb.mjs --limit 3 --apply
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
  readJson,
  repoRoot,
  splitPartners,
  writeJson,
} from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TABLE_ID = "mtq40pxpo5p0jmx";
const PARSED_PATH = join(repoRoot, "data/parsed/pid4nfdi.json");
const BASIC_SERVICE = "PID";

const WRITE_FIELDS = [
  "title",
  "inc_name",
  "basic_service",
  "related_institutions",
  "logo_project",
  "logo_consortia",
  "key_article",
  "inc_start",
  "inc_end",
  "inc_cycle",
  "inc_status",
  "inc_descr",
  "inc_goals",
  "inc_results",
  "partners",
  "uc_labels",
  "pid_providers",
  "research_field",
  "resource_types",
  "source_url",
];

const VALID_STATUSES = new Set(["In preparation", "Running", "Finished"]);

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
  const args = { apply: false, local: false, limit: null, help: false };
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
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/push-pid-use-cases-to-nocodb.mjs [options]

Options:
  --apply      Create rows in User_Stories (default is dry-run)
  --dry-run    Preview only (default)
  --local      Compare against static/data.json instead of live NocoDB
  --limit <n>  Cap how many records are pushed
  -h, --help   Show this help
`);
}

function asString(value) {
  if (value == null) return "";
  return String(value);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function emptyToNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function normalizeUserStoryRecord(raw) {
  const partnersRaw = raw.partners;
  const partners = Array.isArray(partnersRaw)
    ? partnersRaw.map((p) => asString(p).trim()).filter(Boolean)
    : splitPartners(partnersRaw);

  return {
    id: raw.id ?? null,
    inc_name: asString(raw.inc_name || raw.title),
    basic_service: asString(raw.basic_service) || BASIC_SERVICE,
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
    partners,
    source_url: asString(raw.source_url),
    uc_labels: asString(raw.uc_labels),
    pid_providers: asString(raw.pid_providers),
    research_field: asString(raw.research_field),
    resource_types: asString(raw.resource_types),
    integration_kind: "use-case",
  };
}

function toCreatePayload(record, usedKeyArticles) {
  const payload = {};
  const name = asString(record.inc_name).trim();

  for (const field of WRITE_FIELDS) {
    if (field === "title") {
      payload.title = emptyToNull(name);
      continue;
    }
    if (field === "key_article") continue;

    if (field === "inc_status") {
      const value = asString(record[field]).trim();
      payload[field] =
        value && VALID_STATUSES.has(value) ? value : null;
      continue;
    }

    if (field === "basic_service") {
      payload[field] = BASIC_SERVICE;
      continue;
    }

    if (field === "inc_cycle") {
      payload[field] =
        record.inc_cycle == null || record.inc_cycle === ""
          ? null
          : asNumber(record.inc_cycle);
      continue;
    }

    if (field === "partners") {
      const list = Array.isArray(record.partners) ? record.partners : [];
      payload.partners = emptyToNull(list.join(", "));
      continue;
    }

    payload[field] = emptyToNull(asString(record[field]));
  }

  const baseKey =
    asString(record.key_article).trim() ||
    buildKeyArticle(BASIC_SERVICE, name);
  payload.key_article = emptyToNull(
    claimUniqueKeyArticle(baseKey, usedKeyArticles)
  );

  return payload;
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  loadDotEnv();
  const token = process.env.NOCODB_API_TOKEN;
  if (!token && !args.local) {
    throw new Error(
      "Missing NOCODB_API_TOKEN. Create one at https://nocodb.nfdi.de/dashboard/#/account/tokens"
    );
  }
  if (args.apply && !token) {
    throw new Error("NOCODB_API_TOKEN is required for --apply");
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const tableId =
    process.env.NOCODB_USER_STORIES_TABLE_ID ?? DEFAULT_TABLE_ID;
  const viewId = (process.env.NOCODB_USER_STORIES_VIEW_ID ?? "").trim();
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

  const parsed = readJson(PARSED_PATH, {
    hint: "Run: node scripts/parse-pid4nfdi.mjs",
  });
  const sourceRecords = Array.isArray(parsed.records) ? parsed.records : [];

  let nocoRecords;
  if (args.local || !token) {
    nocoRecords = loadNocoDbRecords().filter(
      (r) =>
        String(r.basic_service).toUpperCase() === BASIC_SERVICE ||
        r.integration_kind === "use-case"
    );
    console.log(
      `Loaded ${nocoRecords.length} PID/use-case row(s) from static/data.json`
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
    nocoRecords = raw.map(normalizeUserStoryRecord);
    console.log(
      `Fetched ${nocoRecords.length} User_Stories row(s) from ${baseUrl}`
    );
  }

  const match = matchAgainstNocoDb(sourceRecords, nocoRecords, BASIC_SERVICE);
  const usedKeyArticles = new Set(
    nocoRecords
      .map((r) => asString(r.key_article).trim())
      .filter(Boolean)
  );

  const planned = match.only_in_source.map((record) => {
    const payload = toCreatePayload(record, usedKeyArticles);
    return {
      inc_name: record.inc_name,
      partners: record.partners ?? [],
      payload,
    };
  });

  const limited =
    args.limit == null ? planned : planned.slice(0, args.limit);

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    table_id: tableId,
    compared_against: args.local || !token ? "static/data.json" : "live-nocodb",
    planned_at: new Date().toISOString(),
    totals: {
      source: sourceRecords.length,
      nocodb: nocoRecords.length,
      matched: match.matches.length,
      missing_from_nocodb: planned.length,
      will_push: limited.length,
    },
    records: limited,
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/pid4nfdi.push-report.json"
  );
  writeJson(reportPath, report);

  console.log(
    `\n${report.mode}: ${limited.length}/${planned.length} missing use case(s) to push`
  );
  for (const item of limited) {
    console.log(`  + ${item.inc_name} → ${item.payload.key_article}`);
  }
  console.log(`Wrote ${reportPath}`);

  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to create rows.");
    return;
  }

  if (limited.length === 0) {
    console.log("Nothing to create.");
    return;
  }

  const created = await createRecords({
    baseUrl,
    tableId,
    token,
    records: limited.map((item) => item.payload),
    timeoutMs,
  });
  const createdCount = Array.isArray(created)
    ? created.length
    : Array.isArray(created?.list)
      ? created.list.length
      : limited.length;
  console.log(`Created ${createdCount} User_Stories row(s).`);
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

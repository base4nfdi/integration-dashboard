#!/usr/bin/env node
/**
 * Push PID4NFDI use cases from data/parsed/pid4nfdi.json into the NocoDB
 * User_Stories table. Default mode is dry-run; use --apply to insert/update.
 *
 * Writes use-case columns: uc_name, uc_descr, key_article, basic_service, …
 * Also backfills those fields on matched existing rows when empty.
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
  "uc_name",
  "uc_descr",
  "basic_service",
  "related_institutions",
  "logo_project",
  "logo_consortia",
  "key_article",
  "inc_start",
  "inc_end",
  "inc_cycle",
  "inc_status",
  "inc_name",
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

/** Fields backfilled onto matched rows when blank in NocoDB. */
const BACKFILL_FIELDS = [
  "uc_name",
  "uc_descr",
  "basic_service",
  "key_article",
  "inc_name",
  "inc_descr",
  "inc_goals",
  "inc_results",
  "related_institutions",
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
  --apply      Create/update rows in User_Stories (default is dry-run)
  --dry-run    Preview only (default)
  --local      Compare against static/data.json instead of live NocoDB
  --limit <n>  Cap how many create payloads are pushed
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

function useCaseName(raw) {
  return asString(raw.uc_name || raw.inc_name || raw.title).trim();
}

function useCaseDescr(raw) {
  return asString(raw.uc_descr || raw.inc_descr);
}

function normalizeUserStoryRecord(raw) {
  const partnersRaw = raw.partners;
  const partners = Array.isArray(partnersRaw)
    ? partnersRaw.map((p) => asString(p).trim()).filter(Boolean)
    : splitPartners(partnersRaw);
  const name = useCaseName(raw);
  const descr = useCaseDescr(raw);

  return {
    id: raw.id ?? null,
    uc_name: name,
    uc_descr: descr,
    inc_name: name,
    basic_service: asString(raw.basic_service) || BASIC_SERVICE,
    related_institutions: asString(raw.related_institutions),
    logo_project: asString(raw.logo_project),
    logo_consortia: asString(raw.logo_consortia),
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_status: asString(raw.inc_status),
    inc_descr: descr,
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
  const name = useCaseName(record);
  const descr = useCaseDescr(record);

  for (const field of WRITE_FIELDS) {
    if (field === "key_article") continue;

    if (field === "uc_name" || field === "inc_name") {
      payload[field] = emptyToNull(name);
      continue;
    }

    if (field === "uc_descr" || field === "inc_descr") {
      payload[field] = emptyToNull(descr);
      continue;
    }

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

/**
 * Build a PATCH for blank use-case fields on an existing row.
 * `rawNocoRecord` should be the unnormalized NocoDB row so we can detect
 * truly missing columns (e.g. uc_descr before backfill, title before rename).
 */
function buildBackfillPatch(sourceRecord, rawNocoRecord, usedKeyArticles) {
  const patch = {};
  const name = useCaseName(sourceRecord);
  const descr = useCaseDescr(sourceRecord);
  const createShape = toCreatePayload(sourceRecord, usedKeyArticles);

  const rawHas = (field) => asString(rawNocoRecord[field]).trim() !== "";

  for (const field of BACKFILL_FIELDS) {
    if (field === "uc_name") {
      // Prefer existing uc_name; also treat legacy title as already filled
      // (ensure-user-stories-schema renames title → uc_name).
      if (rawHas("uc_name") || rawHas("title")) continue;
      if (name) patch.uc_name = name;
      continue;
    }
    if (field === "inc_name") {
      if (rawHas("inc_name")) continue;
      if (name) patch.inc_name = name;
      continue;
    }
    if (field === "uc_descr") {
      if (rawHas("uc_descr")) continue;
      if (descr) patch.uc_descr = descr;
      continue;
    }
    if (field === "inc_descr") {
      if (rawHas("inc_descr")) continue;
      if (descr) patch.inc_descr = descr;
      continue;
    }
    if (field === "basic_service") {
      if (rawHas("basic_service")) continue;
      patch.basic_service = BASIC_SERVICE;
      continue;
    }
    if (field === "key_article") {
      if (rawHas("key_article")) continue;
      if (createShape.key_article) patch.key_article = createShape.key_article;
      continue;
    }
    if (field === "partners") {
      if (rawHas("partners")) continue;
      const list = Array.isArray(sourceRecord.partners)
        ? sourceRecord.partners
        : [];
      const value = list.join(", ");
      if (value) patch.partners = value;
      continue;
    }
    if (rawHas(field)) continue;
    const value = asString(sourceRecord[field]).trim();
    if (value) patch[field] = value;
  }

  if (Object.keys(patch).length === 0) return null;
  return { id: rawNocoRecord.id, ...patch };
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

  /** @type {Map<string|number, object>} raw NocoDB rows by id (for backfill checks) */
  const rawById = new Map();
  let nocoRecords;
  if (args.local || !token) {
    nocoRecords = loadNocoDbRecords().filter(
      (r) =>
        String(r.basic_service).toUpperCase() === BASIC_SERVICE ||
        r.integration_kind === "use-case"
    );
    for (const r of nocoRecords) {
      if (r.id != null) rawById.set(r.id, r);
    }
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
    for (const r of raw) {
      if (r.id != null) rawById.set(r.id, r);
    }
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

  const plannedCreates = match.only_in_source.map((record) => {
    const payload = toCreatePayload(record, usedKeyArticles);
    return {
      uc_name: useCaseName(record),
      partners: record.partners ?? [],
      payload,
    };
  });

  const plannedUpdates = [];
  for (const { source, nocodb } of match.matches) {
    if (nocodb.id == null) continue;
    // Check blank fields on the raw row so aliases (title→uc_name, inc_descr→uc_descr)
    // do not hide missing columns that still need backfill.
    const rawRow = rawById.get(nocodb.id) ?? nocodb;
    const patch = buildBackfillPatch(source, rawRow, usedKeyArticles);
    if (!patch) continue;
    plannedUpdates.push({
      uc_name: useCaseName(source),
      id: nocodb.id,
      patch,
    });
  }

  const limitedCreates =
    args.limit == null ? plannedCreates : plannedCreates.slice(0, args.limit);

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    table_id: tableId,
    compared_against: args.local || !token ? "static/data.json" : "live-nocodb",
    planned_at: new Date().toISOString(),
    totals: {
      source: sourceRecords.length,
      nocodb: nocoRecords.length,
      matched: match.matches.length,
      missing_from_nocodb: plannedCreates.length,
      will_create: limitedCreates.length,
      will_update: plannedUpdates.length,
    },
    creates: limitedCreates,
    updates: plannedUpdates,
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/pid4nfdi.push-report.json"
  );
  writeJson(reportPath, report);

  console.log(
    `\n${report.mode}: ${limitedCreates.length}/${plannedCreates.length} create(s), ` +
      `${plannedUpdates.length} update(s)`
  );
  for (const item of limitedCreates) {
    console.log(`  + ${item.uc_name} → ${item.payload.key_article}`);
  }
  for (const item of plannedUpdates) {
    const fields = Object.keys(item.patch).filter((k) => k !== "id");
    console.log(`  ~ ${item.uc_name} (id ${item.id}) ← ${fields.join(", ")}`);
  }
  console.log(`Wrote ${reportPath}`);

  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to create/update rows.");
    return;
  }

  if (limitedCreates.length === 0 && plannedUpdates.length === 0) {
    console.log("Nothing to create or update.");
    return;
  }

  if (limitedCreates.length > 0) {
    const created = await createRecords({
      baseUrl,
      tableId,
      token,
      records: limitedCreates.map((item) => item.payload),
      timeoutMs,
    });
    const createdCount = Array.isArray(created)
      ? created.length
      : Array.isArray(created?.list)
        ? created.list.length
        : limitedCreates.length;
    console.log(`Created ${createdCount} User_Stories row(s).`);
  }

  if (plannedUpdates.length > 0) {
    const updated = await updateRecords({
      baseUrl,
      tableId,
      token,
      records: plannedUpdates.map((item) => item.patch),
      timeoutMs,
    });
    const updatedCount = Array.isArray(updated)
      ? updated.length
      : Array.isArray(updated?.list)
        ? updated.list.length
        : plannedUpdates.length;
    console.log(`Updated ${updatedCount} User_Stories row(s).`);
  }
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

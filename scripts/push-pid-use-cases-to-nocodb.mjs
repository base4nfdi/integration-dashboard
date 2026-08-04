#!/usr/bin/env node
/**
 * Push PID4NFDI use cases from data/parsed/pid4nfdi.json into the NocoDB
 * User_Stories table. Default mode is dry-run; use --apply to insert/update.
 *
 * Writes use-case columns: uc_name, uc_descr, key_article, basic_service, …
 * Also backfills those fields on matched existing rows when empty.
 *
 * Organizations from the PID cards are linked into Institutions
 * (`linked_entities` → REF_Entities). Unresolved names stay in
 * `related_institutions` (Further Institutions).
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_USER_STORIES_TABLE_ID  — default mtq40pxpo5p0jmx
 *   NOCODB_USER_STORIES_VIEW_ID  — default empty (full table)
 *   NOCODB_REF_ENTITIES_TABLE_ID — default 7v80fm7p5jpa7xj
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
const DEFAULT_ENTITIES_TABLE_ID = "7v80fm7p5jpa7xj";
const PARSED_PATH = join(repoRoot, "data/parsed/pid4nfdi.json");
const BASIC_SERVICE = "PID";

const WRITE_FIELDS = [
  "uc_name",
  "uc_descr",
  "basic_service",
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
  "partners",
  "uc_labels",
  "pid_providers",
  "research_field",
  "resource_types",
  "source_url",
];

const VALID_STATUSES = new Set(["In preparation", "Running", "Finished"]);

/** Map PID card organization labels onto REF_Entities.name values. */
const ENTITY_ALIASES = {
  fzj: "Forschungszentrum Jülich",
  gesis: "GESIS – Leibniz Institute for the Social Sciences",
  "humboldt-universität zu berlin": "Humbold University Berlin",
  "humboldt-universitat zu berlin": "Humbold University Berlin",
  "humboldt university berlin": "Humbold University Berlin",
  "humboldt-universität zu berlin (nomad repository operator)":
    "Humbold University Berlin",
  "humboldt-universitat zu berlin (nomad repository operator)":
    "Humbold University Berlin",
};

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

function stripParenNote(name) {
  return String(name ?? "")
    .replace(/\s*\([^)]*\)\s*$/u, "")
    .trim();
}

function entityLookupKeys(name) {
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
  add(stripParenNote(raw));

  const alias =
    ENTITY_ALIASES[raw.toLowerCase()] ||
    ENTITY_ALIASES[stripParenNote(raw).toLowerCase()];
  if (alias) add(alias);

  const compact = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]/g, "");
  if (compact) keys.add(compact);

  return [...keys];
}

function buildEntityIdIndex(entityRows) {
  const byKey = new Map();
  for (const row of entityRows) {
    const id = row.id;
    if (id == null) continue;
    for (const key of entityLookupKeys(row.name)) {
      if (!byKey.has(key)) byKey.set(key, id);
    }
    // Leading acronym / short label before en-dash or parenthesis (e.g. GESIS – …)
    const lead = String(row.name ?? "").match(
      /^([A-Za-z0-9]+)(?:\s*[–\-—(]|$)/u
    );
    if (lead?.[1] && lead[1].length >= 2) {
      const k = lead[1].toLowerCase();
      if (!byKey.has(k)) byKey.set(k, id);
    }
  }
  return byKey;
}

function resolveEntityIds(entityNames, entityIndex) {
  const ids = [];
  const unresolved = [];

  for (const name of entityNames ?? []) {
    let found = null;
    for (const key of entityLookupKeys(name)) {
      if (entityIndex.has(key)) {
        found = entityIndex.get(key);
        break;
      }
    }
    if (found == null) unresolved.push(name);
    else if (!ids.includes(found)) ids.push(found);
  }

  return { ids, unresolved };
}

/** Organization names from parsed PID records (entities, else legacy related). */
function sourceEntities(raw) {
  if (Array.isArray(raw.entities) && raw.entities.length > 0) {
    return raw.entities.map((p) => asString(p).trim()).filter(Boolean);
  }
  return asString(raw.related_institutions)
    .split(/\s*,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
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
    entities: Array.isArray(raw.entities)
      ? raw.entities.map((p) => asString(p).trim()).filter(Boolean)
      : [],
    source_url: asString(raw.source_url),
    uc_labels: asString(raw.uc_labels),
    pid_providers: asString(raw.pid_providers),
    research_field: asString(raw.research_field),
    resource_types: asString(raw.resource_types),
    integration_kind: "use-case",
  };
}

function toCreatePayload(record, usedKeyArticles, entityIndex) {
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

  const { ids, unresolved } = resolveEntityIds(
    sourceEntities(record),
    entityIndex
  );
  // Links are applied via the nested Links API (not record PATCH).
  payload.related_institutions = emptyToNull(unresolved.join(", "));

  return {
    payload,
    entityIds: ids,
    unresolvedEntities: unresolved,
  };
}

/**
 * Build a PATCH for blank use-case fields on an existing row.
 * `rawNocoRecord` should be the unnormalized NocoDB row so we can detect
 * truly missing columns (e.g. uc_descr before backfill, title before rename).
 */
function buildBackfillPatch(
  sourceRecord,
  rawNocoRecord,
  usedKeyArticles,
  entityIndex
) {
  const patch = {};
  const name = useCaseName(sourceRecord);
  const descr = useCaseDescr(sourceRecord);
  const { payload: createShape, entityIds } = toCreatePayload(
    sourceRecord,
    usedKeyArticles,
    entityIndex
  );

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

  // Move Organizations out of Further Institutions into linked Institutions.
  let names = sourceEntities(sourceRecord);
  if (names.length === 0) {
    names = asString(rawNocoRecord.related_institutions)
      .split(/\s*,\s*/)
      .map((p) => p.trim())
      .filter(Boolean);
  }
  let linkEntityIds = entityIds;
  let unresolvedEntities = [];
  if (names.length > 0) {
    const resolved = resolveEntityIds(names, entityIndex);
    linkEntityIds = resolved.ids;
    unresolvedEntities = resolved.unresolved;
    const relatedValue = unresolvedEntities.join(", ");
    const currentRelated = asString(rawNocoRecord.related_institutions).trim();
    if (currentRelated !== relatedValue) {
      patch.related_institutions = relatedValue || null;
    }
  }

  const currentCount = asNumber(rawNocoRecord.linked_entities) ?? 0;
  const needsLink = linkEntityIds.length !== currentCount;
  if (Object.keys(patch).length === 0 && !needsLink) return null;

  return {
    id: rawNocoRecord.id,
    ...patch,
    _entityIds: linkEntityIds,
    _unresolvedEntities: unresolvedEntities,
  };
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

async function getLinkFieldId({ baseUrl, tableId, token, timeoutMs, title }) {
  const response = await fetchOk(
    `${baseUrl}/api/v2/meta/tables/${tableId}`,
    { headers: { "xc-token": token } },
    { timeoutMs, label: `NocoDB meta ${tableId}` }
  );
  const meta = await response.json();
  const col = (meta.columns ?? []).find(
    (c) => String(c.title ?? "").trim() === title
  );
  if (!col?.id) {
    throw new Error(`Link field ${JSON.stringify(title)} not found on ${tableId}`);
  }
  return col.id;
}

async function listLinkedRecordIds({
  baseUrl,
  tableId,
  linkFieldId,
  recordId,
  token,
  timeoutMs,
}) {
  const url = `${baseUrl}/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}`;
  const response = await fetchOk(
    url,
    { headers: { "xc-token": token } },
    { timeoutMs, label: `NocoDB list links ${recordId}` }
  );
  const payload = await response.json();
  const list = Array.isArray(payload?.list)
    ? payload.list
    : Array.isArray(payload)
      ? payload
      : [];
  return list.map((row) => row.id).filter((id) => id != null);
}

/**
 * Replace linked Institutions for a User_Stories row via the nested Links API.
 * Record PATCH ignores Links fields on this NocoDB version.
 */
async function syncLinkedEntities({
  baseUrl,
  tableId,
  linkFieldId,
  recordId,
  entityIds,
  token,
  timeoutMs,
}) {
  const desired = [...new Set(entityIds ?? [])];
  const existing = await listLinkedRecordIds({
    baseUrl,
    tableId,
    linkFieldId,
    recordId,
    token,
    timeoutMs,
  });

  const desiredSet = new Set(desired.map(String));
  const existingSet = new Set(existing.map(String));
  const toRemove = existing.filter((id) => !desiredSet.has(String(id)));
  const toAdd = desired.filter((id) => !existingSet.has(String(id)));

  const url = `${baseUrl}/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}`;

  if (toRemove.length > 0) {
    await fetchOk(
      url,
      {
        method: "DELETE",
        headers: {
          "xc-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toRemove.map((id) => ({ id }))),
      },
      { timeoutMs, label: `NocoDB unlink entities ${recordId}` }
    );
  }

  if (toAdd.length > 0) {
    await fetchOk(
      url,
      {
        method: "POST",
        headers: {
          "xc-token": token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(toAdd.map((id) => ({ id }))),
      },
      { timeoutMs, label: `NocoDB link entities ${recordId}` }
    );
  }

  return { added: toAdd.length, removed: toRemove.length };
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
  const entitiesTableId =
    process.env.NOCODB_REF_ENTITIES_TABLE_ID ?? DEFAULT_ENTITIES_TABLE_ID;
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
  /** @type {Map<string, string|number>} */
  let entityIndex = new Map();
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
    console.log(
      "Note: --local cannot resolve REF_Entities links (empty entity index)."
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

    const entityRows = await fetchNocoDbRecords({
      baseUrl,
      tableId: entitiesTableId,
      viewId: "",
      token,
      pageSize,
      timeoutMs,
    });
    entityIndex = buildEntityIdIndex(entityRows);
    console.log(
      `Loaded ${entityRows.length} REF_Entities row(s) for Institutions linking`
    );
  }

  const match = matchAgainstNocoDb(sourceRecords, nocoRecords, BASIC_SERVICE);
  const usedKeyArticles = new Set(
    nocoRecords
      .map((r) => asString(r.key_article).trim())
      .filter(Boolean)
  );

  const plannedCreates = match.only_in_source.map((record) => {
    const { payload, unresolvedEntities, entityIds } = toCreatePayload(
      record,
      usedKeyArticles,
      entityIndex
    );
    return {
      uc_name: useCaseName(record),
      partners: record.partners ?? [],
      entities: sourceEntities(record),
      unresolved_entities: unresolvedEntities,
      entity_ids: entityIds,
      payload,
    };
  });

  const plannedUpdates = [];
  for (const { source, nocodb } of match.matches) {
    if (nocodb.id == null) continue;
    // Check blank fields on the raw row so aliases (title→uc_name, inc_descr→uc_descr)
    // do not hide missing columns that still need backfill.
    const rawRow = rawById.get(nocodb.id) ?? nocodb;
    const patch = buildBackfillPatch(
      source,
      rawRow,
      usedKeyArticles,
      entityIndex
    );
    if (!patch) continue;
    const {
      _entityIds = [],
      _unresolvedEntities = [],
      ...fieldPatch
    } = patch;
    plannedUpdates.push({
      uc_name: useCaseName(source),
      id: nocodb.id,
      entity_ids: _entityIds,
      unresolved_entities: _unresolvedEntities,
      patch: fieldPatch,
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
    const unresolved =
      item.unresolved_entities?.length > 0
        ? ` [unresolved entities: ${item.unresolved_entities.join(", ")}]`
        : "";
    const linkNote =
      item.entity_ids?.length > 0
        ? ` (link ${item.entity_ids.length} entit${item.entity_ids.length === 1 ? "y" : "ies"})`
        : "";
    console.log(
      `  + ${item.uc_name} → ${item.payload.key_article}${linkNote}${unresolved}`
    );
  }
  for (const item of plannedUpdates) {
    const fields = Object.keys(item.patch).filter((k) => k !== "id");
    const linkCount = item.entity_ids?.length ?? 0;
    const linkNote =
      linkCount > 0
        ? ` (link ${linkCount} entit${linkCount === 1 ? "y" : "ies"})`
        : "";
    const fieldNote = fields.length > 0 ? fields.join(", ") : "entities only";
    console.log(
      `  ~ ${item.uc_name} (id ${item.id}) ← ${fieldNote}${linkNote}`
    );
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

  const linkFieldId = await getLinkFieldId({
    baseUrl,
    tableId,
    token,
    timeoutMs,
    title: "linked_entities",
  });

  if (limitedCreates.length > 0) {
    const created = await createRecords({
      baseUrl,
      tableId,
      token,
      records: limitedCreates.map((item) => item.payload),
      timeoutMs,
    });
    const createdRows = Array.isArray(created)
      ? created
      : Array.isArray(created?.list)
        ? created.list
        : [];
    console.log(`Created ${createdRows.length || limitedCreates.length} User_Stories row(s).`);

    for (let i = 0; i < limitedCreates.length; i++) {
      const item = limitedCreates[i];
      const createdId = createdRows[i]?.id;
      if (createdId == null || !item.entity_ids?.length) continue;
      const sync = await syncLinkedEntities({
        baseUrl,
        tableId,
        linkFieldId,
        recordId: createdId,
        entityIds: item.entity_ids,
        token,
        timeoutMs,
      });
      console.log(
        `  linked ${item.uc_name} (id ${createdId}): +${sync.added}/-${sync.removed}`
      );
    }
  }

  if (plannedUpdates.length > 0) {
    const fieldUpdates = plannedUpdates
      .map((item) => item.patch)
      .filter((patch) => Object.keys(patch).some((k) => k !== "id"));
    if (fieldUpdates.length > 0) {
      const updated = await updateRecords({
        baseUrl,
        tableId,
        token,
        records: fieldUpdates,
        timeoutMs,
      });
      const updatedCount = Array.isArray(updated)
        ? updated.length
        : Array.isArray(updated?.list)
          ? updated.list.length
          : fieldUpdates.length;
      console.log(`Updated ${updatedCount} User_Stories row(s).`);
    }

    for (const item of plannedUpdates) {
      if (!item.entity_ids?.length && (asNumber(rawById.get(item.id)?.linked_entities) ?? 0) === 0) {
        continue;
      }
      const sync = await syncLinkedEntities({
        baseUrl,
        tableId,
        linkFieldId,
        recordId: item.id,
        entityIds: item.entity_ids ?? [],
        token,
        timeoutMs,
      });
      if (sync.added || sync.removed) {
        console.log(
          `  linked ${item.uc_name} (id ${item.id}): +${sync.added}/-${sync.removed}`
        );
      }
    }
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

#!/usr/bin/env node
/**
 * Mirror the public service sources into incubators and use cases that are
 * already in NocoDB.
 *
 * By default the source wins: any source-backed cell (dates, cycle,
 * description, goals, results, service type, …) that differs from NocoDB is
 * overwritten with the source value. Cells the source leaves empty are kept,
 * and so are inc_name titles written in NocoDB (see canSyncName).
 * Copies inc_status from the source when it changes and sets status to
 * Finished once the end date is in the past. Links partners when a row has
 * none; an existing partner set is not replaced.
 *
 * --fill-only restores the conservative mode: fill empty cells, extend a
 * description only when the stored text is a strict prefix of the source,
 * and keep differing wording.
 *
 * Reads:
 *   data/parsed/{dmp,iam,ts,pid}4nfdi.json
 *
 * Required env for live fetch / --apply:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_TABLE_ID                 — Incubators, default m3zt5vqlyja927x
 *   NOCODB_USER_STORIES_TABLE_ID    — default mtq40pxpo5p0jmx
 *   NOCODB_PARTNERS_TABLE_ID        — default pf8ggs9jduxse4x
 *   NOCODB_VIEW_ID                  — omit (full table). View filters drop rows.
 *   NOCODB_USER_STORIES_VIEW_ID
 *
 * Usage:
 *   node scripts/patch-published-integrations.mjs
 *   node scripts/patch-published-integrations.mjs --local
 *   node scripts/patch-published-integrations.mjs --service iam4nfdi,dmp4nfdi
 *   node scripts/patch-published-integrations.mjs --limit 5 --apply
 *   node scripts/patch-published-integrations.mjs --fill-only --apply
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
  normalizePartnerName,
  readJson,
  repoRoot,
  todayIso,
  writeJson,
} from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PARTNERS_FIELD = "name (from REF_Partners)";
const ENTITIES_FIELD = "name (from REF_Entities)";
const LINK_FIELD_TITLE = "linked_partners";

const INCUBATORS_TABLE = "incubators";
const USE_CASES_TABLE = "user_stories";

const SOURCES = [
  {
    id: "dmp4nfdi",
    basic_service: "DMP",
    table: INCUBATORS_TABLE,
    parsed: join(repoRoot, "data/parsed/dmp4nfdi.json"),
  },
  {
    id: "iam4nfdi",
    basic_service: "IAM",
    table: INCUBATORS_TABLE,
    parsed: join(repoRoot, "data/parsed/iam4nfdi.json"),
  },
  {
    id: "ts4nfdi",
    basic_service: "TS",
    table: INCUBATORS_TABLE,
    parsed: join(repoRoot, "data/parsed/ts4nfdi.json"),
  },
  {
    id: "pid4nfdi",
    basic_service: "PID",
    table: USE_CASES_TABLE,
    parsed: join(repoRoot, "data/parsed/pid4nfdi.json"),
  },
];

/** Source-backed incubator cells. Descriptions and results are separate. */
const INCUBATOR_BLANK_FIELDS = [
  "inc_name",
  "inc_start",
  "inc_end",
  "inc_cycle",
  "inc_cycle_label",
  "inc_goals",
  "inc_activity_type",
  "inc_caai",
  "inc_ownership",
  "inc_service_type",
  "inc_activity_page",
  "inc_source_ref",
];

/** Source-backed use-case cells. Descriptions and results are separate. */
const USE_CASE_BLANK_FIELDS = [
  "inc_start",
  "inc_end",
  "inc_cycle",
  "inc_goals",
  "uc_name",
  "inc_name",
  "basic_service",
  "key_article",
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
  const args = {
    apply: false,
    local: false,
    fillOnly: false,
    services: null,
    limit: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--local") args.local = true;
    else if (arg === "--fill-only") args.fillOnly = true;
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

function printHelp() {
  console.log(`Usage:
  node scripts/patch-published-integrations.mjs [options]

Options:
  --apply              PATCH matched rows (default is dry-run)
  --dry-run            Preview only (default)
  --local              Compare against static/data.json instead of live NocoDB
  --fill-only          Only fill empty cells / extend prefix descriptions;
                       keep NocoDB values that differ from the source
  --service <ids>      Comma-separated: dmp4nfdi,iam4nfdi,ts4nfdi,pid4nfdi
  --limit <n>          Cap how many row updates are applied
  -h, --help           Show this help

Overwrites source-backed fields that differ from the public source (cells
the source leaves empty are kept), links partners only when the row has
none, copies inc_status when the source status differs, and sets
inc_status to Finished when the end date is before today.
`);
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

function splitPartnersText(value) {
  return asString(value)
    .split(/\s*,\s*/)
    .map((p) => p.replace(/\r/g, "").trim())
    .filter(Boolean);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function isBlank(value) {
  if (value == null) return true;
  if (typeof value === "string") return value.trim() === "";
  return false;
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Blank stored text is filled. A stored description that is a strict prefix
 * of the source (a missing tail) is replaced. Divergent wording is kept.
 */
function descriptionUpdate(sourceText, storedText) {
  const source = compact(sourceText);
  const stored = compact(storedText);
  if (!source) return null;
  if (!stored) return String(sourceText).trim();
  if (source === stored) return null;
  if (source.startsWith(stored)) return String(sourceText).trim();
  return null;
}

/**
 * Fill empty results or replace when the source adds links the stored text lacks.
 */
function resultsUpdate(sourceText, storedText) {
  const source = String(sourceText ?? "").trim();
  const stored = String(storedText ?? "").trim();
  if (!source) return null;
  if (!stored) return source;
  if (source === stored) return null;

  if (stored.includes("<!--") && compact(stored).startsWith(compact(source))) {
    return source;
  }

  const prefix = descriptionUpdate(source, stored);
  if (prefix) return prefix;

  const urlRe = /https?:\/\/[^\s]+/gi;
  const sourceUrls = new Set([...source.matchAll(urlRe)].map((m) => m[0]));
  const storedUrls = [...stored.matchAll(urlRe)].map((m) => m[0]);
  if (
    storedUrls.length > 0 &&
    storedUrls.every((url) => sourceUrls.has(url)) &&
    sourceUrls.size > storedUrls.length
  ) {
    return source;
  }
  return null;
}

function statusUpdate(source, noco) {
  const current = asString(noco.inc_status).trim();
  const sourceStatus = asString(source.inc_status).trim();
  const end = asString(source.inc_end).trim() || asString(noco.inc_end).trim();
  const today = todayIso();
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end < today) {
    if (current === "Finished") return null;
    return { value: "Finished", reason: "end_date_elapsed" };
  }
  if (VALID_STATUSES.has(sourceStatus) && sourceStatus !== current) {
    return {
      value: sourceStatus,
      reason: current ? "source_changed" : "fill_empty",
    };
  }
  return null;
}

function hasPartners(noco) {
  const names = Array.isArray(noco.partners)
    ? noco.partners.filter(Boolean)
    : [];
  const count = Number(noco.linked_partners) || 0;
  return names.length > 0 || count > 0;
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

  const compactKey = raw.toLowerCase().replace(/[^a-z0-9@+]/g, "");
  if (compactKey) keys.add(compactKey);

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
  if (!partnerIndex) {
    return { ids, unresolved: [...(partnerNames ?? [])] };
  }

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

function normalizeIncubator(raw) {
  return {
    id: raw.id ?? null,
    inc_name: asString(raw.inc_name),
    basic_service: asString(raw.basic_service),
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_cycle_label: asString(raw.inc_cycle_label),
    inc_status: asString(raw.inc_status),
    inc_descr: asString(raw.inc_descr),
    uc_descr: "",
    inc_goals: asString(raw.inc_goals),
    inc_results: asString(raw.inc_results),
    inc_partner_publications: asNumber(raw.inc_partner_publications) ?? 0,
    inc_activity_type: asString(raw.inc_activity_type),
    inc_caai: asString(raw.inc_caai),
    inc_ownership: asString(raw.inc_ownership),
    inc_service_type: asString(raw.inc_service_type),
    inc_activity_page: asString(raw.inc_activity_page),
    inc_source_ref: asString(raw.inc_source_ref),
    linked_partners: asNumber(raw.linked_partners),
    partners: asStringList(raw[PARTNERS_FIELD] ?? raw.partners),
    entities: asStringList(raw[ENTITIES_FIELD] ?? raw.entities),
    partners_text: "",
  };
}

function normalizeUseCase(raw) {
  const partnersFromLookup = asStringList(raw[PARTNERS_FIELD]);
  const partnersText = asString(raw.partners);
  const partners =
    partnersFromLookup.length > 0
      ? partnersFromLookup
      : splitPartnersText(partnersText);
  const ucDescr = asString(raw.uc_descr);
  const incDescr = asString(raw.inc_descr);
  const name = asString(raw.uc_name || raw.inc_name || raw.title);

  return {
    id: raw.id ?? null,
    inc_name: name,
    uc_name: asString(raw.uc_name || raw.title),
    basic_service: asString(raw.basic_service) || "PID",
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_status: asString(raw.inc_status),
    inc_descr: ucDescr || incDescr,
    uc_descr: ucDescr,
    inc_descr_column: incDescr,
    inc_goals: asString(raw.inc_goals),
    inc_results: asString(raw.inc_results),
    inc_partner_publications: asNumber(raw.inc_partner_publications) ?? 0,
    linked_partners: asNumber(raw.linked_partners) ?? partners.length,
    partners,
    entities: asStringList(raw[ENTITIES_FIELD] ?? raw.entities),
    partners_text: partnersText,
    uc_labels: asString(raw.uc_labels),
    pid_providers: asString(raw.pid_providers),
    research_field: asString(raw.research_field),
    resource_types: asString(raw.resource_types),
    source_url: asString(raw.source_url),
  };
}

function blankValue(field, source) {
  const value = source[field];
  if (field === "inc_cycle") {
    if (value == null || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (field === "basic_service") {
    const text = asString(value).trim();
    return text || null;
  }
  const text = asString(value).trim();
  return text || null;
}

/**
 * DMP sources have no titles; the parser names untitled entries
 * "<Primary service> — <Consortia>". Such names follow the source, while a
 * title an editor wrote in NocoDB is kept.
 */
const DERIVED_NAME_RE = /^[^—]+ — [^—]+$/;

function canSyncName(stored, next) {
  return DERIVED_NAME_RE.test(compact(stored)) && DERIVED_NAME_RE.test(compact(next));
}

function sameValue(field, stored, next) {
  if (field === "inc_cycle") return asNumber(stored) === asNumber(next);
  return compact(stored) === compact(next);
}

/** Source text replaces stored text whenever the two differ. */
function syncTextFields(source, noco, table, patch, reasons) {
  const sourceDescr = asString(source.uc_descr || source.inc_descr).trim();
  const descrField = table === USE_CASES_TABLE ? "uc_descr" : "inc_descr";
  if (sourceDescr && !sameValue(descrField, noco[descrField], sourceDescr)) {
    patch[descrField] = sourceDescr;
    reasons.push(`${isBlank(noco[descrField]) ? "fill" : "sync"}:${descrField}`);
  }

  const sourceResults = asString(source.inc_results).trim();
  if (sourceResults && !sameValue("inc_results", noco.inc_results, sourceResults)) {
    patch.inc_results = sourceResults;
    reasons.push(`${isBlank(noco.inc_results) ? "fill" : "sync"}:inc_results`);
  }
}

function buildRowPatch(source, noco, table, partnerIndex, { fillOnly = false } = {}) {
  const patch = {};
  const reasons = [];
  const blankFields =
    table === USE_CASES_TABLE ? USE_CASE_BLANK_FIELDS : INCUBATOR_BLANK_FIELDS;

  for (const field of blankFields) {
    const value = blankValue(field, source);
    if (value == null) continue;
    if (isBlank(noco[field])) {
      patch[field] = value;
      reasons.push(`fill:${field}`);
    } else if (
      !fillOnly &&
      !sameValue(field, noco[field], value) &&
      (field !== "inc_name" || canSyncName(noco[field], value))
    ) {
      patch[field] = value;
      reasons.push(`sync:${field}`);
    }
  }

  if (!fillOnly) {
    syncTextFields(source, noco, table, patch, reasons);
  } else {
    fillOnlyTextFields(source, noco, table, patch, reasons);
  }

  if (table === INCUBATORS_TABLE) {
    const nocoCount = Number(noco.inc_partner_publications) || 0;
    const sourceCount = Number(source.inc_partner_publications) || 0;
    const replace = fillOnly ? nocoCount === 0 : nocoCount !== sourceCount;
    if (sourceCount > 0 && replace) {
      patch.inc_partner_publications = sourceCount;
      reasons.push(`${nocoCount === 0 ? "fill" : "sync"}:inc_partner_publications`);
    }
  }

  const status = statusUpdate(source, noco);
  if (status) {
    patch.inc_status = status.value;
    reasons.push(`status:${status.reason}`);
  }

  let partnerIds = [];
  let unresolvedPartners = [];
  if (!hasPartners(noco)) {
    const names = (source.partners ?? []).map((name) => asString(name).trim()).filter(Boolean);
    if (names.length > 0) {
      const resolved = resolvePartnerIds(names, partnerIndex);
      partnerIds = resolved.ids;
      unresolvedPartners = resolved.unresolved;
      if (table === USE_CASES_TABLE && isBlank(noco.partners_text)) {
        patch.partners = names.join(", ");
        reasons.push("fill:partners");
      }
      if (partnerIds.length > 0) reasons.push("link:partners");
      else if (unresolvedPartners.length > 0) reasons.push("unresolved:partners");
    }
  }

  const scalar = { ...patch };
  const hasScalar = Object.keys(scalar).length > 0;
  const hasLinks = partnerIds.length > 0;
  if (!hasScalar && !hasLinks && unresolvedPartners.length === 0) return null;

  return {
    id: noco.id,
    inc_name: source.inc_name || noco.inc_name,
    key_article: noco.key_article || source.key_article || "",
    patch: scalar,
    partner_ids: partnerIds,
    unresolved_partners: unresolvedPartners,
    reasons,
  };
}

/**
 * Blank text is filled; a stored description that is a strict prefix of the
 * source is extended; results gain new source links. Divergent wording stays.
 */
function fillOnlyTextFields(source, noco, table, patch, reasons) {
  const sourceDescr = asString(source.uc_descr || source.inc_descr).trim();
  const displayed = asString(noco.inc_descr);
  const nextDescr = descriptionUpdate(sourceDescr, displayed);
  if (nextDescr) {
    const storedColumn = asString(noco.inc_descr_column ?? noco.inc_descr);
    if (descriptionUpdate(nextDescr, storedColumn) || isBlank(storedColumn)) {
      if (compact(storedColumn) !== compact(nextDescr)) {
        patch.inc_descr = nextDescr;
      }
    } else if (isBlank(displayed)) {
      patch.inc_descr = nextDescr;
    }
    if (table === USE_CASES_TABLE) {
      const storedUc = asString(noco.uc_descr);
      if (isBlank(storedUc) || descriptionUpdate(nextDescr, storedUc)) {
        if (compact(storedUc) !== compact(nextDescr)) patch.uc_descr = nextDescr;
      }
    } else if (compact(displayed) !== compact(nextDescr)) {
      patch.inc_descr = nextDescr;
    }
    if (patch.inc_descr || patch.uc_descr) {
      reasons.push(isBlank(displayed) ? "fill:inc_descr" : "extend:inc_descr");
    }
  }

  const nextResults = resultsUpdate(
    asString(source.inc_results),
    asString(noco.inc_results)
  );
  if (nextResults && compact(asString(noco.inc_results)) !== compact(nextResults)) {
    patch.inc_results = nextResults;
    reasons.push(
      isBlank(noco.inc_results) ? "fill:inc_results" : "extend:inc_results"
    );
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

async function getLinkFieldId({ baseUrl, tableId, token, timeoutMs }) {
  const response = await fetchOk(
    `${baseUrl}/api/v2/meta/tables/${tableId}`,
    { headers: { "xc-token": token } },
    { timeoutMs, label: `NocoDB meta ${tableId}` }
  );
  const meta = await response.json();
  const col = (meta.columns ?? []).find((c) => {
    const title = String(c.title ?? "").trim();
    const name = String(c.column_name ?? "").trim();
    return title === LINK_FIELD_TITLE || name === LINK_FIELD_TITLE;
  });
  return col?.id ?? null;
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

async function linkPartners({
  baseUrl,
  tableId,
  linkFieldId,
  recordId,
  partnerIds,
  token,
  timeoutMs,
}) {
  const existing = await listLinkedRecordIds({
    baseUrl,
    tableId,
    linkFieldId,
    recordId,
    token,
    timeoutMs,
  });
  if (existing.length > 0) return { linked: 0, skipped: "already_linked" };

  const url = `${baseUrl}/api/v2/tables/${tableId}/links/${linkFieldId}/records/${recordId}`;
  await fetchOk(
    url,
    {
      method: "POST",
      headers: {
        "xc-token": token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(partnerIds.map((id) => ({ id }))),
    },
    { timeoutMs, label: `NocoDB link partners ${recordId}` }
  );
  return { linked: partnerIds.length, skipped: null };
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
    console.error("NOCODB_API_TOKEN is required for --apply");
    process.exit(1);
  }
  if (!token && !args.local) {
    console.error(
      "Missing NOCODB_API_TOKEN. Pass --local to compare against static/data.json."
    );
    process.exit(1);
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const incubatorsTableId = process.env.NOCODB_TABLE_ID ?? "m3zt5vqlyja927x";
  const useCasesTableId =
    process.env.NOCODB_USER_STORIES_TABLE_ID ?? "mtq40pxpo5p0jmx";
  const partnersTableId =
    process.env.NOCODB_PARTNERS_TABLE_ID ?? "pf8ggs9jduxse4x";
  const incubatorsViewId = process.env.NOCODB_VIEW_ID ?? "";
  const useCasesViewId = process.env.NOCODB_USER_STORIES_VIEW_ID ?? "";
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

  const tableIds = {
    [INCUBATORS_TABLE]: incubatorsTableId,
    [USE_CASES_TABLE]: useCasesTableId,
  };

  /** @type {Array<object>} */
  let nocoRecords;
  if (args.local || !token) {
    nocoRecords = loadNocoDbRecords().map((row) => {
      if (asString(row.integration_kind) === "use-case" || asString(row.basic_service).toUpperCase() === "PID") {
        return normalizeUseCase({
          ...row,
          uc_descr: row.uc_descr || row.inc_descr,
          partners: Array.isArray(row.partners) ? row.partners.join(", ") : row.partners,
          [PARTNERS_FIELD]: row.partners,
        });
      }
      return normalizeIncubator({
        ...row,
        [PARTNERS_FIELD]: row.partners,
      });
    });
    console.log(`Loaded ${nocoRecords.length} row(s) from static/data.json`);
  } else {
    const incubators = await fetchNocoDbRecords({
      baseUrl,
      tableId: incubatorsTableId,
      viewId: incubatorsViewId,
      token,
      pageSize,
      timeoutMs,
    });
    const useCases = await fetchNocoDbRecords({
      baseUrl,
      tableId: useCasesTableId,
      viewId: useCasesViewId,
      token,
      pageSize,
      timeoutMs,
    });
    nocoRecords = [
      ...incubators.map(normalizeIncubator),
      ...useCases.map(normalizeUseCase),
    ];
    console.log(
      `Fetched ${incubators.length} incubator(s) and ${useCases.length} use case(s)`
    );
  }

  let partnerIndex = null;
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
    console.log(`Loaded ${partnerRows.length} partner(s) for link resolution`);
  } else {
    console.log("No API token — partner ids will be left unresolved");
  }

  const planned = [];
  for (const source of sources) {
    const parsed = readJson(source.parsed, {
      hint: "Run: node scripts/parse-source-pages.mjs",
    });
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const match = matchAgainstNocoDb(records, nocoRecords, source.basic_service);

    for (const pair of match.matches) {
      const row = buildRowPatch(
        pair.source,
        pair.nocodb,
        source.table,
        partnerIndex,
        { fillOnly: args.fillOnly }
      );
      if (!row) continue;
      planned.push({
        source: source.id,
        table: source.table,
        ...row,
      });
    }
  }

  const limited = args.limit == null ? planned : planned.slice(0, args.limit);

  const countReasons = (rows, prefix) =>
    rows.filter((row) => row.reasons.some((reason) => reason.startsWith(prefix)))
      .length;

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    strategy: args.fillOnly ? "fill-only" : "source-wins",
    compared_against: args.local || !token ? "static/data.json" : "live-nocodb",
    planned_at: new Date().toISOString(),
    totals: {
      to_patch: planned.length,
      will_patch: limited.length,
      synced: countReasons(limited, "sync:"),
      status_finished: countReasons(limited, "status:end_date_elapsed"),
      status_changed: countReasons(limited, "status:source_changed") +
        countReasons(limited, "status:fill_empty"),
      descriptions_extended: countReasons(limited, "extend:"),
      partner_links: limited.filter((row) => row.partner_ids.length > 0).length,
    },
    by_source: Object.fromEntries(
      sources.map((s) => {
        const rows = limited.filter((row) => row.source === s.id);
        return [
          s.id,
          {
            to_patch: planned.filter((row) => row.source === s.id).length,
            will_patch: rows.length,
            synced: countReasons(rows, "sync:"),
            status_finished: countReasons(rows, "status:end_date_elapsed"),
            status_changed:
              countReasons(rows, "status:source_changed") +
              countReasons(rows, "status:fill_empty"),
            partner_links: rows.filter((row) => row.partner_ids.length > 0).length,
          },
        ];
      })
    ),
    records: limited.map((row) => ({
      source: row.source,
      table: row.table,
      id: row.id,
      inc_name: row.inc_name,
      key_article: row.key_article,
      reasons: row.reasons,
      unresolved_partners: row.unresolved_partners,
      partner_ids: row.partner_ids,
      patch: row.patch,
    })),
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/published-integrations.patch-report.json"
  );
  writeJson(reportPath, report);

  console.log("\n=== Published integrations patch ===");
  for (const [id, counts] of Object.entries(report.by_source)) {
    console.log(
      `${id}: to_patch=${counts.to_patch} will_patch=${counts.will_patch} synced=${counts.synced} ` +
        `finished=${counts.status_finished} status=${counts.status_changed} partner_links=${counts.partner_links}`
    );
  }
  console.log(
    `\nTotal to_patch=${report.totals.to_patch} will_patch=${report.totals.will_patch} ` +
      `synced=${report.totals.synced} finished=${report.totals.status_finished} ` +
      `status=${report.totals.status_changed} mode=${report.mode} strategy=${report.strategy}`
  );
  console.log(`Wrote plan to ${reportPath}`);

  if (!args.apply) {
    console.log("\nDry-run only. Re-run with --apply to update NocoDB.");
    return;
  }

  const linkFieldIds = {};
  for (const table of new Set(limited.map((row) => row.table))) {
    const tableId = tableIds[table];
    linkFieldIds[table] = await getLinkFieldId({
      baseUrl,
      tableId,
      token,
      timeoutMs,
    });
    if (!linkFieldIds[table]) {
      console.log(
        `No ${LINK_FIELD_TITLE} column on ${table} — partner links will be skipped`
      );
    }
  }

  let patched = 0;
  let linked = 0;
  for (const table of Object.keys(tableIds)) {
    const rows = limited.filter(
      (row) => row.table === table && Object.keys(row.patch).length > 0 && row.id != null
    );
    const tableId = tableIds[table];
    const batchSize = 25;
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize).map((row) => ({
        id: row.id,
        ...row.patch,
      }));
      await updateRecords({
        baseUrl,
        tableId,
        token,
        records: batch,
        timeoutMs,
      });
      patched += batch.length;
      console.log(`Patched ${table} batch ${i / batchSize + 1}: ${batch.length} row(s)`);
    }
  }

  for (const row of limited) {
    if (!row.partner_ids.length || row.id == null) continue;
    const linkFieldId = linkFieldIds[row.table];
    if (!linkFieldId) continue;
    const result = await linkPartners({
      baseUrl,
      tableId: tableIds[row.table],
      linkFieldId,
      recordId: row.id,
      partnerIds: row.partner_ids,
      token,
      timeoutMs,
    });
    if (result.skipped) {
      console.log(`Skip partner link ${row.key_article || row.id}: ${result.skipped}`);
      continue;
    }
    linked += result.linked;
    console.log(
      `Linked ${result.linked} partner(s) on ${row.key_article || row.id}`
    );
  }

  console.log(`\nDone. Patched ${patched} row(s); linked ${linked} partner id(s).`);
  console.log("Tip: refresh local data with: node scripts/fetch-nocodb-data.mjs");
  console.log(
    "Then refresh detail pages with: node scripts/generate-incubator-pages.mjs --update"
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

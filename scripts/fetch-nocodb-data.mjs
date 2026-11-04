#!/usr/bin/env node
/**
 * Fetches incubators + PID use-case rows from NocoDB and writes static/data.json.
 *
 * Incubators come from NOCODB_TABLE_ID (default Incubators table).
 * Use cases come from NOCODB_USER_STORIES_TABLE_ID (default User_Stories).
 *
 * Required env:
 *   NOCODB_API_TOKEN  — xc-token from https://nocodb.nfdi.de/dashboard/#/account/tokens
 *
 * Optional env:
 *   NOCODB_BASE_URL, NOCODB_TABLE_ID, NOCODB_PAGE_SIZE, OUTPUT_JSON
 *   NOCODB_VIEW_ID — omit by default (recommended). If set, NocoDB applies that
 *                    view's filters/sorts to the API response, which can silently
 *                    drop rows from the dashboard export.
 *   NOCODB_USER_STORIES_TABLE_ID — default mtq40pxpo5p0jmx
 *   NOCODB_USER_STORIES_VIEW_ID — omit by default
 *   FETCH_TIMEOUT_MS — per-request timeout (default: 60000)
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNocoDbRecords, parsePositiveInt } from "./lib/http-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const PARTNERS_FIELD = "name (from REF_Partners)";
const ENTITIES_FIELD = "name (from REF_Entities)";
const DEFAULT_USER_STORIES_TABLE_ID = "mtq40pxpo5p0jmx";

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

function splitPartnersText(value) {
  return asString(value)
    .split(/\s*,\s*/)
    .map((p) => p.replace(/\r/g, "").trim())
    .filter(Boolean);
}

/** Map raw Incubators NocoDB record to the dashboard JSON shape. */
function normalizeIncubatorRecord(raw) {
  return {
    id: raw.id ?? null,
    inc_name: asString(raw.inc_name),
    basic_service: asString(raw.basic_service),
    related_institutions: asString(raw.related_institutions),
    logo_project: asString(raw.logo_project),
    logo_project_dark: asString(raw.logo_project_dark),
    logo_consortia: asString(raw.logo_consortia),
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_cycle_label: asString(raw.inc_cycle_label),
    inc_status: asString(raw.inc_status),
    inc_descr: asString(raw.inc_descr),
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
    linked_entities: asNumber(raw.linked_entities),
    partners: asStringList(raw[PARTNERS_FIELD]),
    entities: asStringList(raw[ENTITIES_FIELD]),
    source_url: "",
    integration_kind: "incubator",
  };
}

/** Names from the User_Stories ↔ REF_Entities M2M nest (when Lookup is absent). */
function entitiesFromM2m(raw) {
  const rows = raw["_nc_m2m_User_Stories_REF_Entities"];
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => row?.REF_Entities?.name ?? row?.name)
    .map((item) => (item == null ? "" : String(item).replace(/\r/g, "").trim()))
    .filter(Boolean);
}

/** Map raw User_Stories NocoDB record to the same dashboard JSON shape. */
function normalizeUseCaseRecord(raw) {
  const partnersFromLookup = asStringList(raw[PARTNERS_FIELD]);
  const partners =
    partnersFromLookup.length > 0
      ? partnersFromLookup
      : splitPartnersText(raw.partners);

  // Institutions: Lookup → linked M2M names → legacy related_institutions text.
  // PID cards originally landed in related_institutions (Further Institutions);
  // prefer the Institutions column whenever we can recover the names.
  const entitiesFromLookup = asStringList(raw[ENTITIES_FIELD]);
  const entitiesFromLink = entitiesFromM2m(raw);
  const relatedList = splitPartnersText(raw.related_institutions);
  const hasLinkedEntities =
    entitiesFromLookup.length > 0 || entitiesFromLink.length > 0;
  const entities = hasLinkedEntities
    ? entitiesFromLookup.length > 0
      ? entitiesFromLookup
      : entitiesFromLink
    : relatedList;
  const related_institutions = hasLinkedEntities
    ? asString(raw.related_institutions)
    : "";

  const name = asString(raw.uc_name || raw.inc_name || raw.title);
  const descr = asString(raw.uc_descr || raw.inc_descr);

  return {
    id: raw.id ?? null,
    inc_name: name,
    uc_name: name,
    basic_service: asString(raw.basic_service) || "PID",
    related_institutions,
    logo_project: asString(raw.logo_project),
    logo_project_dark: asString(raw.logo_project_dark),
    logo_consortia: asString(raw.logo_consortia),
    key_article: asString(raw.key_article),
    inc_start: asString(raw.inc_start),
    inc_end: asString(raw.inc_end),
    inc_cycle: raw.inc_cycle ?? null,
    inc_cycle_label: asString(raw.inc_cycle_label),
    inc_status: asString(raw.inc_status),
    inc_descr: descr,
    uc_descr: descr,
    inc_goals: asString(raw.inc_goals),
    inc_results: asString(raw.inc_results),
    inc_partner_publications: asNumber(raw.inc_partner_publications) ?? 0,
    inc_activity_type: asString(raw.inc_activity_type),
    inc_caai: asString(raw.inc_caai),
    inc_ownership: asString(raw.inc_ownership),
    inc_service_type: asString(raw.inc_service_type),
    inc_activity_page: asString(raw.inc_activity_page),
    linked_partners: asNumber(raw.linked_partners) ?? partners.length,
    linked_entities: asNumber(raw.linked_entities) ?? entities.length,
    partners,
    entities,
    source_url: asString(raw.source_url),
    uc_labels: asString(raw.uc_labels),
    pid_providers: asString(raw.pid_providers),
    research_field: asString(raw.research_field),
    resource_types: asString(raw.resource_types),
    integration_kind: "use-case",
  };
}

async function main() {
  loadDotEnv();

  const token = process.env.NOCODB_API_TOKEN;
  if (!token) {
    console.error(
      "Missing NOCODB_API_TOKEN. Create one at https://nocodb.nfdi.de/dashboard/#/account/tokens"
    );
    process.exit(1);
  }

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(
    /\/$/,
    ""
  );
  const tableId = process.env.NOCODB_TABLE_ID ?? "m3zt5vqlyja927x";
  // Empty by default: table API without viewId returns all rows.
  // A viewId inherits that view's UI filters (e.g. consortia = Text+).
  const viewId = (process.env.NOCODB_VIEW_ID ?? "").trim();
  const userStoriesTableId =
    process.env.NOCODB_USER_STORIES_TABLE_ID ?? DEFAULT_USER_STORIES_TABLE_ID;
  const userStoriesViewId = (
    process.env.NOCODB_USER_STORIES_VIEW_ID ?? ""
  ).trim();
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
  const outputPath = resolve(
    repoRoot,
    process.env.OUTPUT_JSON ?? "static/data.json"
  );

  const rawIncubators = await fetchNocoDbRecords({
    baseUrl,
    tableId,
    viewId,
    token,
    pageSize,
    timeoutMs,
  });

  if (rawIncubators.length === 0) {
    const scope = viewId ? `view ${viewId}` : "full table (no viewId)";
    throw new Error(
      `NocoDB returned 0 records for table ${tableId} (${scope}) — refusing to overwrite ${outputPath}`
    );
  }

  let rawUseCases = [];
  try {
    rawUseCases = await fetchNocoDbRecords({
      baseUrl,
      tableId: userStoriesTableId,
      viewId: userStoriesViewId,
      token,
      pageSize,
      timeoutMs,
    });
  } catch (error) {
    console.warn(
      `Warning: could not fetch User_Stories (${userStoriesTableId}): ${error.message}`
    );
  }

  const incubatorRecords = rawIncubators.map(normalizeIncubatorRecord);
  const useCaseRecords = rawUseCases.map(normalizeUseCaseRecord);
  const records = [...incubatorRecords, ...useCaseRecords];

  const payload = {
    source: "nocodb",
    fetched_at: new Date().toISOString(),
    tables: {
      incubators: {
        table_id: tableId,
        view_id: viewId || null,
        count: incubatorRecords.length,
      },
      user_stories: {
        table_id: userStoriesTableId,
        view_id: userStoriesViewId || null,
        count: useCaseRecords.length,
      },
    },
    records,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  const scope = viewId ? `view ${viewId}` : "full table";
  console.log(
    `Wrote ${records.length} row(s) to ${outputPath} ` +
      `(incubators=${incubatorRecords.length} [${scope}], ` +
      `use-cases=${useCaseRecords.length})`
  );
  if (viewId) {
    console.warn(
      "Warning: NOCODB_VIEW_ID is set — NocoDB view filters apply to this export."
    );
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

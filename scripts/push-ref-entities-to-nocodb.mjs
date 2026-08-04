#!/usr/bin/env node
/**
 * Sync German research institutes from Wikidata into the NocoDB REF_Entities
 * table, backfill missing fields on existing rows, and optionally search /
 * add a single entity by name.
 *
 * Wikidata filter (bulk sync):
 *   P31 (instance of) = Q31855 (research institute)
 *   P17 (country)     = Q183   (Germany)
 *
 * Fields written / backfilled:
 *   name, official_website (P856), official_logo (P154), wikidata_identifier
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_REF_ENTITIES_TABLE_ID  — default 7v80fm7p5jpa7xj
 *   NOCODB_REF_ENTITIES_VIEW_ID   — default empty (full table)
 *   NOCODB_PAGE_SIZE
 *   FETCH_TIMEOUT_MS
 *   WIKIDATA_USER_AGENT
 *
 * Usage:
 *   node scripts/push-ref-entities-to-nocodb.mjs
 *   node scripts/push-ref-entities-to-nocodb.mjs --apply
 *   node scripts/push-ref-entities-to-nocodb.mjs --backfill-only --apply
 *   node scripts/push-ref-entities-to-nocodb.mjs --limit 10 --apply
 *   node scripts/push-ref-entities-to-nocodb.mjs --search "FIZ Karlsruhe"
 *   node scripts/push-ref-entities-to-nocodb.mjs --search "DKRZ" --apply
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchNocoDbRecords,
  fetchOk,
  parsePositiveInt,
} from "./lib/http-utils.mjs";
import { repoRoot, writeJson } from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TABLE_ID = "7v80fm7p5jpa7xj";
const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const DEFAULT_USER_AGENT =
  "Base4NFDI-dashboard/1.0 (REF_Entities sync; https://github.com/base4nfdi)";

const WRITE_FIELDS = [
  "name",
  "wikidata_identifier",
  "official_website",
  "official_logo",
];

/** Fields backfilled onto matched rows when blank in NocoDB. */
const BACKFILL_FIELDS = ["official_website", "official_logo"];

const CREATE_BATCH_SIZE = 50;
const UPDATE_BATCH_SIZE = 50;
const SPARQL_ENTITY_CHUNK = 40;

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
    backfillOnly: false,
    limit: null,
    search: null,
    pick: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--dry-run") args.apply = false;
    else if (arg === "--backfill-only") args.backfillOnly = true;
    else if (arg === "--limit") {
      args.limit = Number(argv[++i]);
      if (!Number.isFinite(args.limit) || args.limit < 0) {
        throw new Error("--limit must be a non-negative number");
      }
    } else if (arg === "--search") {
      args.search = String(argv[++i] ?? "").trim();
      if (!args.search) throw new Error("--search requires a non-empty name");
    } else if (arg === "--pick") {
      args.pick = Number(argv[++i]);
      if (!Number.isInteger(args.pick) || args.pick < 1) {
        throw new Error("--pick must be a positive integer");
      }
    } else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/push-ref-entities-to-nocodb.mjs [options]

Bulk-sync German research institutes (Wikidata P31=Q31855, P17=Q183) into
REF_Entities, and backfill missing official_website / official_logo on
existing rows (looked up by wikidata_identifier).

Options:
  --apply           Create/update rows in REF_Entities (default is dry-run)
  --dry-run         Preview only (default)
  --backfill-only   Only fill missing fields on existing rows (no creates)
  --limit <n>       Cap how many create payloads are pushed
  --search <name>   Look up an entity by name in Wikidata and optionally add it
  --pick <n>        With --search, select result n non-interactively
  -h, --help        Show this help

Examples:
  node scripts/push-ref-entities-to-nocodb.mjs
  node scripts/push-ref-entities-to-nocodb.mjs --backfill-only --apply
  node scripts/push-ref-entities-to-nocodb.mjs --limit 25 --apply
  node scripts/push-ref-entities-to-nocodb.mjs --search "FIZ Karlsruhe"
  node scripts/push-ref-entities-to-nocodb.mjs --search "DKRZ" --apply
`);
}

function asString(value) {
  if (value == null) return "";
  return String(value);
}

function emptyToNull(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return value;
}

function userAgent() {
  return (process.env.WIKIDATA_USER_AGENT ?? DEFAULT_USER_AGENT).trim();
}

/** Extract Q-id from entity / wiki URLs or bare ids. */
export function extractQid(value) {
  const raw = asString(value).trim();
  if (!raw) return "";
  const match = raw.match(/\bQ\d+\b/i);
  return match ? match[0].toUpperCase() : "";
}

export function entityUrl(qid) {
  const id = extractQid(qid);
  return id ? `http://www.wikidata.org/entity/${id}` : "";
}

function normalizeNameKey(value) {
  return asString(value)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function preferHttps(url) {
  const raw = asString(url).trim();
  if (!raw) return "";
  if (raw.startsWith("http://commons.wikimedia.org/")) {
    return `https://${raw.slice("http://".length)}`;
  }
  return raw;
}

/** Prefer an English-language official website when several exist. */
function pickWebsite(candidates) {
  const urls = [...new Set(candidates.map((u) => asString(u).trim()).filter(Boolean))];
  if (urls.length === 0) return "";
  const scored = urls.map((url) => {
    let score = 0;
    const lower = url.toLowerCase();
    if (/\/en(\/|$|\?)/.test(lower) || /[?&]lang=en\b/.test(lower)) score += 3;
    if (lower.includes("/en.")) score += 2;
    if (lower.startsWith("https://")) score += 1;
    if (lower.endsWith(".de/") || lower.endsWith(".de")) score -= 0.5;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored[0].url;
}

function pickLogo(candidates) {
  const urls = [
    ...new Set(
      candidates
        .map((u) => preferHttps(u))
        .filter(Boolean)
    ),
  ];
  if (urls.length === 0) return "";
  const scored = urls.map((url) => {
    let score = 0;
    const lower = url.toLowerCase();
    if (lower.endsWith(".svg")) score += 3;
    if (lower.includes("logo")) score += 1;
    if (lower.includes("(en)")) score += 1;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored[0].url;
}

function mergeWikidataBindings(bindings) {
  /** @type {Map<string, { qid: string, name: string, websites: string[], logos: string[] }>} */
  const byQid = new Map();

  for (const binding of bindings) {
    const item = binding?.item?.value ?? "";
    const qid = extractQid(item);
    if (!qid) continue;

    let entry = byQid.get(qid);
    if (!entry) {
      entry = { qid, name: "", websites: [], logos: [] };
      byQid.set(qid, entry);
    }

    const label = asString(binding?.itemLabel?.value).trim();
    if (label && label.toUpperCase() !== qid && !entry.name) {
      entry.name = label;
    } else if (label && label.toUpperCase() !== qid && label.length > entry.name.length) {
      // keep first non-Qid label; ignore longer duplicates
    }

    const website = asString(binding?.website?.value).trim();
    if (website) entry.websites.push(website);

    const logo = asString(binding?.logo?.value).trim();
    if (logo) entry.logos.push(logo);
  }

  return [...byQid.values()]
    .map((entry) => ({
      qid: entry.qid,
      name: entry.name || entry.qid,
      official_website: pickWebsite(entry.websites),
      official_logo: pickLogo(entry.logos),
      wikidata_identifier: entityUrl(entry.qid),
    }))
    .filter((entry) => entry.name && entry.name.toUpperCase() !== entry.qid);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryCount() {
  const n = Number(process.env.FETCH_RETRIES ?? 4);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `FETCH_RETRIES must be a non-negative integer, got: ${process.env.FETCH_RETRIES}`
    );
  }
  return n;
}

async function fetchOkWithRetry(url, options, opts) {
  const retries = opts.retries ?? retryCount();
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOk(url, options, opts);
    } catch (error) {
      lastError = error;
      const msg = String(error?.message ?? error);
      const retriable = /\((429|5\d\d)\)/.test(msg) || /timed out/i.test(msg);
      if (!retriable || attempt >= retries) throw error;
      const delayMs = Math.min(30_000, 1_500 * 2 ** attempt);
      console.warn(
        `retry ${attempt + 1}/${retries} for ${opts.label ?? url} after ${delayMs}ms: ${msg}`
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function sparqlQuery(query, timeoutMs) {
  const url = `${WIKIDATA_SPARQL}?${new URLSearchParams({
    query,
    format: "json",
  })}`;
  const response = await fetchOkWithRetry(
    url,
    {
      headers: {
        Accept: "application/sparql-results+json",
        "User-Agent": userAgent(),
      },
    },
    { timeoutMs, label: "Wikidata SPARQL" }
  );
  try {
    return await response.json();
  } catch (error) {
    throw new Error(`Wikidata SPARQL returned non-JSON: ${error.message}`);
  }
}

/**
 * Fetch all German research institutes with English label + optional website/logo.
 * @returns {Promise<Array<{qid:string,name:string,official_website:string,official_logo:string,wikidata_identifier:string}>>}
 */
export async function fetchGermanResearchInstitutes(timeoutMs = 120_000) {
  const query = `
SELECT ?item ?itemLabel ?website ?logo WHERE {
  ?item wdt:P31 wd:Q31855 ;
        wdt:P17 wd:Q183 .
  OPTIONAL { ?item wdt:P856 ?website . }
  OPTIONAL { ?item wdt:P154 ?logo . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`.trim();

  console.log("Querying Wikidata for German research institutes (P31=Q31855, P17=Q183)…");
  const payload = await sparqlQuery(query, timeoutMs);
  const bindings = Array.isArray(payload?.results?.bindings)
    ? payload.results.bindings
    : [];
  const records = mergeWikidataBindings(bindings);
  console.log(
    `Wikidata returned ${bindings.length} binding(s) → ${records.length} unique labelled item(s)`
  );
  return records;
}

/** Commons Special:FilePath URL for a Wikidata P154 filename. */
function commonsFilePathUrl(filename) {
  const name = asString(filename).trim().replace(/^File:/i, "");
  if (!name) return "";
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(name).replace(/%2F/gi, "/")}`;
}

/**
 * Claim snak values for a property (e.g. P856 / P154).
 * @param {object} entity  wbgetentities entity
 * @param {string} pid
 * @returns {string[]}
 */
function claimStringValues(entity, pid) {
  const claims = entity?.claims?.[pid];
  if (!Array.isArray(claims)) return [];
  const out = [];
  for (const claim of claims) {
    const snak = claim?.mainsnak;
    if (!snak || snak.snaktype !== "value") continue;
    const value = snak.datavalue?.value;
    if (typeof value === "string" && value.trim()) out.push(value.trim());
  }
  return out;
}

/**
 * Fetch name / website / logo for one QID via the Wikidata Action API
 * (wbgetentities) — preferred for single-entity --search lookups.
 * @param {string} qid
 */
export async function fetchEntityByQidViaApi(qid, timeoutMs = 30_000) {
  const id = extractQid(qid);
  if (!id) return null;

  const url = `${WIKIDATA_API}?${new URLSearchParams({
    action: "wbgetentities",
    ids: id,
    props: "labels|claims",
    languages: "en",
    format: "json",
    origin: "*",
  })}`;

  const response = await fetchOkWithRetry(
    url,
    { headers: { "User-Agent": userAgent(), Accept: "application/json" } },
    { timeoutMs, label: `Wikidata entity ${id}` }
  );

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Wikidata entity lookup returned non-JSON: ${error.message}`);
  }

  const entity = payload?.entities?.[id];
  if (!entity || entity.missing != null) return null;

  const label =
    asString(entity.labels?.en?.value).trim() ||
    asString(
      Object.values(entity.labels ?? {})[0]?.value
    ).trim() ||
    id;

  const websites = claimStringValues(entity, "P856");
  const logos = claimStringValues(entity, "P154").map(commonsFilePathUrl);

  return {
    qid: id,
    name: label,
    official_website: pickWebsite(websites),
    official_logo: pickLogo(logos),
    wikidata_identifier: entityUrl(id),
  };
}

/**
 * Fetch name / website / logo for specific QIDs (any entity type) via SPARQL.
 * Used for bulk backfill; single-entity --search uses fetchEntityByQidViaApi.
 * @param {string[]} qids
 */
export async function fetchEntitiesByQids(qids, timeoutMs = 60_000) {
  const unique = [...new Set(qids.map(extractQid).filter(Boolean))];
  if (unique.length === 0) return [];

  /** @type {Array<{qid:string,name:string,official_website:string,official_logo:string,wikidata_identifier:string}>} */
  const out = [];

  for (let i = 0; i < unique.length; i += SPARQL_ENTITY_CHUNK) {
    const chunk = unique.slice(i, i + SPARQL_ENTITY_CHUNK);
    const values = chunk.map((qid) => `wd:${qid}`).join(" ");
    const query = `
SELECT ?item ?itemLabel ?website ?logo WHERE {
  VALUES ?item { ${values} }
  OPTIONAL { ?item wdt:P856 ?website . }
  OPTIONAL { ?item wdt:P154 ?logo . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
`.trim();
    const payload = await sparqlQuery(query, timeoutMs);
    const bindings = Array.isArray(payload?.results?.bindings)
      ? payload.results.bindings
      : [];
    out.push(...mergeWikidataBindings(bindings));
    if (i + SPARQL_ENTITY_CHUNK < unique.length) await sleep(500);
  }

  return out;
}

/**
 * Search Wikidata entities by name (wbsearchentities).
 * @param {string} name
 * @returns {Promise<Array<{qid:string,label:string,description:string,wikidata_identifier:string}>>}
 */
export async function searchWikidataByName(name, { limit = 10, timeoutMs = 30_000 } = {}) {
  const term = asString(name).trim();
  if (!term) return [];

  const url = `${WIKIDATA_API}?${new URLSearchParams({
    action: "wbsearchentities",
    search: term,
    language: "en",
    uselang: "en",
    type: "item",
    limit: String(Math.min(Math.max(limit, 1), 50)),
    format: "json",
    origin: "*",
  })}`;

  const response = await fetchOkWithRetry(
    url,
    { headers: { "User-Agent": userAgent(), Accept: "application/json" } },
    { timeoutMs, label: `Wikidata search "${term}"` }
  );

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`Wikidata search returned non-JSON: ${error.message}`);
  }

  const hits = Array.isArray(payload?.search) ? payload.search : [];
  return hits.map((hit) => {
    const qid = extractQid(hit.id || hit.title);
    return {
      qid,
      label: asString(hit.label).trim() || qid,
      description: asString(hit.description).trim(),
      wikidata_identifier: entityUrl(qid),
    };
  }).filter((hit) => hit.qid);
}

function normalizeEntityRecord(raw) {
  return {
    id: raw.id ?? null,
    name: asString(raw.name).trim(),
    wikidata_identifier: asString(raw.wikidata_identifier).trim(),
    official_website: asString(raw.official_website).trim(),
    official_logo: asString(raw.official_logo).trim(),
    qid: extractQid(raw.wikidata_identifier),
  };
}

function toCreatePayload(record) {
  const payload = {};
  for (const field of WRITE_FIELDS) {
    payload[field] = emptyToNull(asString(record[field]).trim());
  }
  return payload;
}

function buildBackfillPatch(wikiRecord, nocoRecord) {
  const patch = {};
  for (const field of BACKFILL_FIELDS) {
    if (asString(nocoRecord[field]).trim()) continue;
    const value = asString(wikiRecord[field]).trim();
    if (value) patch[field] = value;
  }
  if (Object.keys(patch).length === 0) return null;
  return { id: nocoRecord.id, ...patch };
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

async function createInBatches(ctx, payloads) {
  let createdCount = 0;
  for (let i = 0; i < payloads.length; i += CREATE_BATCH_SIZE) {
    const batch = payloads.slice(i, i + CREATE_BATCH_SIZE);
    const created = await createRecords({ ...ctx, records: batch });
    const n = Array.isArray(created)
      ? created.length
      : Array.isArray(created?.list)
        ? created.list.length
        : batch.length;
    createdCount += n;
    console.log(`  created batch ${i / CREATE_BATCH_SIZE + 1}: ${n}`);
  }
  return createdCount;
}

async function updateInBatches(ctx, patches) {
  let updatedCount = 0;
  for (let i = 0; i < patches.length; i += UPDATE_BATCH_SIZE) {
    const batch = patches.slice(i, i + UPDATE_BATCH_SIZE);
    const updated = await updateRecords({ ...ctx, records: batch });
    const n = Array.isArray(updated)
      ? updated.length
      : Array.isArray(updated?.list)
        ? updated.list.length
        : batch.length;
    updatedCount += n;
    console.log(`  updated batch ${i / UPDATE_BATCH_SIZE + 1}: ${n}`);
  }
  return updatedCount;
}

function indexNocoRecords(records) {
  /** @type {Map<string, object>} */
  const byQid = new Map();
  /** @type {Map<string, object>} */
  const byName = new Map();

  for (const record of records) {
    if (record.qid) byQid.set(record.qid, record);
    const nameKey = normalizeNameKey(record.name);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, record);
  }

  return { byQid, byName };
}

function findExisting(indexes, wikiRecord) {
  if (wikiRecord.qid && indexes.byQid.has(wikiRecord.qid)) {
    return indexes.byQid.get(wikiRecord.qid);
  }
  const nameKey = normalizeNameKey(wikiRecord.name);
  if (nameKey && indexes.byName.has(nameKey)) {
    return indexes.byName.get(nameKey);
  }
  return null;
}

async function promptYesNo(rl, question, { defaultNo = true } = {}) {
  if (!rl) return !defaultNo;
  while (true) {
    const answer = (await rl.question(question)).trim().toLowerCase();
    if (["y", "yes"].includes(answer)) return true;
    if (["n", "no"].includes(answer)) return false;
    if (answer === "") return !defaultNo;
    console.log("Please answer y or n.");
  }
}

/**
 * Interactive (or --apply / --pick) search: find a Wikidata entity by name and
 * optionally insert/backfill it in REF_Entities.
 *
 * @param {{
 *   name: string,
 *   apply: boolean,
 *   pick?: number|null,
 *   baseUrl: string,
 *   tableId: string,
 *   token: string,
 *   timeoutMs: number,
 *   nocoRecords: object[],
 * }} opts
 */
export async function searchAndMaybeAddEntity(opts) {
  const {
    name,
    apply,
    pick = null,
    baseUrl,
    tableId,
    token,
    timeoutMs,
    nocoRecords,
  } = opts;

  const hits = await searchWikidataByName(name, { limit: 10, timeoutMs });
  if (hits.length === 0) {
    console.log(`No Wikidata hits for "${name}".`);
    return { action: "none", reason: "no-hits" };
  }

  console.log(`\nWikidata search results for "${name}":`);
  hits.forEach((hit, idx) => {
    const desc = hit.description ? ` — ${hit.description}` : "";
    console.log(`  [${idx + 1}] ${hit.label} (${hit.qid})${desc}`);
    console.log(`      ${hit.wikidata_identifier}`);
  });

  const interactive = Boolean(input.isTTY && output.isTTY);
  const rl = interactive ? createInterface({ input, output }) : null;

  try {
    let choice = pick;
    if (choice == null) {
      if (!rl) {
        console.log(
          "\nNon-interactive stdin: pass --pick <n> to select a result" +
            (apply ? " (with --apply)." : ".")
        );
        return { action: "needs-pick", hits };
      }
      const choiceRaw = await rl.question(
        `\nPick a result 1-${hits.length} (or Enter to cancel): `
      );
      choice = Number(choiceRaw);
    }

    if (!Number.isInteger(choice) || choice < 1 || choice > hits.length) {
      console.log("Cancelled.");
      return { action: "cancelled" };
    }

    const selected = hits[choice - 1];
    const details = await fetchEntityByQidViaApi(selected.qid, timeoutMs);
    const wiki =
      details ??
      {
        qid: selected.qid,
        name: selected.label,
        official_website: "",
        official_logo: "",
        wikidata_identifier: selected.wikidata_identifier,
      };

    // Prefer the search label if the API returned only the Q-id fallback.
    if (!wiki.name || wiki.name.toUpperCase() === wiki.qid) {
      wiki.name = selected.label;
    }

    console.log("\nCandidate for REF_Entities:");
    console.log(`  name:                ${wiki.name}`);
    console.log(`  wikidata_identifier: ${wiki.wikidata_identifier}`);
    console.log(`  official_website:    ${wiki.official_website || "(empty)"}`);
    console.log(`  official_logo:       ${wiki.official_logo || "(empty)"}`);

    const indexes = indexNocoRecords(nocoRecords);
    const existing = findExisting(indexes, wiki);

    if (existing) {
      console.log(
        `\nAlready present in REF_Entities as id=${existing.id} name=${JSON.stringify(existing.name)}`
      );
      const patch = buildBackfillPatch(wiki, existing);
      if (!patch) {
        console.log("No missing website/logo fields to fill.");
        return { action: "exists", id: existing.id };
      }
      console.log(
        `Would backfill: ${Object.keys(patch)
          .filter((k) => k !== "id")
          .join(", ")}`
      );
      if (!apply) {
        const confirmed = await promptYesNo(
          rl,
          "Apply this backfill to REF_Entities? [y/N] "
        );
        if (!confirmed) {
          console.log(
            rl
              ? "Skipped update."
              : "Dry-run only. Re-run with --apply --pick <n> to update."
          );
          return { action: "skipped-update", id: existing.id, patch };
        }
      }
      if (!token) throw new Error("NOCODB_API_TOKEN is required to update");
      await updateRecords({
        baseUrl,
        tableId,
        token,
        records: [patch],
        timeoutMs,
      });
      console.log(`Updated REF_Entities id=${existing.id}`);
      return { action: "updated", id: existing.id, patch };
    }

    const payload = toCreatePayload(wiki);
    if (!apply) {
      const confirmed = await promptYesNo(
        rl,
        "Insert this entity into REF_Entities? [y/N] "
      );
      if (!confirmed) {
        console.log(
          rl
            ? "Skipped create."
            : "Dry-run only. Re-run with --apply --pick <n> to insert."
        );
        return { action: "skipped-create", payload };
      }
    }
    if (!token) throw new Error("NOCODB_API_TOKEN is required to create");
    const created = await createRecords({
      baseUrl,
      tableId,
      token,
      records: [payload],
      timeoutMs,
    });
    const createdRow = Array.isArray(created)
      ? created[0]
      : Array.isArray(created?.list)
        ? created.list[0]
        : created;
    console.log(
      `Created REF_Entities row${createdRow?.id != null ? ` id=${createdRow.id}` : ""}.`
    );
    return { action: "created", payload, created: createdRow };
  } finally {
    rl?.close();
  }
}

async function runBulkSync(args, ctx) {
  const { baseUrl, tableId, viewId, token, pageSize, timeoutMs } = ctx;

  const raw = await fetchNocoDbRecords({
    baseUrl,
    tableId,
    viewId,
    token,
    pageSize,
    timeoutMs,
  });
  const nocoRecords = raw.map(normalizeEntityRecord);
  console.log(`Fetched ${nocoRecords.length} REF_Entities row(s) from ${baseUrl}`);

  const indexes = indexNocoRecords(nocoRecords);

  // Always enrich existing rows from their Wikidata ids (even if not P31=Q31855).
  const existingQids = nocoRecords.map((r) => r.qid).filter(Boolean);
  const existingWiki = await fetchEntitiesByQids(existingQids, timeoutMs);
  const wikiByQid = new Map(existingWiki.map((r) => [r.qid, r]));

  /** @type {Array<{name:string,id:number|string,patch:object}>} */
  const plannedUpdates = [];
  for (const noco of nocoRecords) {
    if (noco.id == null || !noco.qid) continue;
    const wiki = wikiByQid.get(noco.qid);
    if (!wiki) continue;
    const patch = buildBackfillPatch(wiki, noco);
    if (!patch) continue;
    plannedUpdates.push({
      name: noco.name || wiki.name,
      id: noco.id,
      patch,
    });
  }

  /** @type {Array<{name:string,qid:string,payload:object}>} */
  let plannedCreates = [];
  if (!args.backfillOnly) {
    const institutes = await fetchGermanResearchInstitutes(
      Math.max(timeoutMs, 120_000)
    );
    for (const wiki of institutes) {
      const existing = findExisting(indexes, wiki);
      if (existing) {
        // Also catch institute-driven backfills that VALUES lookup missed.
        if (existing.id != null) {
          const patch = buildBackfillPatch(wiki, existing);
          if (
            patch &&
            !plannedUpdates.some((u) => u.id === existing.id)
          ) {
            plannedUpdates.push({
              name: existing.name || wiki.name,
              id: existing.id,
              patch,
            });
          }
        }
        continue;
      }
      plannedCreates.push({
        name: wiki.name,
        qid: wiki.qid,
        payload: toCreatePayload(wiki),
      });
      // Prevent duplicate creates within the same run (alias collisions).
      indexes.byQid.set(wiki.qid, {
        id: null,
        name: wiki.name,
        qid: wiki.qid,
      });
      const nameKey = normalizeNameKey(wiki.name);
      if (nameKey) indexes.byName.set(nameKey, { id: null, name: wiki.name, qid: wiki.qid });
    }
  }

  const limitedCreates =
    args.limit == null ? plannedCreates : plannedCreates.slice(0, args.limit);

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    table_id: tableId,
    backfill_only: args.backfillOnly,
    planned_at: new Date().toISOString(),
    totals: {
      nocodb: nocoRecords.length,
      missing_from_nocodb: plannedCreates.length,
      will_create: limitedCreates.length,
      will_update: plannedUpdates.length,
      existing_with_qid: existingQids.length,
      existing_resolved_from_wikidata: existingWiki.length,
    },
    creates: limitedCreates.slice(0, 200).map((item) => ({
      name: item.name,
      qid: item.qid,
      official_website: item.payload.official_website,
      official_logo: item.payload.official_logo,
    })),
    creates_truncated: limitedCreates.length > 200,
    updates: plannedUpdates,
  };

  const reportPath = join(repoRoot, "data/parsed/ref-entities.push-report.json");
  writeJson(reportPath, report);

  console.log(
    `\n${report.mode}: ${limitedCreates.length}/${plannedCreates.length} create(s), ` +
      `${plannedUpdates.length} update(s)` +
      (args.backfillOnly ? " [backfill-only]" : "")
  );

  const previewCreates = limitedCreates.slice(0, 20);
  for (const item of previewCreates) {
    console.log(
      `  + ${item.name} (${item.qid})` +
        (item.payload.official_website ? "" : " [no website]") +
        (item.payload.official_logo ? "" : " [no logo]")
    );
  }
  if (limitedCreates.length > previewCreates.length) {
    console.log(`  … ${limitedCreates.length - previewCreates.length} more create(s)`);
  }

  for (const item of plannedUpdates) {
    const fields = Object.keys(item.patch).filter((k) => k !== "id");
    console.log(`  ~ ${item.name} (id ${item.id}) ← ${fields.join(", ")}`);
  }
  console.log(`Wrote ${reportPath}`);

  if (!args.apply) {
    console.log("Dry-run only. Re-run with --apply to create/update rows.");
    console.log(
      "Tip: use --backfill-only --apply to fill website/logo on the existing 18 rows first."
    );
    return;
  }

  if (limitedCreates.length === 0 && plannedUpdates.length === 0) {
    console.log("Nothing to create or update.");
    return;
  }

  const writeCtx = { baseUrl, tableId, token, timeoutMs };

  if (plannedUpdates.length > 0) {
    const updatedCount = await updateInBatches(
      writeCtx,
      plannedUpdates.map((item) => item.patch)
    );
    console.log(`Updated ${updatedCount} REF_Entities row(s).`);
  }

  if (limitedCreates.length > 0) {
    const createdCount = await createInBatches(
      writeCtx,
      limitedCreates.map((item) => item.payload)
    );
    console.log(`Created ${createdCount} REF_Entities row(s).`);
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
  if (!token) {
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
    process.env.NOCODB_REF_ENTITIES_TABLE_ID ?? DEFAULT_TABLE_ID;
  const viewId = (process.env.NOCODB_REF_ENTITIES_VIEW_ID ?? "").trim();
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

  const ctx = { baseUrl, tableId, viewId, token, pageSize, timeoutMs };

  if (args.search) {
    const raw = await fetchNocoDbRecords({
      baseUrl,
      tableId,
      viewId,
      token,
      pageSize,
      timeoutMs,
    });
    const nocoRecords = raw.map(normalizeEntityRecord);
    await searchAndMaybeAddEntity({
      name: args.search,
      apply: args.apply,
      pick: args.pick,
      baseUrl,
      tableId,
      token,
      timeoutMs,
      nocoRecords,
    });
    return;
  }

  await runBulkSync(args, ctx);
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

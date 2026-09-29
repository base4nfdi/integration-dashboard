#!/usr/bin/env node
/**
 * PATCH official_logo on existing NocoDB REF_Partners rows.
 *
 * Fills blank cells only (never overwrites). Candidate URLs come from:
 *   1. Wikidata P154 via the row's wikidata_identifier
 *   2. Name-matched remote logo_consortia from parsed incubator sources
 *      (and static/data.json after reversing cached local paths)
 *   3. Zenodo community logos from communities.csv (zenodo-analyzer),
 *      matched by title or community slug — events and working-group
 *      communities are ignored
 *
 * Combined / project logos are ignored: a dashboard logo is used only when
 * the incubator row has exactly one partner and the URL contains that
 * partner's slug.
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_PARTNERS_TABLE_ID  — default pf8ggs9jduxse4x (REF_Partners)
 *   NOCODB_PARTNERS_VIEW_ID   — default empty (full table)
 *   NOCODB_PAGE_SIZE, FETCH_TIMEOUT_MS, WIKIDATA_USER_AGENT
 *   ZENODO_COMMUNITIES_CSV — default ../../zenodo-analyzer/communities.csv
 *
 * Usage:
 *   node scripts/patch-ref-partners-logos.mjs
 *   node scripts/patch-ref-partners-logos.mjs --apply
 *   node scripts/patch-ref-partners-logos.mjs --limit 10 --apply
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchNocoDbRecords,
  fetchOk,
  parsePositiveInt,
} from "./lib/http-utils.mjs";
import { isRemoteLogoUrl } from "./lib/logo-cache.mjs";
import {
  loadNocoDbRecords,
  normalizePartnerName,
  readJson,
  repoRoot,
  writeJson,
} from "./lib/parse-utils.mjs";
import {
  extractQid,
  fetchEntitiesByQids,
} from "./push-ref-entities-to-nocodb.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TABLE_ID = "pf8ggs9jduxse4x";
const UPDATE_BATCH_SIZE = 25;
const GENERIC_LOGO_HOSTS = new Set([
  "dmp.services.base4nfdi.de",
  "incubators.nfdi-aai.de",
  "github.com",
  "gitlab.com",
  "gitlab.ub.uni-bielefeld.de",
]);

const PARSED_FILES = [
  join(repoRoot, "data/parsed/dmp4nfdi.json"),
  join(repoRoot, "data/parsed/iam4nfdi.json"),
  join(repoRoot, "data/parsed/ts4nfdi.json"),
  join(repoRoot, "data/parsed/pid4nfdi.json"),
];

const DATA_JSON = join(repoRoot, "static/data.json");
const LOGO_MANIFEST = join(repoRoot, "static/img/partner-logos/manifest.json");
const DEFAULT_ZENODO_CSV = join(
  repoRoot,
  "../../zenodo-analyzer/communities.csv"
);

/**
 * Zenodo slugs whose community title is not the partner's canonical name.
 * Events / CC / WG communities are not listed here.
 */
const ZENODO_SLUG_ALIASES = {
  nfdi4ds: "NFDI4DataScience",
  punch4nfdi: "PUNCH4NFDI",
  fairmat_nfdi: "FAIRmat",
  nfdi4plants: "DataPLANT",
  textplus_nfdi: "Text+",
  nfdi4biodiv: "NFDI4Biodiversity",
  "nfdi-fairagro": "FAIRagro",
  "nfdi-matwerk": "NFDI-MatWerk",
  "berd-nfdi": "BERD@NFDI",
};

const ZENODO_SKIP_TITLE =
  /\b(conference|plenary|summer school|hackathon|user conference)\b|\bCC\b|\bWG\b/i;

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
    limit: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
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
  node scripts/patch-ref-partners-logos.mjs [options]

Fill blank official_logo on REF_Partners from Wikidata P154, then from
name-matched remote consortium logos already used in dashboard sources,
then from Zenodo community logos in communities.csv.
Existing official_logo values are never overwritten.

Options:
  --apply        PATCH NocoDB (default is dry-run)
  --dry-run      Preview only (default)
  --limit <n>    Cap how many row updates are applied
  -h, --help     Show this help

Examples:
  node scripts/patch-ref-partners-logos.mjs
  node scripts/patch-ref-partners-logos.mjs --apply
  node scripts/patch-ref-partners-logos.mjs --limit 10 --apply
`);
}

function asString(value) {
  if (value == null) return "";
  return String(value).replace(/\r/g, "").trim();
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => asString(item)).filter(Boolean);
}

function preferHttps(url) {
  const raw = asString(url);
  if (!raw) return "";
  if (raw.startsWith("http://commons.wikimedia.org/")) {
    return `https://${raw.slice("http://".length)}`;
  }
  return raw;
}

/**
 * Lookup keys for a consortium name (aliases, compact form, NFDI- prefix).
 * @param {string} name
 * @returns {string[]}
 */
function partnerLookupKeys(name) {
  const raw = asString(name);
  if (!raw) return [];

  const keys = new Set();
  const add = (value) => {
    const v = asString(value).toLowerCase();
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

/**
 * Filename / URL tokens used to decide whether a logo belongs to a partner.
 * @param {string} name
 * @returns {string[]}
 */
function logoMatchTokens(name) {
  const tokens = new Set();
  for (const key of partnerLookupKeys(name)) {
    tokens.add(key);
    tokens.add(key.replace(/[^a-z0-9+]/g, ""));
    tokens.add(key.replace(/\+/g, "plus"));
    tokens.add(key.replace(/\+/g, "-plus-"));
    tokens.add(key.replace(/\+/g, "-plus"));
    tokens.add(key.replace(/@/g, ""));
    tokens.add(key.replace(/@nfdi$/i, ""));
  }
  return [...tokens].filter((token) => token.length >= 4);
}

function urlHaystack(url) {
  const raw = asString(url).toLowerCase();
  return {
    raw,
    compact: raw.replace(/[^a-z0-9+]/g, ""),
  };
}

function logoMatchesPartner(url, partnerName) {
  const hay = urlHaystack(url);
  for (const token of logoMatchTokens(partnerName)) {
    const compact = token.replace(/[^a-z0-9+]/g, "");
    if (token && hay.raw.includes(token)) return true;
    if (compact.length >= 4 && hay.compact.includes(compact)) return true;
  }
  return false;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function websiteHost(officialWebsite) {
  return hostOf(officialWebsite);
}

/**
 * Score a dashboard logo URL. Higher is better.
 * @param {string} url
 * @param {string} partnerName
 * @param {string} officialWebsite
 */
function scoreDashboardLogo(url, partnerName, officialWebsite) {
  let score = 0;
  const lower = url.toLowerCase();
  const host = hostOf(url);
  const ownHost = websiteHost(officialWebsite);
  const slugHost = logoMatchTokens(partnerName).some(
    (token) => host && host.replace(/[^a-z0-9]/g, "").includes(token.replace(/[^a-z0-9]/g, ""))
  );

  if (ownHost && host === ownHost) score += 10;
  else if (slugHost && !GENERIC_LOGO_HOSTS.has(host)) score += 5;
  if (lower.endsWith(".svg")) score += 3;
  if (lower.includes("logo")) score += 1;
  if (GENERIC_LOGO_HOSTS.has(host)) score -= 5;
  return score;
}

function pickDashboardLogo(urls, partnerName, officialWebsite) {
  const unique = [...new Set(urls.map(preferHttps).filter(isRemoteLogoUrl))];
  if (unique.length === 0) return "";
  const scored = unique.map((url) => ({
    url,
    score: scoreDashboardLogo(url, partnerName, officialWebsite),
  }));
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored[0].url;
}

function loadLogoManifestReverse() {
  /** @type {Map<string, string>} */
  const pathToSource = new Map();
  if (!existsSync(LOGO_MANIFEST)) return pathToSource;
  const manifest = readJson(LOGO_MANIFEST);
  for (const [sourceUrl, entry] of Object.entries(manifest)) {
    if (!isRemoteLogoUrl(sourceUrl)) continue;
    const path = asString(entry?.path);
    if (!path) continue;
    const trimmed = path.replace(/^\//, "");
    pathToSource.set(path, sourceUrl);
    pathToSource.set(trimmed, sourceUrl);
    pathToSource.set(`/${trimmed}`, sourceUrl);
  }
  return pathToSource;
}

function resolveRemoteLogo(value, pathToSource) {
  const raw = asString(value);
  if (!raw) return "";
  if (isRemoteLogoUrl(raw)) return preferHttps(raw);
  return pathToSource.get(raw) || pathToSource.get(raw.replace(/^\//, "")) || "";
}

function indexDashboardLogos(pathToSource) {
  /** @type {Map<string, Set<string>>} */
  const byKey = new Map();

  const add = (partnerName, url) => {
    const remote = resolveRemoteLogo(url, pathToSource);
    if (!remote || !logoMatchesPartner(remote, partnerName)) return;
    for (const key of partnerLookupKeys(partnerName)) {
      let set = byKey.get(key);
      if (!set) {
        set = new Set();
        byKey.set(key, set);
      }
      set.add(remote);
    }
  };

  const ingestRecords = (records) => {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      const partners = asStringList(record?.partners);
      const logo = asString(record?.logo_consortia);
      if (partners.length !== 1 || !logo) continue;
      add(partners[0], logo);
    }
  };

  for (const file of PARSED_FILES) {
    if (!existsSync(file)) continue;
    const parsed = readJson(file);
    ingestRecords(parsed?.records);
  }

  ingestRecords(loadNocoDbRecords(DATA_JSON));

  return byKey;
}

function lookupDashboardUrls(index, partnerName) {
  const urls = new Set();
  for (const key of partnerLookupKeys(partnerName)) {
    const set = index.get(key);
    if (!set) continue;
    for (const url of set) urls.add(url);
  }
  return [...urls];
}

/**
 * Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF).
 * @param {string} text
 * @returns {Array<Record<string, string>>}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const src = String(text ?? "").replace(/^\uFEFF/, "");

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = (rows.shift() ?? []).map((cell) => cell.trim());
  return rows
    .filter((cells) => cells.some((cell) => cell.trim()))
    .map((cells) => {
      /** @type {Record<string, string>} */
      const record = {};
      header.forEach((name, index) => {
        if (name) record[name] = cells[index] ?? "";
      });
      return record;
    });
}

function zenodoSlug(url) {
  const match = asString(url).match(/\/communities\/([^/?#]+)\/?$/i);
  return match ? decodeURIComponent(match[1]).toLowerCase() : "";
}

function zenodoCsvPath() {
  const fromEnv = asString(process.env.ZENODO_COMMUNITIES_CSV);
  return fromEnv ? resolve(fromEnv) : DEFAULT_ZENODO_CSV;
}

function keysOverlap(leftName, rightName) {
  const right = new Set(partnerLookupKeys(rightName));
  return partnerLookupKeys(leftName).some((key) => right.has(key));
}

/**
 * Load Zenodo community logos that can stand in for a consortium.
 * Conferences, plenaries, and CC/WG communities are dropped.
 * @returns {Array<{title:string,slug:string,logo:string,alias:string}>}
 */
function loadZenodoCommunities() {
  const path = zenodoCsvPath();
  if (!existsSync(path)) {
    console.warn(`Zenodo communities CSV not found (${path}); skipping that source`);
    return [];
  }

  const rows = parseCsv(readFileSync(path, "utf8"));
  const communities = [];
  for (const row of rows) {
    const title = asString(row.title);
    const logo = preferHttps(asString(row.logo_url || row.logo));
    const slug = zenodoSlug(row.zenodo_url);
    if (!title || !isRemoteLogoUrl(logo) || ZENODO_SKIP_TITLE.test(title)) continue;
    communities.push({
      title,
      slug,
      logo,
      alias: ZENODO_SLUG_ALIASES[slug] ?? "",
    });
  }
  console.log(
    `Loaded ${communities.length} Zenodo community logo(s) from ${path}`
  );
  return communities;
}

/**
 * Pick a Zenodo logo whose community title or slug names this partner.
 * @param {Array<{title:string,slug:string,logo:string,alias:string}>} communities
 * @param {string} partnerName
 */
function pickZenodoLogo(communities, partnerName) {
  /** @type {Array<{logo:string,score:number,title:string}>} */
  const hits = [];
  for (const community of communities) {
    let score = 0;
    if (keysOverlap(community.title, partnerName)) score = 100;
    else if (community.alias && keysOverlap(community.alias, partnerName)) score = 80;
    if (score === 0) continue;
    hits.push({ logo: community.logo, score, title: community.title });
  }
  if (hits.length === 0) return "";
  hits.sort(
    (a, b) => b.score - a.score || a.title.length - b.title.length || a.logo.localeCompare(b.logo)
  );
  return hits[0].logo;
}

function normalizePartnerRow(raw) {
  return {
    id: raw.id ?? null,
    name: asString(raw.name),
    official_logo: asString(raw.official_logo),
    wikidata_identifier: asString(raw.wikidata_identifier),
    qid: extractQid(raw.wikidata_identifier),
  };
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
    process.env.NOCODB_PARTNERS_TABLE_ID ?? DEFAULT_TABLE_ID;
  const viewId = (process.env.NOCODB_PARTNERS_VIEW_ID ?? "").trim();
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

  const rawRows = await fetchNocoDbRecords({
    baseUrl,
    tableId,
    viewId,
    token,
    pageSize,
    timeoutMs,
  });
  const partners = rawRows.map(normalizePartnerRow);
  console.log(`Fetched ${partners.length} REF_Partners row(s) from ${baseUrl}`);

  const missing = partners.filter((row) => row.id != null && !row.official_logo);
  const alreadyFilled = partners.length - missing.length;
  console.log(
    `${alreadyFilled} already have official_logo; ${missing.length} blank`
  );

  const qids = [...new Set(missing.map((row) => row.qid).filter(Boolean))];
  /** @type {Map<string, {qid:string,name:string,official_website:string,official_logo:string}>} */
  const wikiByQid = new Map();
  if (qids.length > 0) {
    console.log(`Looking up Wikidata P154 for ${qids.length} Q-id(s)…`);
    const wikiRows = await fetchEntitiesByQids(qids, timeoutMs);
    for (const wiki of wikiRows) {
      if (wiki.qid) wikiByQid.set(wiki.qid, wiki);
    }
    const withLogo = wikiRows.filter((row) => row.official_logo).length;
    console.log(
      `Wikidata returned ${wikiRows.length} item(s), ${withLogo} with P154 logo`
    );
  }

  const pathToSource = loadLogoManifestReverse();
  const dashboardIndex = indexDashboardLogos(pathToSource);
  const zenodoCommunities = loadZenodoCommunities();

  /** @type {Array<{id:number|string,name:string,official_logo:string,source:string,wikidata_logo:string,dashboard_logo:string,zenodo_logo:string}>} */
  const planned = [];
  const skipped = [];

  for (const row of partners) {
    if (row.id == null) {
      skipped.push({ name: row.name, reason: "missing_id" });
      continue;
    }
    if (row.official_logo) {
      skipped.push({
        id: row.id,
        name: row.name,
        reason: "already_filled",
        official_logo: row.official_logo,
      });
      continue;
    }

    const wiki = row.qid ? wikiByQid.get(row.qid) : null;
    const wikiLogo = preferHttps(wiki?.official_logo ?? "");
    const dashboardUrls = lookupDashboardUrls(dashboardIndex, row.name);
    const dashboardLogo = pickDashboardLogo(
      dashboardUrls,
      row.name,
      wiki?.official_website ?? ""
    );

    const zenodoLogo = wikiLogo || dashboardLogo
      ? ""
      : pickZenodoLogo(zenodoCommunities, row.name);
    const official_logo = wikiLogo || dashboardLogo || zenodoLogo;
    const source = wikiLogo ? "wikidata" : dashboardLogo ? "dashboard" : "zenodo";
    if (!official_logo) {
      skipped.push({
        id: row.id,
        name: row.name,
        reason: "no_candidate",
        qid: row.qid || "",
      });
      continue;
    }

    planned.push({
      id: row.id,
      name: row.name,
      official_logo,
      source,
      wikidata_logo: wikiLogo,
      dashboard_logo: dashboardLogo,
      zenodo_logo: zenodoLogo,
    });
  }

  const limited =
    args.limit == null ? planned : planned.slice(0, args.limit);

  const report = {
    mode: args.apply ? "apply" : "dry-run",
    table_id: tableId,
    planned_at: new Date().toISOString(),
    totals: {
      nocodb: partners.length,
      already_filled: alreadyFilled,
      blank: missing.length,
      to_patch: planned.length,
      will_patch: limited.length,
      skipped: skipped.length,
      by_source: {
        wikidata: planned.filter((row) => row.source === "wikidata").length,
        dashboard: planned.filter((row) => row.source === "dashboard").length,
        zenodo: planned.filter((row) => row.source === "zenodo").length,
      },
    },
    updates: limited,
    skipped,
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/ref-partners-logos.push-report.json"
  );
  writeJson(reportPath, report);

  console.log(
    `rows=${limited.length}/${planned.length} skipped=${skipped.length} mode=${report.mode}`
  );
  for (const row of limited) {
    console.log(`  #${row.id} ${row.name} [${row.source}]`);
    console.log(`      + ${row.official_logo}`);
  }
  const unmatched = skipped.filter((row) => row.reason === "no_candidate");
  if (unmatched.length > 0) {
    console.log(`No candidate for ${unmatched.length} row(s):`);
    for (const row of unmatched) {
      console.log(`  #${row.id} ${row.name}`);
    }
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

  let updated = 0;
  for (let i = 0; i < limited.length; i += UPDATE_BATCH_SIZE) {
    const batch = limited.slice(i, i + UPDATE_BATCH_SIZE).map((row) => ({
      id: row.id,
      official_logo: row.official_logo,
    }));
    await updateRecords({
      baseUrl,
      tableId,
      token,
      records: batch,
      timeoutMs,
    });
    updated += batch.length;
    console.log(
      `Updated batch ${i / UPDATE_BATCH_SIZE + 1}: ${batch.length} row(s)`
    );
  }

  console.log(`\nDone. Patched official_logo on ${updated} REF_Partners row(s).`);
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

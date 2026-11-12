#!/usr/bin/env node
/**
 * Cache official logos and websites from NocoDB REF_Partners and REF_Entities.
 *
 * Writes static/ref-directory.json (name → local logo path + official_website)
 * and downloads images into static/img/ref-logos/. A logo is downloaded again
 * only when its URL changes or the NocoDB updated_at is newer than the copy
 * already recorded in the directory.
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_PARTNERS_TABLE_ID   — default pf8ggs9jduxse4x
 *   NOCODB_REF_ENTITIES_TABLE_ID — default 7v80fm7p5jpa7xj
 *   NOCODB_PAGE_SIZE, FETCH_TIMEOUT_MS, FETCH_RETRIES
 *
 * Usage:
 *   node scripts/sync-ref-directory.mjs
 *   node scripts/sync-ref-directory.mjs --dry-run
 *   node scripts/sync-ref-directory.mjs --force
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNocoDbRecords, fetchOk, parsePositiveInt } from "./lib/http-utils.mjs";
import { ensureLocalLogo } from "./lib/logo-cache.mjs";
import { normalizePartnerName, repoRoot, writeJson } from "./lib/parse-utils.mjs";

const PARTNERS_TABLE_ID = "pf8ggs9jduxse4x";
const ENTITIES_TABLE_ID = "7v80fm7p5jpa7xj";
const DIRECTORY_PATH = join(repoRoot, "static/ref-directory.json");

/** Project homepages that are not REF_Partners or REF_Entities rows. */
const PROJECT_SITES = [
  {
    name: "AIMS",
    website: "https://www.aims-projekt.de/",
  },
  {
    name: "Sensor Management System",
    website: "https://helmholtz.software/software/sensor-management-system",
    aliases: ["SensorCV", "SMS"],
  },
];
const LOGO_DIR = join(repoRoot, "static/img/ref-logos");
const SITE_PREFIX = "img/ref-logos";

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
  const args = { dryRun: false, force: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/sync-ref-directory.mjs [--dry-run] [--force]

Fetch REF_Partners and REF_Entities official_logo / official_website values,
cache logos under static/img/ref-logos/, and write static/ref-directory.json.
Re-downloads a logo when its URL or NocoDB updated_at changed.
`);
}

function asString(value) {
  if (value == null) return "";
  return String(value).replace(/\r/g, "").trim();
}

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
  if (/^nfdi[- ]?/i.test(raw)) add(raw.replace(/^nfdi[- ]?/i, ""));
  else {
    add(`NFDI-${raw}`);
    add(`NFDI${raw}`);
  }
  return [...keys];
}

function entityLookupKeys(name) {
  const raw = asString(name);
  if (!raw) return [];
  const keys = new Set([raw.toLowerCase()]);
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (compact) keys.add(compact);
  return [...keys];
}

function loadPrevious() {
  if (!existsSync(DIRECTORY_PATH)) return { partners: {}, entities: {}, projects: {} };
  try {
    const payload = JSON.parse(readFileSync(DIRECTORY_PATH, "utf8"));
    return {
      partners: payload?.partners && typeof payload.partners === "object" ? payload.partners : {},
      entities: payload?.entities && typeof payload.entities === "object" ? payload.entities : {},
      projects: payload?.projects && typeof payload.projects === "object" ? payload.projects : {},
    };
  } catch {
    return { partners: {}, entities: {}, projects: {} };
  }
}

function addProjectKeys(byKey, entry, aliases) {
  const keys = new Set([entry.name, ...aliases]);
  for (const alias of [...keys]) {
    const raw = asString(alias);
    if (!raw) continue;
    keys.add(raw.toLowerCase());
    const compact = raw.toLowerCase().replace(/[^a-z0-9@+]/g, "");
    if (compact) keys.add(compact);
  }
  for (const key of keys) {
    if (!byKey[key]) byKey[key] = entry;
  }
}

function projectDirectory(previousProjects) {
  const byKey = {};
  const seeded = new Set(PROJECT_SITES.map((site) => site.name));
  const seen = new Set();
  for (const entry of Object.values(previousProjects ?? {})) {
    const name = asString(entry?.name);
    if (!name || seen.has(name) || seeded.has(name)) continue;
    seen.add(name);
    addProjectKeys(
      byKey,
      {
        name,
        logo: asString(entry.logo),
        website: asString(entry.website),
        source_logo: asString(entry.source_logo),
        updated_at: asString(entry.updated_at),
      },
      []
    );
  }
  for (const site of PROJECT_SITES) {
    addProjectKeys(
      byKey,
      {
        name: site.name,
        logo: "",
        website: site.website,
        source_logo: "",
        updated_at: "",
      },
      site.aliases ?? []
    );
  }
  return byKey;
}

function loadManifest() {
  const path = join(LOGO_DIR, "manifest.json");
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveManifest(manifest) {
  mkdirSync(LOGO_DIR, { recursive: true });
  writeFileSync(join(LOGO_DIR, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
}

/**
 * Special:FilePath is rate-limited. Ask the Commons API for the upload URL.
 * @param {string} url
 * @param {number} timeoutMs
 */
async function resolveFetchUrl(url, timeoutMs) {
  const match = String(url).match(
    /^https?:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\/(.+)$/i
  );
  if (!match) return url;
  const filename = decodeURIComponent(match[1]);
  const api = new URL("https://commons.wikimedia.org/w/api.php");
  api.searchParams.set("action", "query");
  api.searchParams.set("titles", `File:${filename}`);
  api.searchParams.set("prop", "imageinfo");
  api.searchParams.set("iiprop", "url");
  api.searchParams.set("format", "json");
  const response = await fetchOk(
    api.toString(),
    {
      headers: {
        "User-Agent": "Base4NFDI-dashboard/1.0 (ref logo cache; https://base4nfdi.de)",
        Accept: "application/json",
      },
    },
    { timeoutMs, label: `Commons file ${filename}` }
  );
  const payload = await response.json();
  const pages = payload?.query?.pages ?? {};
  for (const page of Object.values(pages)) {
    const direct = page?.imageinfo?.[0]?.url;
    if (typeof direct === "string" && direct.startsWith("http")) {
      return direct.split("?")[0];
    }
  }
  return url;
}

function previousFor(table, name, previous) {
  const bucket = previous[table] ?? {};
  if (bucket[name]) return bucket[name];
  const wanted = name.toLowerCase();
  for (const entry of Object.values(bucket)) {
    if (asString(entry?.name).toLowerCase() === wanted) return entry;
  }
  return null;
}

function needsRefresh(previousEntry, sourceLogo, updatedAt, force) {
  if (force) return true;
  if (!sourceLogo) return false;
  if (!previousEntry?.logo) return true;
  if (asString(previousEntry.source_logo) !== sourceLogo) return true;
  if (asString(previousEntry.updated_at) !== asString(updatedAt)) return true;
  const abs = join(repoRoot, "static", previousEntry.logo);
  return !existsSync(abs);
}

async function cacheRows(rows, { table, previous, manifest, timeoutMs, retries, dryRun, force }) {
  /** @type {Record<string, object>} */
  const byKey = {};
  const stats = { downloaded: 0, cached: 0, failed: 0, skipped: 0 };

  for (const raw of rows) {
    const name = asString(raw.name);
    if (!name) continue;
    const sourceLogo = asString(raw.official_logo);
    const website = asString(raw.official_website);
    const updatedAt = asString(raw.updated_at);
    const prior = previousFor(table, name, previous);
    const refresh = needsRefresh(prior, sourceLogo, updatedAt, force);

    let logo = prior?.logo && asString(prior.source_logo) === sourceLogo ? prior.logo : "";
    if (sourceLogo && (refresh || !logo)) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const fetchUrl = await resolveFetchUrl(sourceLogo, timeoutMs);
      const result = await ensureLocalLogo(fetchUrl, {
        logoDir: LOGO_DIR,
        sitePrefix: SITE_PREFIX,
        timeoutMs,
        retries,
        dryRun,
        force: refresh,
        manifest,
        userAgent:
          "Base4NFDI-dashboard/1.0 (ref logo cache; https://base4nfdi.de)",
      });
      if (result.path) logo = result.path;
      stats[result.status] = (stats[result.status] ?? 0) + 1;
      if (result.status === "failed") {
        console.warn(`  logo failed for ${name}: ${result.error}`);
      }
      if (manifest[result.url]) {
        manifest[result.url].nocodb_updated_at = updatedAt || null;
        manifest[result.url].name = name;
      }
    } else {
      stats.skipped += 1;
    }

    const entry = {
      name,
      logo: logo || "",
      website,
      source_logo: sourceLogo,
      updated_at: updatedAt,
    };
    const keys = table === "partners" ? partnerLookupKeys(name) : entityLookupKeys(name);
    keys.push(name);
    for (const key of keys) {
      if (!byKey[key]) byKey[key] = entry;
    }
    console.log(
      `  ${name}` +
        (logo ? ` logo` : "") +
        (website ? ` site` : "") +
        (refresh && sourceLogo ? " [refresh]" : "")
    );
  }

  return { byKey, stats };
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

  const baseUrl = (process.env.NOCODB_BASE_URL ?? "https://nocodb.nfdi.de").replace(/\/$/, "");
  const pageSize = parsePositiveInt(process.env.NOCODB_PAGE_SIZE, 100, "NOCODB_PAGE_SIZE");
  const timeoutMs = parsePositiveInt(process.env.FETCH_TIMEOUT_MS, 60_000, "FETCH_TIMEOUT_MS");
  const retries = parsePositiveInt(process.env.FETCH_RETRIES, 2, "FETCH_RETRIES");
  const partnersTable = process.env.NOCODB_PARTNERS_TABLE_ID ?? PARTNERS_TABLE_ID;
  const entitiesTable = process.env.NOCODB_REF_ENTITIES_TABLE_ID ?? ENTITIES_TABLE_ID;

  const previous = loadPrevious();
  const manifest = loadManifest();

  const partnerRows = await fetchNocoDbRecords({
    baseUrl,
    tableId: partnersTable,
    token,
    pageSize,
    timeoutMs,
  });
  const entityRows = await fetchNocoDbRecords({
    baseUrl,
    tableId: entitiesTable,
    token,
    pageSize,
    timeoutMs,
  });
  console.log(
    `Fetched ${partnerRows.length} partner(s) and ${entityRows.length} entit(ies)`
  );

  const shared = { previous, manifest, timeoutMs, retries, dryRun: args.dryRun, force: args.force };
  console.log("Partners:");
  const partners = await cacheRows(partnerRows, { ...shared, table: "partners" });
  console.log("Entities:");
  const entities = await cacheRows(entityRows, { ...shared, table: "entities" });

  const directory = {
    fetched_at: new Date().toISOString(),
    projects: projectDirectory(previous.projects),
    partners: partners.byKey,
    entities: entities.byKey,
  };

  if (!args.dryRun) {
    writeJson(DIRECTORY_PATH, directory);
    saveManifest(manifest);
    console.log(`Wrote ${DIRECTORY_PATH}`);
  } else {
    console.log(`Dry-run. Would write ${DIRECTORY_PATH}`);
  }

  console.log(
    `partners cached=${partners.stats.cached} downloaded=${partners.stats.downloaded} failed=${partners.stats.failed}`
  );
  console.log(
    `entities cached=${entities.stats.cached} downloaded=${entities.stats.downloaded} failed=${entities.stats.failed}`
  );
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(error.message ?? error);
    process.exit(1);
  });
}

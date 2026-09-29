#!/usr/bin/env node
/**
 * PATCH official_website on existing NocoDB REF_Partners rows.
 *
 * Fills blank cells only. Candidates are Wikidata P856 values for the row's
 * wikidata_identifier. NFDI sections, task forces, circles, and other bodies
 * without a Q-id are left empty — they have no official site.
 *
 * A few P856 values point at a retired host. Those are rewritten to the
 * live homepage before the patch:
 *   nfdi4plants.de  → https://nfdi4plants.org
 *   ghga.dkfz.de    → https://www.ghga.de/
 *   eosc-hub.eu     → https://eosc.eu/
 *   nfdi4energy.de  → https://nfdi4energy.uol.de/
 *
 * Required env:
 *   NOCODB_API_TOKEN
 *
 * Optional env:
 *   NOCODB_BASE_URL
 *   NOCODB_PARTNERS_TABLE_ID  — default pf8ggs9jduxse4x
 *   NOCODB_PARTNERS_VIEW_ID
 *   NOCODB_PAGE_SIZE, FETCH_TIMEOUT_MS, WIKIDATA_USER_AGENT
 *
 * Usage:
 *   node scripts/patch-ref-partners-websites.mjs
 *   node scripts/patch-ref-partners-websites.mjs --apply
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchNocoDbRecords,
  fetchOk,
  parsePositiveInt,
} from "./lib/http-utils.mjs";
import { repoRoot, writeJson } from "./lib/parse-utils.mjs";
import { extractQid } from "./push-ref-entities-to-nocodb.mjs";

const DEFAULT_TABLE_ID = "pf8ggs9jduxse4x";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const UPDATE_BATCH_SIZE = 25;
const DEFAULT_USER_AGENT =
  "Base4NFDI-dashboard/1.0 (REF_Partners websites; https://github.com/base4nfdi)";

/** Hosts whose Wikidata P856 no longer is the public homepage. */
const HOST_REPLACEMENTS = {
  "nfdi4plants.de": "https://nfdi4plants.org",
  "www.nfdi4plants.de": "https://nfdi4plants.org",
  "ghga.dkfz.de": "https://www.ghga.de/",
  "www.ghga.dkfz.de": "https://www.ghga.de/",
  "eosc-hub.eu": "https://eosc.eu/",
  "www.eosc-hub.eu": "https://eosc.eu/",
  "nfdi4energy.de": "https://nfdi4energy.uol.de/",
  "www.nfdi4energy.de": "https://nfdi4energy.uol.de/",
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
  const args = { apply: false, limit: null, help: false };
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
  node scripts/patch-ref-partners-websites.mjs [options]

Fill blank official_website on REF_Partners from Wikidata P856.
Rows without a wikidata_identifier (NFDI sections, task forces, circles,
assemblies) are left empty.

Options:
  --apply        PATCH NocoDB (default is dry-run)
  --dry-run      Preview only (default)
  --limit <n>    Cap how many row updates are applied
  -h, --help     Show this help
`);
}

function asString(value) {
  if (value == null) return "";
  return String(value).replace(/\r/g, "").trim();
}

function userAgent() {
  return (process.env.WIKIDATA_USER_AGENT ?? DEFAULT_USER_AGENT).trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Prefer an English-language official website when several exist. */
function pickWebsite(candidates, partnerName = "") {
  const urls = [...new Set(candidates.map((url) => asString(url)).filter(Boolean))];
  if (urls.length === 0) return "";
  const token = asString(partnerName)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const scored = urls.map((url) => {
    let score = 0;
    const lower = url.toLowerCase();
    const host = hostOf(url).replace(/[^a-z0-9]/g, "");
    if (token.length >= 4 && host.includes(token)) score += 5;
    if (/\/en(\/|$|\?)/.test(lower) || /[?&]lang=en\b/.test(lower)) score += 3;
    if (lower.includes("/en.")) score += 2;
    if (lower.startsWith("https://")) score += 1;
    return { url, score };
  });
  scored.sort((a, b) => b.score - a.score || a.url.localeCompare(b.url));
  return scored[0].url;
}

function canonicalWebsite(url) {
  const raw = asString(url);
  if (!raw) return "";
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return raw;
  }
  return HOST_REPLACEMENTS[host] ?? raw;
}

function claimWebsites(entity) {
  const claims = entity?.claims?.P856;
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

async function fetchWebsitesByQids(qids, timeoutMs) {
  /** @type {Map<string, string[]>} */
  const byQid = new Map();
  const unique = [...new Set(qids.map(extractQid).filter(Boolean))];
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const url = `${WIKIDATA_API}?${new URLSearchParams({
      action: "wbgetentities",
      ids: chunk.join("|"),
      props: "claims",
      format: "json",
    })}`;
    const response = await fetchOk(
      url,
      { headers: { "User-Agent": userAgent(), Accept: "application/json" } },
      { timeoutMs, label: `Wikidata websites ${chunk.length}` }
    );
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error(`Wikidata returned non-JSON: ${error.message}`);
    }
    for (const [qid, entity] of Object.entries(payload?.entities ?? {})) {
      if (!entity || entity.missing != null) continue;
      byQid.set(qid.toUpperCase(), claimWebsites(entity));
    }
  }
  return byQid;
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
  const tableId = process.env.NOCODB_PARTNERS_TABLE_ID ?? DEFAULT_TABLE_ID;
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
  const partners = rawRows.map((raw) => ({
    id: raw.id ?? null,
    name: asString(raw.name),
    official_website: asString(raw.official_website),
    qid: extractQid(raw.wikidata_identifier),
  }));
  console.log(`Fetched ${partners.length} REF_Partners row(s) from ${baseUrl}`);

  const missing = partners.filter((row) => row.id != null && !row.official_website);
  const withQid = missing.filter((row) => row.qid);
  console.log(
    `${missing.length} blank official_website; ${withQid.length} have a Wikidata id`
  );

  const websitesByQid = await fetchWebsitesByQids(
    withQid.map((row) => row.qid),
    timeoutMs
  );

  const planned = [];
  const skipped = [];

  for (const row of partners) {
    if (row.id == null || !row.name) {
      skipped.push({ id: row.id, name: row.name, reason: "missing_name" });
      continue;
    }
    if (row.official_website) {
      skipped.push({
        id: row.id,
        name: row.name,
        reason: "already_filled",
        official_website: row.official_website,
      });
      continue;
    }
    if (!row.qid) {
      skipped.push({ id: row.id, name: row.name, reason: "no_wikidata_id" });
      continue;
    }

    const candidates = websitesByQid.get(row.qid) ?? [];
    const picked = pickWebsite(candidates, row.name);
    const official_website = canonicalWebsite(picked);
    if (!official_website) {
      skipped.push({
        id: row.id,
        name: row.name,
        reason: "no_website_on_wikidata",
        qid: row.qid,
      });
      continue;
    }

    planned.push({
      id: row.id,
      name: row.name,
      qid: row.qid,
      official_website,
      wikidata_website: picked,
      rewritten: official_website !== picked,
      host: hostOf(official_website),
    });
  }

  const limited = args.limit == null ? planned : planned.slice(0, args.limit);
  const report = {
    mode: args.apply ? "apply" : "dry-run",
    table_id: tableId,
    planned_at: new Date().toISOString(),
    totals: {
      nocodb: partners.length,
      blank: missing.length,
      with_qid: withQid.length,
      to_patch: planned.length,
      will_patch: limited.length,
      skipped: skipped.length,
      rewritten: planned.filter((row) => row.rewritten).length,
    },
    updates: limited,
    skipped,
  };

  const reportPath = join(
    repoRoot,
    "data/parsed/ref-partners-websites.push-report.json"
  );
  writeJson(reportPath, report);

  console.log(
    `rows=${limited.length}/${planned.length} skipped=${skipped.length} mode=${report.mode}`
  );
  for (const row of limited) {
    const note = row.rewritten ? ` (wikidata ${row.wikidata_website})` : "";
    console.log(`  #${row.id} ${row.name}`);
    console.log(`      + ${row.official_website}${note}`);
  }
  const unmatched = skipped.filter((row) => row.reason === "no_wikidata_id");
  if (unmatched.length > 0) {
    console.log(`Left empty (no Wikidata id, no official site): ${unmatched.length}`);
    for (const row of unmatched) console.log(`  #${row.id} ${row.name}`);
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
      official_website: row.official_website,
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
  console.log(`\nDone. Patched official_website on ${updated} REF_Partners row(s).`);
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

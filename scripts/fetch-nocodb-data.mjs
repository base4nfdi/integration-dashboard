#!/usr/bin/env node
/**
 * Fetches incubator rows from NocoDB and writes static/data.json.
 *
 * Required env:
 *   NOCODB_API_TOKEN  — xc-token from https://nocodb.nfdi.de/dashboard/#/account/tokens
 *
 * Optional env:
 *   NOCODB_BASE_URL, NOCODB_TABLE_ID, NOCODB_VIEW_ID, NOCODB_PAGE_SIZE, OUTPUT_JSON
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const PARTNERS_FIELD = "name (from REF_Partners)";
const ENTITIES_FIELD = "name (from REF_Entities)";

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
  } catch {
    // .env is optional when vars are exported in the shell/CI
  }
}

function asString(value) {
  if (value == null) return "";
  return String(value);
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item != null && String(item).length > 0).map(String);
}

function asNumber(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Map raw NocoDB record to the dashboard JSON shape. */
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

async function fetchAllRecords({ baseUrl, tableId, viewId, token, pageSize }) {
  const records = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      offset: String(offset),
      limit: String(pageSize),
      where: "",
      viewId,
    });

    const url = `${baseUrl}/api/v2/tables/${tableId}/records?${params}`;
    const response = await fetch(url, {
      headers: { "xc-token": token },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`NocoDB request failed (${response.status}): ${body}`);
    }

    const payload = await response.json();
    const batch = Array.isArray(payload?.list) ? payload.list : [];
    records.push(...batch);

    const pageInfo = payload?.pageInfo;
    if (pageInfo?.isLastPage === true || batch.length < pageSize) {
      break;
    }

    offset += batch.length;
  }

  return records;
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
  const viewId = process.env.NOCODB_VIEW_ID ?? "vwiouc4g6dgp01qp";
  const pageSize = Number(process.env.NOCODB_PAGE_SIZE ?? "100");
  const outputPath = resolve(
    repoRoot,
    process.env.OUTPUT_JSON ?? "static/data.json"
  );

  const rawRecords = await fetchAllRecords({
    baseUrl,
    tableId,
    viewId,
    token,
    pageSize,
  });

  const records = rawRecords.map(normalizeRecord);
  const payload = {
    source: "nocodb",
    fetched_at: new Date().toISOString(),
    records,
  };

  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${records.length} row(s) to ${outputPath}`);
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

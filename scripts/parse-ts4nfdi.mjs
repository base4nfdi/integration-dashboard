#!/usr/bin/env node
/**
 * Parse the TS4NFDI API gateway incubator list
 * (https://terminology.services.base4nfdi.de/api-gateway/incubators,
 * stored as data/sources/ts4nfdi/projects.json) into a NocoDB-aligned
 * record list.
 *
 * Usage:
 *   node scripts/parse-ts4nfdi.mjs
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  absoluteUrl,
  applyElapsedStatus,
  assertNonEmptyRecords,
  buildParsedPayload,
  compareWithNocoDb,
  emptyRecord,
  goalsToMarkdown,
  httpActivityUrl,
  loadNocoDbRecords,
  normalizeStatus,
  parseCycle,
  parseDate,
  readJson,
  repoRoot,
  sourceRef,
  writeJson,
} from "./lib/parse-utils.mjs";

const SOURCE_ID = "ts4nfdi";
const BASIC_SERVICE = "TS";
const SITE_BASE = "https://terminology.services.base4nfdi.de/";
const LOGO_BASE = "https://terminology.services.base4nfdi.de/img/";
const DEFAULT_INPUT = join(repoRoot, "data/sources/ts4nfdi/projects.json");
const DEFAULT_OUTPUT = join(repoRoot, "data/parsed/ts4nfdi.json");

function shortName(title) {
  const raw = String(title ?? "").trim();
  if (!raw) return "";
  // "WDCC - World Data Center for Climate" → "WDCC"
  const dash = raw.match(/^([^-–—]+)\s*[-–—]\s+/);
  if (dash && dash[1].length <= 40) return dash[1].trim();
  return raw;
}

const INCUBATOR_ID_RE = /^incubator-\d+$/;

/** Per-incubator detail page on the TS portal, e.g. /incubators/radar_incubator_1. */
function detailPageUrl(slug) {
  const raw = String(slug ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `${SITE_BASE}incubators/${encodeURIComponent(raw)}`;
}

/**
 * Throw on duplicate incubatorIDs (they are the NocoDB match key);
 * return warnings for missing or unexpected ids.
 */
export function checkIncubatorIds(projects) {
  const warnings = [];
  const seen = new Map();
  projects.forEach((project, index) => {
    const id = String(project?.incubatorID ?? "").trim();
    const label = String(project?.title ?? `#${index}`);
    if (!id) {
      warnings.push(`missing incubatorID for "${label}"`);
      return;
    }
    if (!INCUBATOR_ID_RE.test(id)) {
      warnings.push(`unexpected incubatorID format "${id}" for "${label}"`);
    }
    if (seen.has(id)) {
      throw new Error(
        `ts4nfdi: duplicate incubatorID "${id}" ("${seen.get(id)}" and "${label}")`
      );
    }
    seen.set(id, label);
  });
  return warnings;
}

export function parseTsProjects(payload) {
  const projects = Array.isArray(payload?.projects) ? payload.projects : [];

  return projects.map((project) => {
    const partners = Array.isArray(project.consortium)
      ? project.consortium.map(String)
      : [];
    const publications = Array.isArray(project.publications)
      ? project.publications.map(String)
      : [];
    const goals = Array.isArray(project.goals) ? project.goals : [];
    const logo = project.logo ? absoluteUrl(LOGO_BASE, project.logo) : "";

    return applyElapsedStatus(
      emptyRecord({
        inc_name: shortName(project.title) || String(project.title ?? ""),
        basic_service: BASIC_SERVICE,
        logo_project: logo,
        inc_start: parseDate(project.start),
        inc_end: parseDate(project.end, { endOfMonth: true }),
        inc_cycle: parseCycle(project.cycle),
        inc_status: normalizeStatus(project.status),
        inc_descr: String(project.description ?? "").trim(),
        inc_goals: goalsToMarkdown(goals),
        inc_results: publications.join("\n"),
        inc_partner_publications: publications.length,
        inc_activity_page: httpActivityUrl(SITE_BASE, project.activityPage),
        inc_source_ref: String(project.incubatorID ?? "").trim(),
        partners,
        linked_partners: partners.length,
        source_title: String(project.title ?? ""),
        source_activity_page: String(project.activityPage ?? ""),
        source_slug: String(project.url ?? "").trim(),
        source_page_url: detailPageUrl(project.url),
      })
    );
  });
}

async function main() {
  const inputPath = resolve(process.env.TS_INPUT ?? DEFAULT_INPUT);
  const outputPath = resolve(process.env.TS_OUTPUT ?? DEFAULT_OUTPUT);
  const payload = readJson(inputPath, {
    hint: "Run: node scripts/fetch-source-pages.mjs",
  });
  if (!Array.isArray(payload?.projects)) {
    throw new Error(
      `ts4nfdi: expected a "projects" array in ${inputPath}`
    );
  }
  for (const warning of checkIncubatorIds(payload.projects)) {
    console.warn(`ts4nfdi: ${warning}`);
  }
  const records = parseTsProjects(payload);
  assertNonEmptyRecords(records, "ts4nfdi");

  const out = buildParsedPayload({
    sourceId: SOURCE_ID,
    basicService: BASIC_SERVICE,
    inputFile: inputPath,
    records,
    extra: { stats: payload.stats ?? null, license: payload.license ?? null },
  });
  writeJson(outputPath, out);

  const nocoRecords = loadNocoDbRecords();
  const comparison = compareWithNocoDb(records, nocoRecords, BASIC_SERVICE);
  writeJson(join(repoRoot, "data/parsed/ts4nfdi.comparison.json"), comparison);

  const nocoRefs = new Set(
    nocoRecords
      .filter((r) => String(r.basic_service).toUpperCase() === BASIC_SERVICE)
      .map(sourceRef)
      .filter(Boolean)
  );
  const srcRefs = new Set(records.map(sourceRef).filter(Boolean));
  const newRefs = [...srcRefs].filter((ref) => !nocoRefs.has(ref));
  const vanishedRefs = [...nocoRefs].filter((ref) => !srcRefs.has(ref));
  if (newRefs.length > 0) {
    console.log(`New incubator id(s) not yet in NocoDB: ${newRefs.join(", ")}`);
  }
  if (vanishedRefs.length > 0) {
    console.warn(
      `NocoDB incubator id(s) no longer in the source: ${vanishedRefs.join(", ")}`
    );
  }

  console.log(`Parsed ${records.length} TS incubator(s) → ${outputPath}`);
  console.log(
    `Comparison: ${comparison.counts.matched} matched, ` +
      `${comparison.counts.only_in_source} only in source, ` +
      `${comparison.counts.only_in_nocodb} only in NocoDB`
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

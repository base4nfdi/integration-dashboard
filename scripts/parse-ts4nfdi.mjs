#!/usr/bin/env node
/**
 * Parse TS4NFDI projects.json into a NocoDB-aligned record list.
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
        partners,
        linked_partners: partners.length,
        source_title: String(project.title ?? ""),
        source_activity_page: String(project.activityPage ?? ""),
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
  const records = parseTsProjects(payload);
  assertNonEmptyRecords(records, "ts4nfdi");

  const out = buildParsedPayload({
    sourceId: SOURCE_ID,
    basicService: BASIC_SERVICE,
    inputFile: inputPath,
    records,
    extra: { stats: payload.stats ?? null },
  });
  writeJson(outputPath, out);

  const comparison = compareWithNocoDb(
    records,
    loadNocoDbRecords(),
    BASIC_SERVICE
  );
  writeJson(join(repoRoot, "data/parsed/ts4nfdi.comparison.json"), comparison);

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

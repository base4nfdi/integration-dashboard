#!/usr/bin/env node
/**
 * Parse IAM4NFDI incubator HTML dashboard into a NocoDB-aligned record list.
 *
 * Usage:
 *   node scripts/parse-iam4nfdi.mjs
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
  normalizePartnerName,
  normalizeStatus,
  parseCycle,
  parseDate,
  readTextFile,
  repoRoot,
  stripHtml,
  writeJson,
} from "./lib/parse-utils.mjs";

const SOURCE_ID = "iam4nfdi";
const BASIC_SERVICE = "IAM";
const SITE_BASE = "https://incubators.nfdi-aai.de/";
const DEFAULT_INPUT = join(repoRoot, "data/sources/iam4nfdi/page.html");
const DEFAULT_OUTPUT = join(repoRoot, "data/parsed/iam4nfdi.json");

const NON_PARTNER_TAGS = new Set([
  "base",
  "general",
  "external",
  "development",
  "integration",
  "operation",
  "running",
  "completed",
  "submitted",
  "review",
  "denied",
  "nocapacity",
  "finished",
]);

function parseBadges(tagsHtml) {
  const badges = [...tagsHtml.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/gi)].map(
    (m) => ({
      attrs: m[1],
      text: stripHtml(m[2]).replace(/\s+/g, " ").trim(),
    })
  );

  let status = "";
  let cycle = null;
  let start = "";
  let end = "";
  let type = "";
  const partners = [];
  const meta = [];

  for (const badge of badges) {
    const text = badge.text;
    if (!text && !/title="/i.test(badge.attrs)) continue;

    if (/badge-success/i.test(badge.attrs) && text) {
      status = text;
      continue;
    }

    if (/Cycle\s*\d+/i.test(text)) {
      cycle = parseCycle(text);
      const title = badge.attrs.match(/title="([^"]*)"/i)?.[1] ?? "";
      const range = title.split(/\s*[-–—]\s*/).map((p) => p.trim());
      if (range.length >= 2) {
        start = parseDate(range[0]);
        end = parseDate(range[1]);
      }
      continue;
    }

    if (/badge-primary/i.test(badge.attrs) && text) {
      type = text;
      continue;
    }

    if (/CAAI:/i.test(text)) {
      meta.push(text);
      continue;
    }

    if (/bg-dark/i.test(badge.attrs) && text) {
      const key = text.toLowerCase();
      if (!NON_PARTNER_TAGS.has(key)) {
        partners.push(normalizePartnerName(text));
      } else {
        meta.push(text);
      }
      continue;
    }

    if (text) meta.push(text);
  }

  return { status, cycle, start, end, type, partners, meta };
}

function partnersFromTitle(title) {
  const known = [
    "NFDI4Ing",
    "NFDI4ING",
    "NFDI4Cat",
    "NFDI4CAT",
    "NFDI4Chem",
    "NFDI4Culture",
    "NFDI4Earth",
    "NFDI4Energy",
    "NFDI4Health",
    "NFDI4Biodiversity",
    "NFDI4Objects",
    "FAIRmat",
    "FAIRagro",
    "DataPLANT",
    "MatWerk",
    "MaRDI",
    "Text+",
    "BERD",
    "TS4NFDI",
  ];
  const found = [];
  for (const name of known) {
    if (new RegExp(name.replace("+", "\\+"), "i").test(title)) {
      found.push(normalizePartnerName(name === "BERD" ? "BERD@NFDI" : name));
    }
  }
  return [...new Set(found)];
}

function extractGoals(cardTextHtml) {
  const goalsMatch = cardTextHtml.match(
    /<h4[^>]*>\s*Goals\s*<\/h4>\s*<ul>([\s\S]*?)<\/ul>/i
  );
  if (!goalsMatch) return "";
  const items = [...goalsMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map(
    (m) => stripHtml(m[1]).replace(/\s+/g, " ").trim()
  );
  return goalsToMarkdown(items);
}

function extractDescription(cardTextHtml) {
  const beforeGoals = cardTextHtml.split(/<h4[^>]*>\s*Goals\s*<\/h4>/i)[0] ?? "";
  return stripHtml(beforeGoals).replace(/\s+/g, " ").trim();
}

function extractResults(detailsHtml) {
  const m = detailsHtml.match(
    /<h5>\s*Results\s*(?:&|&amp;)\s*Deliverables\s*<\/h5>([\s\S]*?)(?:<hr\s*\/?>|<h5>|$)/i
  );
  if (!m) return "";
  const links = [...m[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  if (links.length) {
    return links.map((l) => l[1]).join("\n");
  }
  return stripHtml(m[1]);
}

function extractOwnership(detailsHtml) {
  const m = detailsHtml.match(
    /<h5>\s*Ownership\s*(?:&|&amp;)\s*Utilisation\s*<\/h5>([\s\S]*?)(?:<hr\s*\/?>|<h5>|<\/li>|$)/i
  );
  if (!m) return "";
  const withoutComments = m[1].replace(/<!--[\s\S]*?-->/g, "");
  const text = stripHtml(withoutComments).replace(/\s+/g, " ").trim();
  if (!text || text === "-" || text === "—" || /^n\/?a$/i.test(text)) return "";
  return text;
}

function caaiValue(meta) {
  const values = [];
  for (const item of meta ?? []) {
    const match = String(item).match(/^CAAI:\s*(.+)$/i);
    const value = match?.[1]?.trim();
    if (value) values.push(value);
  }
  return values.join(", ");
}

function extractActivityPage(cardHtml) {
  const m = cardHtml.match(
    /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>[\s\S]*?Activity\s+page[\s\S]*?<\/a\s*>/i
  );
  return m ? m[1].trim() : "";
}

export function parseIamHtml(html) {
  const records = [];
  const re =
    /<div class="card" id="([^"]+)">([\s\S]*?)(?=<div class="card" id="|<!--\s*Footer|<script\b)/gi;

  let match;
  while ((match = re.exec(html)) !== null) {
    const sourceId = match[1];
    const card = match[2];

    const title = stripHtml(
      card.match(/<h2 class="card-title">([\s\S]*?)<\/h2>/i)?.[1] ?? ""
    );
    if (!title) continue;

    const logo = card.match(/<img[^>]*class="card-img-top"[^>]*>/i)?.[0] ?? "";
    const logoSrc =
      logo.match(/src="([^"]+)"/i)?.[1] ??
      card.match(/<img[^>]*src="([^"]+)"/i)?.[1] ??
      "";

    const tagsHtml = card.match(/<div class="tags">([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const badges = parseBadges(tagsHtml);

    const cardText =
      card.match(/<p class="card-text">([\s\S]*?)<\/p>\s*<button/i)?.[1] ??
      card.match(/<p class="card-text">([\s\S]*?)<button/i)?.[1] ??
      "";

    const details =
      card.match(
        /<ul class="list-group list-group-flush[\s\S]*?<\/ul>/i
      )?.[0] ?? "";

    const activityPage = extractActivityPage(card);
    const partners =
      badges.partners.length > 0
        ? badges.partners
        : partnersFromTitle(title);

    records.push(
      applyElapsedStatus(
        emptyRecord({
          inc_name: title,
          basic_service: BASIC_SERVICE,
          logo_consortia: absoluteUrl(SITE_BASE, logoSrc),
          inc_start: badges.start,
          inc_end: badges.end,
          inc_cycle: badges.cycle,
          inc_status: normalizeStatus(badges.status),
          inc_descr: extractDescription(cardText),
          inc_goals: extractGoals(cardText),
          inc_results: extractResults(details),
          inc_activity_type: badges.type,
          inc_caai: caaiValue(badges.meta),
          inc_ownership: extractOwnership(details),
          inc_activity_page: httpActivityUrl(SITE_BASE, activityPage),
          partners,
          linked_partners: partners.length || null,
          source_id: sourceId,
          source_type: badges.type,
          source_activity_page: activityPage,
          source_meta: badges.meta,
        })
      )
    );
  }

  return records;
}

async function main() {
  const inputPath = resolve(process.env.IAM_INPUT ?? DEFAULT_INPUT);
  const outputPath = resolve(process.env.IAM_OUTPUT ?? DEFAULT_OUTPUT);
  const html = readTextFile(inputPath, {
    hint: "Run: node scripts/fetch-source-pages.mjs",
  });
  const records = parseIamHtml(html);
  assertNonEmptyRecords(records, "iam4nfdi");

  const payload = buildParsedPayload({
    sourceId: SOURCE_ID,
    basicService: BASIC_SERVICE,
    inputFile: inputPath,
    records,
  });
  writeJson(outputPath, payload);

  const comparison = compareWithNocoDb(
    records,
    loadNocoDbRecords(),
    BASIC_SERVICE
  );
  writeJson(join(repoRoot, "data/parsed/iam4nfdi.comparison.json"), comparison);

  console.log(
    `Parsed ${records.length} IAM incubator(s) → ${outputPath}`
  );
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

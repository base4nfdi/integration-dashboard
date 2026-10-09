#!/usr/bin/env node
/**
 * Parse DMP4NFDI incubator Markdown (HTML cards embedded in front-matter content)
 * into a NocoDB-aligned record list.
 *
 * Usage:
 *   node scripts/parse-dmp4nfdi.mjs
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
  loadNocoDbRecords,
  normalizeStatus,
  parseCycle,
  parseDuration,
  readTextFile,
  repoRoot,
  splitPartners,
  stripHtml,
  writeJson,
} from "./lib/parse-utils.mjs";

const SOURCE_ID = "dmp4nfdi";
const BASIC_SERVICE = "DMP";
const SITE_BASE = "https://dmp.services.base4nfdi.de/";
const DEFAULT_INPUT = join(repoRoot, "data/sources/dmp4nfdi/incubator.md");
const DEFAULT_OUTPUT = join(repoRoot, "data/parsed/dmp4nfdi.json");

function attr(tag, name) {
  const re = new RegExp(`${name}="([^"]*)"`, "i");
  const m = tag.match(re);
  return m ? m[1] : "";
}

function sectionHtml(cardHtml, heading) {
  const re = new RegExp(
    `<h5>\\s*${heading}\\s*:?\\s*</h5>\\s*([\\s\\S]*?)(?=<h5>|$)`,
    "i"
  );
  const m = cardHtml.match(re);
  return m ? m[1].trim() : "";
}

function resultsFromHtml(html) {
  if (!html) return "";
  const links = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  if (links.length) {
    return links
      .map((m) => {
        const label = stripHtml(m[2]) || m[1];
        return `${label}\n${m[1]}`;
      })
      .join("\n");
  }
  return stripHtml(html);
}

function deriveName({ alt, partners, service, goals }) {
  const cleanedAlt = alt
    .replace(/\s+Logo$/i, "")
    .replace(/\s+and\s+/gi, " & ")
    .trim();

  const looksLikeProject =
    cleanedAlt &&
    !/^nfdi/i.test(cleanedAlt) &&
    !/fair/i.test(cleanedAlt) &&
    !/text\+/i.test(cleanedAlt) &&
    !/mardi/i.test(cleanedAlt) &&
    !/matwerk/i.test(cleanedAlt) &&
    !/physical-sciences/i.test(cleanedAlt);

  if (looksLikeProject) return cleanedAlt;

  // Prefer a bold project/service mention inside the goal text.
  const bold = [...goals.matchAll(/<b>([^<]+)<\/b>/gi)].map((m) =>
    stripHtml(m[1])
  );
  if (bold.length === 1) return bold[0];
  if (bold.length > 1) {
    const nonConsortium = bold.find(
      (b) => !/^(NFDI|FAIR|Text\+|MaRDI|MatWerk|PSinNFDI)/i.test(b)
    );
    if (nonConsortium) return nonConsortium;
  }

  const partnerLabel = partners.join(", ") || cleanedAlt || "Unknown";
  const primaryService = (service.split(",")[0] || "Incubator").trim();
  return `${primaryService} — ${partnerLabel}`;
}

function inferStatus(start, end) {
  const today = new Date().toISOString().slice(0, 10);
  if (end && end < today) return "Finished";
  if (start && start > today) return "In preparation";
  if (start || end) return "Running";
  return "";
}

function extractCards(markdown) {
  const starts = [];
  const re = /<div\s+class="usecase-card"([^>]*)>/gi;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    starts.push({ attrs: m[1], start: m.index + m[0].length, tagStart: m.index });
  }

  return starts.map((item, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].tagStart : markdown.length;
    // Trim to the card's own closing div (first top-level </div> after content).
    let body = markdown.slice(item.start, end);
    const close = body.lastIndexOf("</div>");
    if (close !== -1) body = body.slice(0, close);
    return { attrs: item.attrs, body };
  });
}

export function parseDmpMarkdown(markdown) {
  const cards = [];

  for (const { attrs, body } of extractCards(markdown)) {
    const service = attr(attrs, "data-service");
    const cycleRaw = attr(attrs, "data-cycle");
    const partners = splitPartners(attr(attrs, "data-nfdi"));

    const img = body.match(/<img[^>]*>/i)?.[0] ?? "";
    const logo = attr(img, "src");
    const alt = attr(img, "alt");

    const goalsHtml = sectionHtml(body, "Goal");
    const durationHtml = sectionHtml(body, "Duration");
    const resultsHtml = sectionHtml(body, "Results");
    const { start, end } = parseDuration(stripHtml(durationHtml));

    // data-cycle may list multiple values ("Cycle 0, Cycle 1"); take the highest.
    const cycleParts = cycleRaw
      .split(/\s*,\s*/)
      .map(parseCycle)
      .filter((n) => n != null);
    const inc_cycle =
      cycleParts.length > 0 ? Math.max(...cycleParts) : parseCycle(cycleRaw);

    const inc_name = deriveName({
      alt,
      partners,
      service,
      goals: goalsHtml,
    });

    const status = inferStatus(start, end);

    cards.push(
      applyElapsedStatus(
        emptyRecord({
          inc_name,
          basic_service: BASIC_SERVICE,
          logo_consortia: absoluteUrl(SITE_BASE, logo),
          inc_start: start,
          inc_end: end,
          inc_cycle,
          inc_status: normalizeStatus(status),
          // DMP pages put the narrative under "Goal"; map to inc_goals to match NocoDB.
          inc_goals: stripHtml(goalsHtml),
          inc_results: resultsFromHtml(resultsHtml),
          inc_service_type: service,
          partners,
          linked_partners: partners.length,
          source_service_type: service,
          source_cycle_label: cycleRaw,
        })
      )
    );
  }

  return cards;
}

async function main() {
  const inputPath = resolve(process.env.DMP_INPUT ?? DEFAULT_INPUT);
  const outputPath = resolve(process.env.DMP_OUTPUT ?? DEFAULT_OUTPUT);
  const markdown = readTextFile(inputPath, {
    hint: "Run: node scripts/fetch-source-pages.mjs",
  });
  const records = parseDmpMarkdown(markdown);
  assertNonEmptyRecords(records, "dmp4nfdi");

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
  writeJson(join(repoRoot, "data/parsed/dmp4nfdi.comparison.json"), comparison);

  console.log(
    `Parsed ${records.length} DMP incubator(s) → ${outputPath}`
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

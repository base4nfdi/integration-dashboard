#!/usr/bin/env node
/**
 * Parse PID4NFDI use-case cards from the GitHub markdown source into a
 * NocoDB-aligned record list (User_Stories field shape).
 *
 * Source embeds HTML pid-card blocks inside the markdown page body.
 *
 * Usage:
 *   node scripts/parse-pid4nfdi.mjs
 */

import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNonEmptyRecords,
  buildParsedPayload,
  compareWithNocoDb,
  emptyRecord,
  loadNocoDbRecords,
  normalizePartnerName,
  readTextFile,
  repoRoot,
  splitPartners,
  stripHtml,
  writeJson,
} from "./lib/parse-utils.mjs";

const SOURCE_ID = "pid4nfdi";
const BASIC_SERVICE = "PID";
const SITE_PAGE =
  "https://github.com/base4nfdi/pid4nfdi/blob/main/content/community/use-cases.md";
const DEFAULT_INPUT = join(repoRoot, "data/sources/pid4nfdi/use-cases.md");
const DEFAULT_OUTPUT = join(repoRoot, "data/parsed/pid4nfdi.json");

function attr(tag, name) {
  const re = new RegExp(`${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = tag.match(re);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function headingValue(cardHtml, label) {
  const re = new RegExp(
    `<h5>\\s*${label}\\s*:?\\s*([\\s\\S]*?)(?=<h5|<h2|</div>|$)`,
    "i"
  );
  const m = cardHtml.match(re);
  if (!m) return "";
  return stripHtml(m[1]).replace(/\s+/g, " ").trim();
}

function firstParagraph(cardHtml) {
  const m = cardHtml.match(/<p>([\s\S]*?)<\/p>/i);
  return m ? stripHtml(m[1]) : "";
}

function learnMoreUrl(cardHtml) {
  const m = cardHtml.match(
    /<a[^>]*href=(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>\s*Learn more\s*<\/a>/i
  );
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? "").trim();
}

function labelList(cardHtml) {
  const spans = [
    ...cardHtml.matchAll(
      /<span[^>]*background-color[^>]*>([\s\S]*?)<\/span>/gi
    ),
  ];
  return spans
    .map((m) => stripHtml(m[1]).replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function extractCards(html) {
  const starts = [];
  const re = /<div\s+class=(?:"pid-card"|'pid-card'|pid-card)([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    starts.push({
      attrs: m[1] ?? "",
      start: m.index + m[0].length,
      tagStart: m.index,
    });
  }

  return starts.map((item, i) => {
    const end =
      i + 1 < starts.length ? starts[i + 1].tagStart : html.length;
    let body = html.slice(item.start, end);
    const close = body.lastIndexOf("</div>");
    if (close !== -1) body = body.slice(0, close);
    return { attrs: item.attrs, body };
  });
}

function goalsFromMeta({ labels, resourceTypes, pidProviders, researchField }) {
  const lines = [];
  if (labels.length) lines.push(`- **Labels:** ${labels.join(", ")}`);
  if (resourceTypes) lines.push(`- **Resource types:** ${resourceTypes}`);
  if (pidProviders) lines.push(`- **PID providers:** ${pidProviders}`);
  if (researchField) lines.push(`- **Research field:** ${researchField}`);
  return lines.join("\n");
}

/** Parse pid-card HTML blocks (embedded in the markdown source body). */
export function parsePidHtml(html) {
  const records = [];

  for (const { attrs, body } of extractCards(html)) {
    const titleMatch = body.match(/<h2>([\s\S]*?)<\/h2>/i);
    const uc_name = titleMatch ? stripHtml(titleMatch[1]) : "";
    if (!uc_name) continue;

    const labelsFromAttr = String(attr(attrs, "data-type") || "")
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    const labels = labelsFromAttr.length ? labelsFromAttr : labelList(body);

    const consortiaRaw =
      headingValue(body, "Consortia") || attr(attrs, "data-consortium") || "";
    const partners = splitPartners(consortiaRaw).map((p) => {
      // Site typo / casing variants
      if (/^nfdixcsk$/i.test(p)) return normalizePartnerName("NFDIxCS");
      return p;
    });

    // Organizations → Institutions (entities), not Further Institutions.
    const organizations = String(headingValue(body, "Organizations") ?? "")
      .split(/\s*,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    const resourceTypes =
      headingValue(body, "Resource types") ||
      attr(attrs, "data-lang") ||
      "";
    const pidProviders =
      headingValue(body, "PID Providers") ||
      attr(attrs, "data-provider") ||
      "";
    const researchField =
      headingValue(body, "Research Field") ||
      attr(attrs, "data-domain") ||
      "";
    const sourceUrl = learnMoreUrl(body);
    const descr = firstParagraph(body);

    records.push(
      emptyRecord({
        // Dashboard / Incubators-shaped aliases (matching + page gen)
        inc_name: uc_name,
        inc_descr: descr,
        // User_Stories use-case columns
        uc_name,
        uc_descr: descr,
        basic_service: BASIC_SERVICE,
        related_institutions: "",
        entities: organizations,
        linked_entities: organizations.length || null,
        inc_goals: goalsFromMeta({
          labels,
          resourceTypes,
          pidProviders,
          researchField,
        }),
        inc_results: sourceUrl ? `Learn more\n${sourceUrl}` : "",
        partners,
        linked_partners: partners.length,
        source_url: sourceUrl,
        uc_labels: labels.join(", "),
        pid_providers: pidProviders,
        research_field: researchField,
        resource_types: resourceTypes,
        source_page: SITE_PAGE,
        integration_kind: "use-case",
      })
    );
  }

  return records;
}

/** Parse the PID4NFDI use-cases.md source (HTML cards inside markdown). */
export function parsePidMarkdown(markdown) {
  return parsePidHtml(markdown);
}

async function main() {
  const inputPath = resolve(process.env.PID_INPUT ?? DEFAULT_INPUT);
  const outputPath = resolve(process.env.PID_OUTPUT ?? DEFAULT_OUTPUT);
  const markdown = readTextFile(inputPath, {
    hint: "Run: node scripts/fetch-source-pages.mjs",
  });
  const records = parsePidMarkdown(markdown);
  assertNonEmptyRecords(records, "pid4nfdi");

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
  writeJson(join(repoRoot, "data/parsed/pid4nfdi.comparison.json"), comparison);

  console.log(`Parsed ${records.length} PID use case(s) → ${outputPath}`);
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

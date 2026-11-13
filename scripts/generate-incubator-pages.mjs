#!/usr/bin/env node
/**
 * Create missing content/integrations/{service}/{key_article}.md pages from static/data.json.
 *
 * Existing Markdown files are left unchanged unless --force is passed.
 *
 * Usage:
 *   node scripts/generate-incubator-pages.mjs
 *   node scripts/generate-incubator-pages.mjs --dry-run
 *   node scripts/generate-incubator-pages.mjs --update
 *   node scripts/generate-incubator-pages.mjs --force
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  formatCycleLabel,
  loadNocoDbRecords,
  repoRoot,
} from "./lib/parse-utils.mjs";

const DEFAULT_DATA = join(repoRoot, "static/data.json");
const DEFAULT_OUT_DIR = join(repoRoot, "content/integrations");

const SERVICE_LABELS = {
  TS: "Terminology Services (TS)",
  IAM: "Identity and Access Management (IAM)",
  DMP: "Data Management Planning (DMP)",
  PID: "Persistent Identifiers (PID)",
};

const SERVICE_DIRS = new Set(["ts", "dmp", "iam", "pid"]);
const KEY_ARTICLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function parseArgs(argv) {
  const args = { dryRun: false, force: false, update: false, help: false };
  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--update") args.update = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/generate-incubator-pages.mjs [--dry-run] [--update] [--force]

Creates missing integration Markdown files under
content/integrations/{ts|dmp|iam|pid}/ from static/data.json.
By default existing files are not overwritten.
--update rewrites an existing page when the generated Markdown differs.
`);
}

function tomlString(value) {
  return `"${String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')}"`;
}

function tomlArray(values) {
  return `[${values.map((v) => tomlString(v)).join(", ")}]`;
}

function asText(value) {
  return String(value ?? "").trim();
}

/** Collapse whitespace so TOML basic strings stay single-line. */
function asInline(value) {
  return asText(value).replace(/\s+/g, " ");
}

/** Remove whitespace from URL-like values (source data may wrap mid-path). */
function asUrl(value) {
  return asText(value).replace(/\s+/g, "");
}

function cleanText(value) {
  return asText(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageDate(record) {
  return asText(record.inc_end) || asText(record.inc_start) || "1970-01-01";
}

function serviceLabel(basicService) {
  const code = asText(basicService).toUpperCase();
  return SERVICE_LABELS[code] ?? (code || "Unknown");
}

function serviceDir(basicService) {
  const code = asText(basicService).toLowerCase();
  if (!SERVICE_DIRS.has(code)) {
    throw new Error(`Unknown basic_service for path: ${basicService || "(empty)"}`);
  }
  return code;
}

const URL_LINE_RE = /^https?:\/\/\S+$/i;

function isUrlLine(line) {
  return URL_LINE_RE.test(String(line ?? "").trim());
}

function formatLinkishBlock(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";

  const lines = cleaned.split("\n");
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      out.push("");
      continue;
    }

    if (isUrlLine(trimmed)) {
      out.push(`- [${trimmed}](${trimmed})`);
      continue;
    }

    let j = i + 1;
    while (j < lines.length && !lines[j].trim()) j += 1;
    if (j < lines.length && isUrlLine(lines[j])) {
      const url = lines[j].trim();
      out.push(`- [${trimmed}](${url})`);
      i = j;
      continue;
    }

    out.push(lines[i].trimEnd());
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function formatPartnersSection(record) {
  const lines = [];
  const partners = Array.isArray(record.partners) ? record.partners : [];
  const entities = Array.isArray(record.entities) ? record.entities : [];
  const related = asText(record.related_institutions);
  const pubs = record.inc_partner_publications ?? 0;

  if (partners.length > 0) {
    lines.push(`- **NFDI consortia:** ${partners.join(", ")}`);
  }

  if (entities.length > 0) {
    const label =
      entities.length === 1 ? "Participating entity" : "Participating entities";
    lines.push(`- **${label}:** ${entities.join(", ")}`);
  }

  if (related) {
    lines.push(`- **Related institutions:** ${related}`);
  }

  const pubCount = Number(pubs) || 0;
  if (pubCount > 0) {
    lines.push(`- **Partner publications:** ${pubCount}`);
  }
  return lines.join("\n");
}

function buildFrontMatter(record, keyArticle) {
  const lines = [
    "+++",
    `title = ${tomlString(asInline(record.inc_name) || keyArticle)}`,
    `date = ${pageDate(record)}`,
    "[extra]",
    `key_article = ${tomlString(keyArticle)}`,
    `basic_service = ${tomlString(asInline(record.basic_service))}`,
    `status = ${tomlString(asInline(record.inc_status))}`,
    `inc_start = ${tomlString(asInline(record.inc_start))}`,
    `inc_end = ${tomlString(asInline(record.inc_end))}`,
  ];

  if (record.inc_cycle != null && record.inc_cycle !== "") {
    lines.push(`inc_cycle = ${Number(record.inc_cycle)}`);
  }
  const cycleLabel = formatCycleLabel(
    record.inc_cycle_label,
    record.inc_cycle
  );
  if (cycleLabel) {
    lines.push(`inc_cycle_label = ${tomlString(asInline(cycleLabel))}`);
  }

  lines.push(
    `inc_partner_publications = ${
      Number.isFinite(Number(record.inc_partner_publications))
        ? Number(record.inc_partner_publications)
        : 0
    }`,
    `linked_partners = ${
      record.linked_partners == null || record.linked_partners === ""
        ? 0
        : Number(record.linked_partners)
    }`,
    `linked_entities = ${
      record.linked_entities == null || record.linked_entities === ""
        ? 0
        : Number(record.linked_entities)
    }`
  );

  const partners = (Array.isArray(record.partners) ? record.partners : [])
    .map((p) => asInline(p))
    .filter(Boolean);
  const entities = (Array.isArray(record.entities) ? record.entities : [])
    .map((e) => asInline(e))
    .filter(Boolean);
  if (partners.length > 0) lines.push(`partners = ${tomlArray(partners)}`);
  if (entities.length > 0) lines.push(`entities = ${tomlArray(entities)}`);

  const logoProject = asUrl(record.logo_project);
  const logoProjectDark = asUrl(record.logo_project_dark);
  const logoConsortia = asUrl(record.logo_consortia);
  const related = asInline(record.related_institutions);
  if (logoProject) lines.push(`logo_project = ${tomlString(logoProject)}`);
  if (logoProjectDark) lines.push(`logo_project_dark = ${tomlString(logoProjectDark)}`);
  if (logoConsortia) lines.push(`logo_consortia = ${tomlString(logoConsortia)}`);
  const sourceUrl = asUrl(record.source_url);
  if (sourceUrl) lines.push(`source_url = ${tomlString(sourceUrl)}`);
  if (related) lines.push(`related_institutions = ${tomlString(related)}`);

  const activityType = asInline(record.inc_activity_type);
  const caai = asInline(record.inc_caai);
  const ownership = asInline(record.inc_ownership);
  const serviceType = asInline(record.inc_service_type);
  const activityPage = asUrl(record.inc_activity_page);
  if (activityType) lines.push(`inc_activity_type = ${tomlString(activityType)}`);
  if (caai) lines.push(`inc_caai = ${tomlString(caai)}`);
  if (ownership) lines.push(`inc_ownership = ${tomlString(ownership)}`);
  if (serviceType) lines.push(`inc_service_type = ${tomlString(serviceType)}`);
  if (activityPage) lines.push(`inc_activity_page = ${tomlString(activityPage)}`);
  const sourceRef = asUrl(record.inc_source_ref);
  if (sourceRef) lines.push(`source_ref = ${tomlString(sourceRef)}`);

  lines.push("+++");
  return lines.join("\n");
}

function buildBody(record, keyArticle) {
  const name = asText(record.inc_name) || keyArticle;
  const descr = cleanText(record.inc_descr);
  const goals = formatLinkishBlock(record.inc_goals);
  const activityPage = asUrl(record.inc_activity_page);
  const resultsText = cleanText(record.inc_results);
  const resultsSource =
    activityPage && !resultsText.includes(activityPage)
      ? [resultsText, activityPage].filter(Boolean).join("\n")
      : resultsText;
  const results = formatLinkishBlock(resultsSource);
  const ownership = asText(record.inc_ownership);
  const sections = [];

  if (descr) {
    sections.push(descr);
    sections.push("");
  }

  if (goals) {
    sections.push("");
    sections.push("## Goals");
    sections.push("");
    sections.push(goals);
  }

  if (results) {
    sections.push("");
    sections.push("## Results");
    sections.push("");
    sections.push(results);
  }

  if (ownership) {
    sections.push("");
    sections.push("## Ownership & utilisation");
    sections.push("");
    sections.push(ownership);
  }

  sections.push("");
  sections.push("## Partners & entities");
  sections.push("");
  sections.push(formatPartnersSection(record));
  sections.push("");
  sections.push("");
  // sections.push("## Notes");
  // sections.push("");
  // sections.push(
  //   `This report maps to row **${keyArticle}** in the NocoDB dashboard table.`
  // );
  // sections.push("");

  return sections.join("\n");
}

export function renderIncubatorMarkdown(record) {
  const keyArticle = asText(record.key_article);
  if (!keyArticle) {
    throw new Error("record.key_article is required");
  }
  if (!KEY_ARTICLE_RE.test(keyArticle)) {
    throw new Error(`Unsafe key_article for filename: ${keyArticle}`);
  }
  return `${buildFrontMatter(record, keyArticle)}\n\n${buildBody(
    record,
    keyArticle
  )}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const records = loadNocoDbRecords(DEFAULT_DATA);
  if (records.length === 0) {
    throw new Error(
      `No records in ${DEFAULT_DATA} — run fetch-nocodb-data.mjs first`
    );
  }

  mkdirSync(DEFAULT_OUT_DIR, { recursive: true });
  for (const dir of SERVICE_DIRS) {
    mkdirSync(join(DEFAULT_OUT_DIR, dir), { recursive: true });
  }

  const created = [];
  const updated = [];
  const unchanged = [];
  const skipped = [];
  const ignored = [];

  for (const record of records) {
    const keyArticle = asText(record.key_article);
    if (!keyArticle) {
      ignored.push({ reason: "empty_key_article", id: record.id });
      continue;
    }
    if (!KEY_ARTICLE_RE.test(keyArticle)) {
      ignored.push({ reason: "unsafe_key_article", key_article: keyArticle });
      continue;
    }

    let service;
    try {
      service = serviceDir(record.basic_service);
    } catch (error) {
      ignored.push({
        reason: "unknown_basic_service",
        key_article: keyArticle,
        basic_service: record.basic_service,
      });
      continue;
    }

    const outPath = join(DEFAULT_OUT_DIR, service, `${keyArticle}.md`);
    const exists = existsSync(outPath);
    const markdown = renderIncubatorMarkdown(record);

    if (exists && !args.force && !args.update) {
      skipped.push(keyArticle);
      continue;
    }

    if (exists && args.update && !args.force) {
      const current = readFileSync(outPath, "utf8");
      if (current === markdown) {
        unchanged.push(keyArticle);
        continue;
      }
      if (args.dryRun) {
        updated.push({ key_article: keyArticle, path: outPath, dryRun: true });
        continue;
      }
      writeFileSync(outPath, markdown, "utf8");
      updated.push({ key_article: keyArticle, path: outPath });
      continue;
    }

    if (args.dryRun) {
      created.push({ key_article: keyArticle, path: outPath, dryRun: true });
      continue;
    }

    writeFileSync(outPath, markdown, "utf8");
    created.push({ key_article: keyArticle, path: outPath });
  }

  const action = args.force ? "Wrote/updated" : "Created";
  console.log(
    `${action} ${created.length} incubator page(s)` +
      (args.update ? `; updated ${updated.length}; unchanged ${unchanged.length}` : "") +
      (args.dryRun ? " (dry-run)" : "") +
      `; skipped ${skipped.length} existing; ignored ${ignored.length}.`
  );

  const listed = args.force ? created : [...created, ...updated];
  if (listed.length > 0 && listed.length <= 20) {
    for (const item of listed) {
      console.log(`  ${item.key_article}`);
    }
  } else if (listed.length > 20) {
    for (const item of listed.slice(0, 10)) {
      console.log(`  ${item.key_article}`);
    }
    console.log(`  … and ${listed.length - 10} more`);
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

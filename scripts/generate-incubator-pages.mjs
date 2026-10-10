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
import { loadNocoDbRecords, repoRoot } from "./lib/parse-utils.mjs";

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

function displayDate(value) {
  const text = asText(value);
  return text || "—";
}

function formatStatusLine(record) {
  const status = asText(record.inc_status) || "Unknown";
  const cycle =
    record.inc_cycle != null && record.inc_cycle !== ""
      ? `cycle ${record.inc_cycle}`
      : "";
  const start = asText(record.inc_start);
  const end = asText(record.inc_end);

  if (/^finished$/i.test(status)) {
    if (cycle && end) return `**${status}** — ${cycle} completed on ${end}.`;
    if (cycle) return `**${status}** — ${cycle}.`;
    if (end) return `**${status}** — completed on ${end}.`;
    return `**${status}**.`;
  }

  if (/^in preparation$/i.test(status)) {
    if (cycle && start) {
      return `**${status}** — ${cycle}, planned start ${start}.`;
    }
    if (cycle) return `**${status}** — ${cycle}.`;
    if (start) return `**${status}** — planned start ${start}.`;
    return `**${status}**.`;
  }

  if (cycle && start) return `**${status}** — ${cycle}, started ${start}.`;
  if (cycle) return `**${status}** — ${cycle}.`;
  if (start) return `**${status}** — started ${start}.`;
  return `**${status}**.`;
}

function formatLinkishBlock(text) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";

  return cleaned
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      if (/^https?:\/\/\S+$/i.test(trimmed)) {
        return `- [${trimmed}](${trimmed})`;
      }
      return line.trimEnd();
    })
    .filter((line, index, arr) => line !== "" || (index > 0 && arr[index - 1] !== ""))
    .join("\n")
    .trim();
}

function formatPartnersSection(record) {
  const lines = [];
  const partners = Array.isArray(record.partners) ? record.partners : [];
  const entities = Array.isArray(record.entities) ? record.entities : [];
  const related = asText(record.related_institutions);
  const linkedPartners = record.linked_partners;
  const linkedEntities = record.linked_entities;
  const pubs = record.inc_partner_publications ?? 0;

  if (partners.length > 0) {
    const count =
      linkedPartners != null && linkedPartners !== ""
        ? ` (${linkedPartners} linked)`
        : "";
    lines.push(`- **NFDI consortia:** ${partners.join(", ")}${count}`);
  }

  if (entities.length > 0) {
    const label =
      entities.length === 1 ? "Participating entity" : "Participating entities";
    const count =
      linkedEntities != null && linkedEntities !== ""
        ? ` (${linkedEntities} linked)`
        : "";
    lines.push(`- **${label}:** ${entities.join(", ")}${count}`);
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
    `inc_cycle = ${
      record.inc_cycle == null || record.inc_cycle === ""
        ? "0"
        : Number(record.inc_cycle)
    }`,
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
    }`,
  ];

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
  const serviceType = asText(record.inc_service_type);
  const activityType = asText(record.inc_activity_type);
  const caai = asText(record.inc_caai);
  const ownership = asText(record.inc_ownership);
  const sections = [];

  if (descr) {
    sections.push(descr);
    sections.push("");
  }

  const isIam = asText(record.basic_service).toUpperCase() === "IAM";

  if (!isIam) {
    sections.push("## Current status");
    sections.push("");
    sections.push(formatStatusLine(record));
    sections.push("");
  }

  sections.push("## Timeline");
  sections.push("");
  sections.push(`- **Start:** ${displayDate(record.inc_start)}`);
  sections.push(`- **End:** ${displayDate(record.inc_end)}`);

  if (!isIam) {
    sections.push(
      `- **Cycle:** ${
        record.inc_cycle == null || record.inc_cycle === ""
          ? "—"
          : record.inc_cycle
      }`
    );
    if (serviceType) sections.push(`- **Service type:** ${serviceType}`);
    if (activityType) sections.push(`- **Activity type:** ${activityType}`);
  } else if (serviceType) {
    sections.push(`- **Service type:** ${serviceType}`);
  }

  if (caai && !isIam) {
    sections.push("");
    sections.push("## Community AAI");
    sections.push("");
    sections.push(caai);
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

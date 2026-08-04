#!/usr/bin/env node
/**
 * Cache remote logo_project / logo_consortia images under static/img/partner-logos/
 * and rewrite static/data.json (+ incubator Markdown frontmatter) to local paths.
 *
 * Existing logo files are reused (no re-download) unless --force is passed.
 *
 * Usage:
 *   node scripts/cache-partner-logos.mjs
 *   node scripts/cache-partner-logos.mjs --dry-run
 *   node scripts/cache-partner-logos.mjs --force
 *   node scripts/cache-partner-logos.mjs --skip-markdown
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LOGO_URL_ALIASES,
  localizeRecordLogos,
  rewriteMarkdownLogoFields,
} from "./lib/logo-cache.mjs";
import { parsePositiveInt } from "./lib/http-utils.mjs";
import { repoRoot } from "./lib/parse-utils.mjs";

const DEFAULT_CONTENT = join(repoRoot, "content/integrations");

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    skipMarkdown: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--skip-markdown") args.skipMarkdown = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/cache-partner-logos.mjs [--dry-run] [--force] [--skip-markdown]

Downloads remote partner logos referenced by static/data.json into
static/img/partner-logos/ (skipped when the file already exists), then rewrites
logo_project / logo_consortia to site-relative paths in data.json and incubator
Markdown frontmatter.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const dataPath = resolve(repoRoot, process.env.OUTPUT_JSON ?? "static/data.json");
  const contentDir = DEFAULT_CONTENT;
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );
  const retries = parsePositiveInt(
    process.env.FETCH_RETRIES,
    2,
    "FETCH_RETRIES"
  );

  const payload = JSON.parse(readFileSync(dataPath, "utf8"));
  const records = Array.isArray(payload?.records) ? payload.records : [];
  if (records.length === 0) {
    throw new Error(`No records found in ${dataPath}`);
  }

  const summary = await localizeRecordLogos(records, {
    dryRun: args.dryRun,
    force: args.force,
    timeoutMs,
    retries,
  });

  if (!args.dryRun && summary.rewritten > 0) {
    payload.records = records;
    payload.logos_localized_at = new Date().toISOString();
    writeFileSync(dataPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  }

  /** @type {Map<string, string>} */
  const urlToPath = new Map();
  for (const result of summary.results) {
    if (result.path) urlToPath.set(result.url, result.path);
  }
  // Also include previously cached mappings from the manifest.
  for (const [url, entry] of Object.entries(summary.manifest ?? {})) {
    if (entry?.path) urlToPath.set(url, entry.path);
  }
  // Stale upstream URLs should resolve to the same local file as their alias target.
  for (const [from, to] of Object.entries(LOGO_URL_ALIASES)) {
    const path = urlToPath.get(to);
    if (path) urlToPath.set(from, path);
  }

  let mdSummary = { files: 0, updated: 0, touchedFields: 0 };
  if (!args.skipMarkdown) {
    mdSummary = rewriteMarkdownLogoFields(contentDir, urlToPath, {
      dryRun: args.dryRun,
    });
  }

  const failed = summary.results.filter((r) => r.status === "failed");
  console.log(
    [
      args.dryRun ? "Dry-run:" : "Cached logos:",
      `${summary.urls} unique remote URL(s)`,
      `${summary.downloaded} downloaded`,
      `${summary.cached} already local`,
      `${summary.failed} failed`,
      `${summary.rewritten} field rewrite(s) in data.json`,
      args.skipMarkdown
        ? "markdown skipped"
        : `${mdSummary.updated} markdown file(s) updated (${mdSummary.touchedFields} field(s))`,
    ].join(" · ")
  );

  if (failed.length > 0) {
    console.warn("Failed logo downloads (remote URL left unchanged):");
    for (const item of failed.slice(0, 20)) {
      console.warn(`  - ${item.url}`);
      console.warn(`    ${item.error}`);
    }
    if (failed.length > 20) {
      console.warn(`  … and ${failed.length - 20} more`);
    }
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Cache Base4NFDI project fonts (fonts.css + .woff2) under static/fonts/.
 *
 * Existing files are reused unless --force is passed.
 *
 * Usage:
 *   node scripts/cache-fonts.mjs
 *   node scripts/cache-fonts.mjs --dry-run
 *   node scripts/cache-fonts.mjs --force
 */

import { parsePositiveInt } from "./lib/http-utils.mjs";
import {
  DEFAULT_FONT_CSS_URL,
  cacheProjectFonts,
} from "./lib/font-cache.mjs";

function parseArgs(argv) {
  const args = {
    dryRun: false,
    force: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/cache-fonts.mjs [--dry-run] [--force]

Downloads ${DEFAULT_FONT_CSS_URL}
and every relative .woff2 it references into static/fonts/ so the site can load
Fira Sans without cross-origin (CORS) font requests.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

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

  const summary = await cacheProjectFonts({
    dryRun: args.dryRun,
    force: args.force,
    timeoutMs,
    retries,
  });

  const failed = summary.results.filter((r) => r.status === "failed");
  console.log(
    [
      args.dryRun ? "Dry-run:" : "Cached fonts:",
      `css ${summary.cssStatus}`,
      `${summary.files} woff2 file(s)`,
      `${summary.downloaded} downloaded`,
      `${summary.cached} already local`,
      `${summary.failed} failed`,
      `→ ${summary.cssPath}`,
    ].join(" · ")
  );

  if (failed.length > 0) {
    console.warn("Failed font downloads:");
    for (const item of failed.slice(0, 20)) {
      console.warn(`  - ${item.file}`);
      console.warn(`    ${item.error}`);
    }
    if (failed.length > 20) {
      console.warn(`  … and ${failed.length - 20} more`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});

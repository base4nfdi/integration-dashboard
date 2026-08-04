#!/usr/bin/env node
/**
 * Run all incubator source parsers and write a combined comparison summary
 * against static/data.json (NocoDB export).
 *
 * Usage:
 *   node scripts/parse-source-pages.mjs
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, repoRoot, writeJson } from "./lib/parse-utils.mjs";

const PARSERS = [
  "parse-dmp4nfdi.mjs",
  "parse-iam4nfdi.mjs",
  "parse-ts4nfdi.mjs",
  "parse-pid4nfdi.mjs",
];

function runParser(file) {
  const script = join(repoRoot, "scripts", file);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) {
    throw new Error(`${file} failed to start: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${file} terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${file} failed with exit code ${result.status ?? "unknown"}`
    );
  }
}

function main() {
  for (const parser of PARSERS) {
    console.log(`\n=== ${parser} ===`);
    runParser(parser);
  }

  const comparisonHint =
    "Expected after a successful parser run under data/parsed/";
  const comparisons = {
    dmp4nfdi: readJson(
      join(repoRoot, "data/parsed/dmp4nfdi.comparison.json"),
      { hint: comparisonHint }
    ),
    iam4nfdi: readJson(
      join(repoRoot, "data/parsed/iam4nfdi.comparison.json"),
      { hint: comparisonHint }
    ),
    ts4nfdi: readJson(
      join(repoRoot, "data/parsed/ts4nfdi.comparison.json"),
      { hint: comparisonHint }
    ),
    pid4nfdi: readJson(
      join(repoRoot, "data/parsed/pid4nfdi.comparison.json"),
      { hint: comparisonHint }
    ),
  };

  const summary = {
    compared_at: new Date().toISOString(),
    nocodb_file: join(repoRoot, "static/data.json"),
    services: Object.fromEntries(
      Object.entries(comparisons).map(([id, cmp]) => [id, cmp.counts])
    ),
    comparisons,
  };

  const outPath = join(repoRoot, "data/parsed/comparison.json");
  writeJson(outPath, summary);

  console.log("\n=== Summary vs NocoDB ===");
  for (const [id, counts] of Object.entries(summary.services)) {
    console.log(
      `${id}: source=${counts.source} nocodb=${counts.nocodb} ` +
        `matched=${counts.matched} only_source=${counts.only_in_source} ` +
        `only_nocodb=${counts.only_in_nocodb}`
    );
  }
  console.log(`\nWrote ${outPath}`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(error.message ?? error);
    process.exit(1);
  }
}

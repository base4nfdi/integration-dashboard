#!/usr/bin/env node
/**
 * Fetches incubator source pages (HTML / JSON / Markdown) from public URLs
 * and stores them under data/sources/ for later processing into NocoDB.
 *
 * Usage:
 *   node scripts/fetch-source-pages.mjs
 *
 * Optional env:
 *   OUTPUT_DIR  — directory for stored sources (default: data/sources)
 *   FETCH_TIMEOUT_MS — per-request timeout (default: 60000)
 *   FETCH_RETRIES — retries after the first attempt (default: 2)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOk, parsePositiveInt } from "./lib/http-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

/** Known public incubator source pages. */
const SOURCES = [
  {
    id: "iam4nfdi",
    label: "IAM4NFDI Incubator Dashboard",
    url: "https://incubators.nfdi-aai.de/",
    type: "html",
    filename: "page.html",
  },
  {
    id: "ts4nfdi",
    label: "TS4NFDI Service Portal projects",
    url: "https://github.com/ts4nfdi/service-portal/blob/main/app/ui/incubators/projects.json",
    type: "json",
    filename: "projects.json",
  },
  {
    id: "dmp4nfdi",
    label: "DMP4NFDI incubator content",
    url: "https://github.com/base4nfdi/dmp4nfdi-website/blob/main/content/incubator/_index.md?plain=1",
    type: "markdown",
    filename: "incubator.md",
  },
  {
    id: "pid4nfdi",
    label: "PID4NFDI use cases",
    url: "https://pid.services.base4nfdi.de/community/use-cases/",
    type: "html",
    filename: "page.html",
  },
];

/**
 * Convert GitHub blob / tree page URLs to raw.githubusercontent.com fetch URLs.
 * Leaves non-GitHub URLs unchanged.
 */
export function toFetchUrl(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== "github.com") return url;

  const match = parsed.pathname.match(
    /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/
  );
  if (!match) return url;

  const [, owner, repo, ref, filePath] = match;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
}

/**
 * Infer a storage type from the Content-Type header when not configured.
 */
function typeFromContentType(contentType) {
  const ct = (contentType ?? "").toLowerCase();
  if (ct.includes("application/json") || ct.includes("+json")) return "json";
  if (ct.includes("text/html")) return "html";
  if (ct.includes("text/markdown") || ct.includes("text/x-markdown")) {
    return "markdown";
  }
  if (ct.includes("text/plain") || ct.includes("text/")) return "text";
  return "binary";
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Fetch a public page and return its body plus metadata.
 *
 * @param {string} url - Page or GitHub blob URL
 * @param {{ type?: "html"|"json"|"markdown"|"text"|"binary", timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<{
 *   url: string,
 *   fetchUrl: string,
 *   type: string,
 *   contentType: string | null,
 *   status: number,
 *   body: string | object,
 *   raw: string | Buffer,
 * }>}
 */
export async function fetchPage(url, options = {}) {
  const fetchUrl = toFetchUrl(url);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  const headers = {
    Accept: "*/*",
    "User-Agent": "base4nfdi-dashboard-source-fetch/1.0",
  };

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchOk(
        fetchUrl,
        { headers, redirect: "follow" },
        { timeoutMs, label: fetchUrl }
      );

      const contentType = response.headers.get("content-type");
      const type = options.type ?? typeFromContentType(contentType);

      if (type === "binary") {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.length === 0) {
          throw new Error(`Empty binary response from ${fetchUrl}`);
        }
        return {
          url,
          fetchUrl,
          type,
          contentType,
          status: response.status,
          body: buffer,
          raw: buffer,
        };
      }

      const text = await response.text();
      if (!text.trim()) {
        throw new Error(`Empty response body from ${fetchUrl}`);
      }

      let body = text;
      if (type === "json") {
        try {
          body = JSON.parse(text);
        } catch (error) {
          throw new Error(
            `Expected JSON from ${fetchUrl}, but parse failed: ${error.message}`
          );
        }
      }

      return {
        url,
        fetchUrl,
        type,
        contentType,
        status: response.status,
        body,
        raw: text,
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delayMs = 500 * 2 ** attempt;
        console.warn(
          `retry ${attempt + 1}/${retries} for ${fetchUrl} after ${delayMs}ms: ${error.message}`
        );
        await sleep(delayMs);
      }
    }
  }

  throw lastError;
}

function serializeBody(type, body, raw) {
  if (type === "json") {
    return JSON.stringify(body, null, 2) + "\n";
  }
  if (type === "binary") {
    return Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  }
  return typeof raw === "string" ? raw : String(body);
}

/**
 * Fetch one configured source (in memory; caller writes).
 */
export async function fetchSource(source, { timeoutMs, retries } = {}) {
  const result = await fetchPage(source.url, {
    type: source.type,
    timeoutMs,
    retries,
  });
  const payload = serializeBody(result.type, result.body, result.raw);
  const meta = {
    id: source.id,
    label: source.label,
    source_url: source.url,
    fetch_url: result.fetchUrl,
    type: result.type,
    content_type: result.contentType,
    status: result.status,
    filename: source.filename,
    fetched_at: new Date().toISOString(),
    bytes:
      typeof payload === "string"
        ? Buffer.byteLength(payload, "utf8")
        : payload.length,
  };
  return { source, result, payload, meta };
}

/**
 * Fetch one configured source and write it under outputDir/<id>/.
 */
export async function fetchAndStoreSource(source, outputDir, options = {}) {
  const { payload, meta } = await fetchSource(source, options);
  const dir = join(outputDir, source.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, source.filename), payload);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  return meta;
}

async function main() {
  const outputDir = resolve(
    repoRoot,
    process.env.OUTPUT_DIR ?? "data/sources"
  );
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );
  // Extra attempts after the first; 0 is allowed (no retries).
  const retryCount = Number(process.env.FETCH_RETRIES ?? 2);
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error(
      `FETCH_RETRIES must be a non-negative integer, got: ${process.env.FETCH_RETRIES}`
    );
  }

  mkdirSync(outputDir, { recursive: true });

  // Fetch all sources first so a mid-run failure does not leave a mixed set.
  const fetched = [];
  const failures = [];
  for (const source of SOURCES) {
    process.stdout.write(`Fetching ${source.id}… `);
    try {
      const item = await fetchSource(source, {
        timeoutMs,
        retries: retryCount,
      });
      fetched.push(item);
      console.log(
        `ok (${item.meta.bytes} bytes → ${source.id}/${source.filename})`
      );
    } catch (error) {
      failures.push({ id: source.id, error: error.message ?? String(error) });
      console.log("FAILED");
      console.error(`  ${error.message ?? error}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Failed to fetch ${failures.length}/${SOURCES.length} source(s): ` +
        failures.map((f) => f.id).join(", ")
    );
  }

  const results = [];
  for (const { source, payload, meta } of fetched) {
    const dir = join(outputDir, source.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, source.filename), payload);
    writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
    results.push(meta);
  }

  const manifest = {
    fetched_at: new Date().toISOString(),
    output_dir: outputDir,
    sources: results,
  };
  writeFileSync(
    join(outputDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  console.log(`\nStored ${results.length} source(s) under ${outputDir}`);
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

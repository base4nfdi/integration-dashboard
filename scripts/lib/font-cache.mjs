/**
 * Download Base4NFDI Nicepage font CSS + woff2 files into static/fonts/
 * so the site does not depend on cross-origin font loading (CORS).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { fetchOk } from "./http-utils.mjs";
import { repoRoot } from "./parse-utils.mjs";

export const DEFAULT_FONT_CSS_URL =
  "https://base4nfdi.de/components/com_nicepage/assets/css/fonts/fonts.css";
export const DEFAULT_FONT_DIR = "static/fonts";
export const DEFAULT_SITE_CSS_PATH = "fonts/fonts.css";

const FONT_URL_RE = /url\(\s*['"]?([^'")\s]+\.woff2)['"]?\s*\)/gi;

/**
 * @param {string} css
 * @returns {string[]}
 */
export function extractFontFilenames(css) {
  const names = new Set();
  for (const match of css.matchAll(FONT_URL_RE)) {
    const raw = String(match[1] ?? "").trim();
    if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith("data:")) continue;
    // Keep basename only — CSS uses relative paths beside fonts.css.
    names.add(basename(raw.split("?")[0]));
  }
  return [...names].sort();
}

/**
 * @param {string} cssUrl
 * @returns {string}
 */
export function fontBaseUrl(cssUrl) {
  const url = new URL(cssUrl);
  const path = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.replace(/[^/]+$/, "");
  return `${url.origin}${path}`;
}

/**
 * @param {string} fontDir
 * @returns {Record<string, unknown>}
 */
function loadManifest(fontDir) {
  const path = join(fontDir, "manifest.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * @param {string} fontDir
 * @param {Record<string, unknown>} manifest
 */
function saveManifest(fontDir, manifest) {
  mkdirSync(fontDir, { recursive: true });
  writeFileSync(
    join(fontDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
}

/**
 * @param {string} url
 * @param {{
 *   timeoutMs?: number,
 *   retries?: number,
 *   headers?: Record<string, string>,
 * }} [options]
 */
async function fetchBuffer(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  let lastError = "unknown error";

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchOk(
        url,
        {
          headers: {
            Accept: "*/*",
            "User-Agent": "base4nfdi-dashboard-font-cache/1.0",
            ...(options.headers ?? {}),
          },
          redirect: "follow",
        },
        { timeoutMs, label: url }
      );
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) throw new Error("Empty response");
      return { buffer, contentType: response.headers.get("content-type") };
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  throw new Error(lastError);
}

/**
 * Cache fonts.css and every relative .woff2 it references.
 *
 * @param {{
 *   cssUrl?: string,
 *   fontDir?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   concurrency?: number,
 * }} [options]
 */
export async function cacheProjectFonts(options = {}) {
  const cssUrl = options.cssUrl ?? DEFAULT_FONT_CSS_URL;
  const fontDir = options.fontDir ?? join(repoRoot, DEFAULT_FONT_DIR);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const concurrency = Math.max(1, Number(options.concurrency) || 8);
  const baseUrl = fontBaseUrl(cssUrl);
  const cssPath = join(fontDir, "fonts.css");
  const manifest = loadManifest(fontDir);

  let cssText;
  let cssStatus = "cached";

  if (!force && existsSync(cssPath)) {
    cssText = readFileSync(cssPath, "utf8");
  } else if (dryRun) {
    const { buffer } = await fetchBuffer(cssUrl, { timeoutMs, retries });
    cssText = buffer.toString("utf8");
    cssStatus = "downloaded";
  } else {
    const { buffer } = await fetchBuffer(cssUrl, {
      timeoutMs,
      retries,
      headers: { Accept: "text/css,*/*;q=0.8" },
    });
    cssText = buffer.toString("utf8");
    mkdirSync(fontDir, { recursive: true });
    writeFileSync(cssPath, cssText, "utf8");
    cssStatus = "downloaded";
  }

  const filenames = extractFontFilenames(cssText);
  /** @type {Array<{ file: string, status: string, error?: string }>} */
  const results = [];
  let cursor = 0;
  let downloaded = 0;
  let cached = 0;
  let failed = 0;

  async function worker() {
    while (cursor < filenames.length) {
      const index = cursor;
      cursor += 1;
      const file = filenames[index];
      const absPath = join(fontDir, file);
      const remoteUrl = new URL(file, baseUrl).href;

      if (!force && existsSync(absPath)) {
        cached += 1;
        results.push({ file, status: "cached" });
        continue;
      }

      if (dryRun) {
        downloaded += 1;
        results.push({ file, status: "downloaded" });
        continue;
      }

      try {
        const { buffer } = await fetchBuffer(remoteUrl, { timeoutMs, retries });
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, buffer);
        downloaded += 1;
        results.push({ file, status: "downloaded" });
        manifest[remoteUrl] = {
          path: `fonts/${file}`,
          source: remoteUrl,
          fetched_at: new Date().toISOString(),
        };
      } catch (error) {
        failed += 1;
        results.push({
          file,
          status: "failed",
          error: error?.message ?? String(error),
        });
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, Math.max(filenames.length, 1)) },
      () => worker()
    )
  );

  if (!dryRun) {
    manifest[cssUrl] = {
      path: DEFAULT_SITE_CSS_PATH,
      source: cssUrl,
      fetched_at: new Date().toISOString(),
      files: filenames.length,
    };
    saveManifest(fontDir, manifest);
  }

  return {
    cssUrl,
    cssPath: DEFAULT_SITE_CSS_PATH,
    cssStatus,
    files: filenames.length,
    downloaded,
    cached,
    failed,
    results,
    manifest,
  };
}

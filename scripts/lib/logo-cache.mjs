/**
 * Download remote partner logos into static/img/partner-logos/ once,
 * and rewrite logo_* fields to site-relative paths.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fetchOk } from "./http-utils.mjs";
import { repoRoot } from "./parse-utils.mjs";

export const LOGO_FIELDS = ["logo_project", "logo_consortia"];
export const DEFAULT_LOGO_DIR = "static/img/partner-logos";
export const DEFAULT_SITE_PREFIX = "img/partner-logos";

/**
 * Upstream hosts sometimes keep a broken logo URL after a path move.
 * Map stale remote URLs to the working replacement before fetch/cache.
 */
export const LOGO_URL_ALIASES = {
  // Chaldene: logo moved under docs/assets/ (IAM page still points at the old path)
  "https://github.com/c3di/chaldene/blob/master/logo_128x128.png?raw=true":
    "https://github.com/c3di/chaldene/blob/master/docs/assets/logo_128x128.png",
  "https://github.com/c3di/chaldene/blob/master/logo_128x128.png":
    "https://github.com/c3di/chaldene/blob/master/docs/assets/logo_128x128.png",
};

const EXT_BY_CONTENT_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

const KNOWN_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
]);

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeLogoUrl(value) {
  return String(value ?? "")
    .replace(/\s+/g, "")
    .trim();
}

/**
 * Apply known upstream URL corrections, then normalize.
 * @param {unknown} value
 * @returns {string}
 */
export function resolveLogoSourceUrl(value) {
  const url = normalizeLogoUrl(value);
  if (!url) return "";
  return LOGO_URL_ALIASES[url] ?? url;
}

/**
 * @param {string} url
 * @returns {boolean}
 */
export function isRemoteLogoUrl(url) {
  return /^https?:\/\//i.test(url);
}

/**
 * Stable short id for a remote logo URL.
 * @param {string} url
 */
export function logoIdForUrl(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

/**
 * @param {string | null | undefined} contentType
 * @param {string} url
 * @returns {string}
 */
function extensionFor(contentType, url) {
  const ct = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  if (EXT_BY_CONTENT_TYPE[ct]) return EXT_BY_CONTENT_TYPE[ct];

  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/(\.[a-z0-9]+)$/i);
    if (match) {
      const ext = match[1].toLowerCase() === ".jpeg" ? ".jpg" : match[1].toLowerCase();
      if (KNOWN_EXTS.has(ext)) return ext;
    }
  } catch {
    // ignore invalid URL
  }

  return ".bin";
}

/**
 * Convert GitHub blob URLs (and ?raw=true links) to raw content URLs when possible.
 * @param {string} url
 */
export function toLogoFetchUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  if (parsed.hostname === "github.com") {
    const match = parsed.pathname.match(
      /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/
    );
    if (match) {
      const [, owner, repo, ref, filePath] = match;
      return `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath}`;
    }
  }

  if (parsed.searchParams.get("raw") === "true") {
    parsed.searchParams.delete("raw");
    return parsed.toString();
  }

  return url;
}

/**
 * @param {string} absDir
 * @returns {Record<string, { path: string, fetched_at?: string | null, source?: string }>}
 */
function loadManifest(absDir) {
  const manifestPath = join(absDir, "manifest.json");
  if (!existsSync(manifestPath)) return {};
  try {
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} absDir
 * @param {Record<string, { path: string, fetched_at?: string | null, source?: string }>} manifest
 */
function saveManifest(absDir, manifest) {
  mkdirSync(absDir, { recursive: true });
  writeFileSync(
    join(absDir, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    "utf8"
  );
}

/**
 * Ensure a remote logo is present under static/ and return the site-relative path.
 * Skips the network request when the target file already exists.
 *
 * @param {string} remoteUrl
 * @param {{
 *   logoDir?: string,
 *   sitePrefix?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   manifest?: Record<string, { path: string, fetched_at?: string | null, source?: string }>,
 * }} [options]
 * @returns {Promise<{
 *   url: string,
 *   path: string | null,
 *   status: "cached" | "downloaded" | "failed" | "skipped",
 *   error?: string,
 * }>}
 */
export async function ensureLocalLogo(remoteUrl, options = {}) {
  const url = resolveLogoSourceUrl(remoteUrl);
  if (!url) {
    return { url: normalizeLogoUrl(remoteUrl), path: null, status: "skipped" };
  }
  if (!isRemoteLogoUrl(url)) {
    return { url, path: url, status: "skipped" };
  }

  const logoDir = options.logoDir ?? join(repoRoot, DEFAULT_LOGO_DIR);
  const sitePrefix = options.sitePrefix ?? DEFAULT_SITE_PREFIX;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const retries = options.retries ?? 2;
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const manifest = options.manifest ?? loadManifest(logoDir);

  const existing = manifest[url];
  if (existing?.path && !force) {
    const absFromSite = join(repoRoot, "static", existing.path);
    if (existsSync(absFromSite)) {
      return { url, path: existing.path, status: "cached" };
    }
  }

  const id = logoIdForUrl(url);
  const fetchUrl = toLogoFetchUrl(url);

  // Prefer an already-downloaded file for this URL id (any known extension).
  if (!force) {
    for (const ext of KNOWN_EXTS) {
      const candidatePath = `${sitePrefix}/${id}${ext}`;
      const absCandidate = join(repoRoot, "static", candidatePath);
      if (existsSync(absCandidate)) {
        manifest[url] = {
          path: candidatePath,
          source: url,
          fetched_at: manifest[url]?.fetched_at ?? null,
        };
        return { url, path: candidatePath, status: "cached" };
      }
    }
  }

  if (dryRun) {
    const guessedExt = extensionFor(null, url);
    return {
      url,
      path: `${sitePrefix}/${id}${guessedExt}`,
      status: "downloaded",
    };
  }

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchOk(
        fetchUrl,
        {
          headers: {
            Accept: "image/*,*/*;q=0.8",
            "User-Agent":
              options.userAgent ?? "base4nfdi-dashboard-logo-cache/1.0",
          },
          redirect: "follow",
        },
        { timeoutMs, label: fetchUrl }
      );

      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0) {
        throw new Error("Empty image response");
      }

      const ext = extensionFor(response.headers.get("content-type"), url);
      const sitePath = `${sitePrefix}/${id}${ext}`;
      const absPath = join(repoRoot, "static", sitePath);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, buffer);

      manifest[url] = {
        path: sitePath,
        source: url,
        fetched_at: new Date().toISOString(),
      };

      return { url, path: sitePath, status: "downloaded" };
    } catch (error) {
      lastError = error?.message ?? String(error);
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      }
    }
  }

  return { url, path: null, status: "failed", error: lastError };
}

/**
 * Collect unique remote logo URLs from dashboard records.
 * @param {Array<Record<string, unknown>>} records
 * @returns {string[]}
 */
export function collectRemoteLogoUrls(records) {
  const urls = new Set();
  for (const record of records ?? []) {
    for (const field of LOGO_FIELDS) {
      const url = resolveLogoSourceUrl(record?.[field]);
      if (isRemoteLogoUrl(url)) urls.add(url);
    }
  }
  return [...urls].sort();
}

/**
 * Cache logos for records and rewrite logo_* fields in place.
 *
 * @param {Array<Record<string, unknown>>} records
 * @param {{
 *   logoDir?: string,
 *   sitePrefix?: string,
 *   timeoutMs?: number,
 *   retries?: number,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   concurrency?: number,
 * }} [options]
 */
export async function localizeRecordLogos(records, options = {}) {
  const logoDir = options.logoDir ?? join(repoRoot, DEFAULT_LOGO_DIR);
  const concurrency = Math.max(1, Number(options.concurrency) || 6);
  const manifest = loadManifest(logoDir);
  const urls = collectRemoteLogoUrls(records);

  /** @type {Map<string, { url: string, path: string | null, status: string, error?: string }>} */
  const results = new Map();
  let cursor = 0;

  async function worker() {
    while (cursor < urls.length) {
      const index = cursor;
      cursor += 1;
      const url = urls[index];
      const result = await ensureLocalLogo(url, { ...options, logoDir, manifest });
      results.set(url, result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(urls.length, 1)) }, () =>
      worker()
    )
  );

  if (!options.dryRun) {
    saveManifest(logoDir, manifest);
  }

  let rewritten = 0;
  let failed = 0;
  let cached = 0;
  let downloaded = 0;

  for (const result of results.values()) {
    if (result.status === "cached") cached += 1;
    else if (result.status === "downloaded") downloaded += 1;
    else if (result.status === "failed") failed += 1;
  }

  for (const record of records ?? []) {
    for (const field of LOGO_FIELDS) {
      const original = normalizeLogoUrl(record[field]);
      if (!isRemoteLogoUrl(original)) continue;
      const result = results.get(resolveLogoSourceUrl(original));
      if (result?.path) {
        if (record[field] !== result.path) {
          record[field] = result.path;
          rewritten += 1;
        }
      }
    }
  }

  return {
    urls: urls.length,
    cached,
    downloaded,
    failed,
    rewritten,
    results: [...results.values()],
    manifest,
  };
}

/**
 * Rewrite logo_* frontmatter in incubator Markdown pages using a URL→path map.
 *
 * @param {string} contentDir
 * @param {Map<string, string> | Record<string, string>} urlToPath
 * @param {{ dryRun?: boolean }} [options]
 */
export function rewriteMarkdownLogoFields(contentDir, urlToPath, options = {}) {
  const map =
    urlToPath instanceof Map
      ? urlToPath
      : new Map(Object.entries(urlToPath ?? {}));

  const files = listMarkdownFiles(contentDir);
  let updated = 0;
  let touchedFields = 0;

  for (const filePath of files) {
    const original = readFileSync(filePath, "utf8");
    let next = original;
    let fileTouched = false;

    for (const field of LOGO_FIELDS) {
      const re = new RegExp(`^(${field}\\s*=\\s*")([^"]+)(")`, "gm");
      next = next.replace(re, (full, prefix, value, suffix) => {
        const url = normalizeLogoUrl(value);
        const local = map.get(url) ?? map.get(resolveLogoSourceUrl(url));
        if (!local || local === value) return full;
        fileTouched = true;
        touchedFields += 1;
        return `${prefix}${local}${suffix}`;
      });
    }

    if (fileTouched) {
      updated += 1;
      if (!options.dryRun) {
        writeFileSync(filePath, next, "utf8");
      }
    }
  }

  return { files: files.length, updated, touchedFields };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listMarkdownFiles(dir) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(dir)) return out;

  /** @param {string} current */
  function walk(current) {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".md")) out.push(full);
    }
  }

  walk(dir);
  return out;
}

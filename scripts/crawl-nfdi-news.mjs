#!/usr/bin/env node
/**
 * Crawl NFDI news + success stories via the WordPress REST API,
 * collect full post bodies, and scan for Base4NFDI / basic-service buzzwords.
 *
 * Sources:
 *   https://www.nfdi.de/news/?lang=en
 *   https://www.nfdi.de/success-stories/?lang=en
 *
 * Usage:
 *   node scripts/crawl-nfdi-news.mjs
 *   node scripts/crawl-nfdi-news.mjs --scope success-stories
 *   node scripts/crawl-nfdi-news.mjs --scope all
 *   node scripts/crawl-nfdi-news.mjs --dry-run --limit 20
 *
 * Optional env:
 *   OUTPUT_DIR       — raw posts directory (default: data/sources/nfdi-news)
 *   OUTPUT_JSON      — matches report (default: data/parsed/nfdi-news.json)
 *   FETCH_TIMEOUT_MS — per-request timeout (default: 60000)
 *   FETCH_RETRIES    — retries after the first attempt (default: 2)
 *   NEWS_LANG        — Polylang / WPML language code (default: en)
 *   NEWS_PER_PAGE    — WP API page size, max 100 (default: 100)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOk, parsePositiveInt } from "./lib/http-utils.mjs";
import { stripHtml } from "./lib/parse-utils.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const NEWS_LISTING_URL = "https://www.nfdi.de/news/?lang=en";
const SUCCESS_STORIES_LISTING_URL =
  "https://www.nfdi.de/success-stories/?lang=en";
const WP_POSTS_URL = "https://www.nfdi.de/wp-json/wp/v2/posts";
/** WordPress category id for "News" (matches /news/?lang=en listing). */
const NEWS_CATEGORY_ID = 43;
/**
 * WordPress category id for "Success Story"
 * (matches /success-stories/?lang=en filterable collection).
 */
const SUCCESS_STORY_CATEGORY_ID = 134;

const SCOPES = ["both", "news", "success-stories", "all"];

const DEFAULT_OUTPUT_DIR = join(repoRoot, "data/sources/nfdi-news");
const DEFAULT_OUTPUT_JSON = join(repoRoot, "data/parsed/nfdi-news.json");

/** @typedef {"news"|"success-story"} CollectionId */

/**
 * @param {string} scope
 * @returns {CollectionId[]|null} null = unrestricted (every English post)
 */
function collectionsForScope(scope) {
  if (scope === "news") return ["news"];
  if (scope === "success-stories") return ["success-story"];
  if (scope === "both") return ["news", "success-story"];
  return null;
}

/**
 * @param {string} scope
 */
function listingUrlsForScope(scope) {
  if (scope === "news") return [NEWS_LISTING_URL];
  if (scope === "success-stories") return [SUCCESS_STORIES_LISTING_URL];
  if (scope === "both") return [NEWS_LISTING_URL, SUCCESS_STORIES_LISTING_URL];
  return [NEWS_LISTING_URL, SUCCESS_STORIES_LISTING_URL];
}

/**
 * @param {number[]} categories
 * @returns {CollectionId[]}
 */
function collectionsFromCategories(categories) {
  const ids = Array.isArray(categories) ? categories : [];
  /** @type {CollectionId[]} */
  const collections = [];
  if (ids.includes(NEWS_CATEGORY_ID)) collections.push("news");
  if (ids.includes(SUCCESS_STORY_CATEGORY_ID)) collections.push("success-story");
  return collections;
}

/**
 * Buzzwords / service names to detect in title + full body.
 * Patterns are case-insensitive; aliases collapse to a stable `id`.
 */
const BUZZWORDS = [
  { id: "base4nfdi", label: "Base4NFDI", pattern: /\bbase4nfdi\b/gi },
  {
    id: "basic-service",
    label: "basic service",
    pattern: /\bbasic\s+services?\b/gi,
  },
  { id: "ts4nfdi", label: "TS4NFDI", pattern: /\bts4nfdi\b/gi },
  { id: "jupyter4nfdi", label: "Jupyter4NFDI", pattern: /\bjupyter4nfdi\b/gi },
  { id: "dmp4nfdi", label: "DMP4NFDI", pattern: /\bdmp4nfdi\b/gi },
  {
    id: "rdmtraining4nfdi",
    label: "RDMTraining4NFDI",
    pattern: /\brdm\s*training4nfdi\b|\brdmtraining4nfdi\b/gi,
  },
  { id: "rdmt4nfdi", label: "RDMT4NFDI", pattern: /\brdmt4nfdi\b/gi },
  { id: "pid4nfdi", label: "PID4NFDI", pattern: /\bpid4nfdi\b/gi },
  {
    id: "accounting4nfdi",
    label: "Accounting4NFDI",
    pattern: /\baccounting4nfdi\b/gi,
  },
  { id: "kgi4nfdi", label: "KGI4NFDI", pattern: /\bkgi4nfdi\b/gi },
  {
    id: "nfdi.software",
    label: "nfdi.software",
    pattern: /\bnfdi\.software\b/gi,
  },
  { id: "iam4nfdi", label: "IAM4NFDI", pattern: /\biam4nfdi\b/gi },
];

const HTML_ENTITY_NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decode common HTML entities (named + numeric) after tag stripping.
 * @param {string} text
 */
function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&([a-z]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(HTML_ENTITY_NAMED, key)
        ? HTML_ENTITY_NAMED[key]
        : match;
    });
}

/**
 * Drop Divi "Related Articles" / "Other posts" chrome that WP embeds in
 * content.rendered (otherwise every post inherits current related buzzwords).
 * @param {string} html
 */
export function stripRelatedChrome(html) {
  const text = decodeEntities(String(html ?? ""));
  const cutMarkers = [
    // Divi section; attribute quotes may be straight or curly.
    /\[et_pb_section[^\]]*Related Articles[^\]]*\]/i,
    /admin_label\s*=\s*.{0,3}Related Articles/i,
    /<h2[^>]*>\s*Other posts\s*<\/h2>/i,
    // Plain-text heading after Divi render (often tab-indented).
    /^\s*Other posts\s*$/im,
    /\bOther posts\b/i,
  ];

  let cutAt = text.length;
  for (const re of cutMarkers) {
    const match = re.exec(text);
    if (match) cutAt = Math.min(cutAt, match.index);
  }
  return text.slice(0, cutAt);
}

/**
 * Turn WP/Divi HTML into plain text suitable for scanning.
 * @param {string} html
 */
export function htmlToPlainText(html) {
  const main = stripRelatedChrome(html);
  const withoutShortcodes = main.replace(/\[[^\]]*\]/g, " ");
  return decodeEntities(stripHtml(withoutShortcodes))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} html
 */
function renderedTitle(html) {
  return htmlToPlainText(html).replace(/\s+/g, " ").trim();
}

async function sleep(ms) {
  await new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const args = {
    scope: "both",
    dryRun: false,
    limit: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      args.help = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--scope") {
      const value = argv[++i];
      if (!SCOPES.includes(value)) {
        throw new Error(
          `--scope must be one of ${SCOPES.join("|")}, got: ${value}`
        );
      }
      args.scope = value;
    } else if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (!SCOPES.includes(value)) {
        throw new Error(
          `--scope must be one of ${SCOPES.join("|")}, got: ${value}`
        );
      }
      args.scope = value;
    } else if (arg === "--limit") {
      args.limit = parsePositiveInt(argv[++i], 1, "--limit");
    } else if (arg.startsWith("--limit=")) {
      args.limit = parsePositiveInt(arg.slice("--limit=".length), 1, "--limit");
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Crawl NFDI news / success stories and scan for Base4NFDI buzzwords.

Usage:
  node scripts/crawl-nfdi-news.mjs [options]

Options:
  --scope both|news|success-stories|all
                     both            = News + Success Story categories (default)
                     news            = WP category "News" (/news/)
                     success-stories = WP category "Success Story" (/success-stories/)
                     all             = every English post
  --dry-run          Report only; do not write output files
  --limit <n>        Cap how many posts to fetch (for testing)
  -h, --help         Show this help

Environment:
  OUTPUT_DIR         Raw collection dir (default: data/sources/nfdi-news)
  OUTPUT_JSON        Matches report (default: data/parsed/nfdi-news.json)
  FETCH_TIMEOUT_MS   Request timeout (default: 60000)
  FETCH_RETRIES      Extra attempts after first (default: 2)
  NEWS_LANG          Polylang / WPML language (default: en)
  NEWS_PER_PAGE      WP page size ≤ 100 (default: 100)
`);
}

/**
 * Fetch one WP posts page; return list + totals from headers.
 * @param {string} url
 * @param {{ timeoutMs: number, retries: number }} options
 */
async function fetchPostsPage(url, { timeoutMs, retries }) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchOk(
        url,
        {
          headers: {
            Accept: "application/json",
            "User-Agent": "base4nfdi-dashboard-news-crawl/1.0",
          },
          redirect: "follow",
        },
        { timeoutMs, label: url }
      );

      const total = Number(response.headers.get("X-WP-Total") ?? "0");
      const totalPages = Number(response.headers.get("X-WP-TotalPages") ?? "0");
      const payload = await response.json();
      if (!Array.isArray(payload)) {
        throw new Error(`Expected JSON array from ${url}`);
      }

      return {
        posts: payload,
        total: Number.isFinite(total) ? total : payload.length,
        totalPages: Number.isFinite(totalPages) ? totalPages : 1,
      };
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        const delayMs = 500 * 2 ** attempt;
        console.warn(
          `retry ${attempt + 1}/${retries} for ${url} after ${delayMs}ms: ${error.message}`
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

/**
 * Paginate WordPress posts for one category filter (or unrestricted).
 * @param {{
 *   categoryId: number|null,
 *   label: string,
 *   lang: string,
 *   perPage: number,
 *   limit: number|null,
 *   timeoutMs: number,
 *   retries: number,
 * }} options
 */
async function collectPostsForCategory(options) {
  const { categoryId, label, lang, perPage, limit, timeoutMs, retries } =
    options;
  const fields = [
    "id",
    "date",
    "modified",
    "slug",
    "link",
    "title",
    "excerpt",
    "content",
    "categories",
    "tags",
  ].join(",");

  const collected = [];
  let page = 1;
  let total = null;
  let totalPages = null;

  while (true) {
    if (limit != null && collected.length >= limit) break;

    const params = new URLSearchParams({
      per_page: String(perPage),
      page: String(page),
      lang,
      _fields: fields,
      orderby: "date",
      order: "desc",
    });
    if (categoryId != null) {
      params.set("categories", String(categoryId));
    }

    const url = `${WP_POSTS_URL}?${params}`;
    process.stdout.write(`Fetching ${label} page ${page}… `);
    const result = await fetchPostsPage(url, { timeoutMs, retries });
    total = result.total;
    totalPages = result.totalPages;
    console.log(
      `ok (${result.posts.length} posts; total=${total}, pages=${totalPages})`
    );

    if (result.posts.length === 0) break;

    for (const post of result.posts) {
      collected.push(post);
      if (limit != null && collected.length >= limit) break;
    }

    if (page >= totalPages || result.posts.length < perPage) break;
    page += 1;
  }

  return {
    posts: collected,
    totalReported: total,
    totalPagesReported: totalPages,
    pagesFetched: page,
  };
}

/**
 * Paginate WordPress posts for the selected scope.
 * For `both`, fetches News and Success Story categories separately and merges
 * by post id (a post can appear in both collections).
 * @param {{
 *   scope: "both"|"news"|"success-stories"|"all",
 *   lang: string,
 *   perPage: number,
 *   limit: number|null,
 *   timeoutMs: number,
 *   retries: number,
 * }} options
 */
export async function collectPosts(options) {
  const { scope, lang, perPage, limit, timeoutMs, retries } = options;

  /** @type {{ categoryId: number|null, label: string }[]} */
  const queries =
    scope === "news"
      ? [{ categoryId: NEWS_CATEGORY_ID, label: "news" }]
      : scope === "success-stories"
        ? [
            {
              categoryId: SUCCESS_STORY_CATEGORY_ID,
              label: "success-stories",
            },
          ]
        : scope === "both"
          ? [
              { categoryId: NEWS_CATEGORY_ID, label: "news" },
              {
                categoryId: SUCCESS_STORY_CATEGORY_ID,
                label: "success-stories",
              },
            ]
          : [{ categoryId: null, label: "all-posts" }];

  /** @type {Map<number, object>} */
  const byId = new Map();
  let pagesFetched = 0;
  /** @type {Record<string, number|null>} */
  const totalsByQuery = {};

  for (const query of queries) {
    // For multi-query scopes, each query may use the full --limit; the merged
    // set is truncated after sort so dry-runs still sample both collections.
    const result = await collectPostsForCategory({
      categoryId: query.categoryId,
      label: query.label,
      lang,
      perPage,
      limit,
      timeoutMs,
      retries,
    });
    pagesFetched += result.pagesFetched;
    totalsByQuery[query.label] = result.totalReported;

    for (const post of result.posts) {
      if (byId.has(post.id)) continue;
      byId.set(post.id, post);
    }
  }

  let posts = Array.from(byId.values()).sort((a, b) =>
    String(b.date ?? "").localeCompare(String(a.date ?? ""))
  );
  if (limit != null && posts.length > limit) {
    posts = posts.slice(0, limit);
  }

  return {
    posts,
    totalReported:
      scope === "both"
        ? Object.values(totalsByQuery).reduce(
            (sum, n) => sum + (Number.isFinite(n) ? n : 0),
            0
          )
        : (totalsByQuery[queries[0].label] ?? posts.length),
    totalPagesReported: null,
    pagesFetched,
    totalsByQuery,
  };
}

/**
 * Normalize a WP post into a stored record.
 * @param {object} post
 */
export function normalizePost(post) {
  const title = renderedTitle(post?.title?.rendered ?? "");
  const excerpt = htmlToPlainText(post?.excerpt?.rendered ?? "");
  const content = htmlToPlainText(post?.content?.rendered ?? "");
  const scanText = [title, excerpt, content].filter(Boolean).join("\n\n");
  const categories = Array.isArray(post.categories) ? post.categories : [];

  return {
    id: post.id,
    date: post.date ?? null,
    modified: post.modified ?? null,
    slug: post.slug ?? "",
    link: post.link ?? "",
    title,
    excerpt,
    content,
    categories,
    tags: Array.isArray(post.tags) ? post.tags : [],
    collections: collectionsFromCategories(categories),
    scan_text: scanText,
  };
}

/**
 * Find buzzword hits and short context snippets in plain text.
 * @param {string} text
 * @param {typeof BUZZWORDS} [terms]
 */
export function scanBuzzwords(text, terms = BUZZWORDS) {
  const haystack = String(text ?? "");
  const matches = [];

  for (const term of terms) {
    const re = new RegExp(term.pattern.source, term.pattern.flags);
    const snippets = [];
    let match;
    while ((match = re.exec(haystack)) !== null) {
      const start = Math.max(0, match.index - 60);
      const end = Math.min(haystack.length, match.index + match[0].length + 60);
      let snippet = haystack.slice(start, end).replace(/\s+/g, " ").trim();
      if (start > 0) snippet = `…${snippet}`;
      if (end < haystack.length) snippet = `${snippet}…`;
      snippets.push(snippet);
      if (snippets.length >= 5) break;
      if (re.lastIndex === match.index) re.lastIndex += 1;
    }
    if (snippets.length > 0) {
      matches.push({
        id: term.id,
        label: term.label,
        count: snippets.length,
        snippets,
      });
    }
  }

  return matches;
}

/**
 * @param {ReturnType<typeof normalizePost>[]} posts
 */
export function buildReport(posts, meta) {
  const matched = [];
  const termCounts = Object.fromEntries(BUZZWORDS.map((t) => [t.id, 0]));
  const collectionCounts = {
    news: 0,
    "success-story": 0,
  };

  for (const post of posts) {
    for (const collection of post.collections ?? []) {
      if (collectionCounts[collection] != null) {
        collectionCounts[collection] += 1;
      }
    }

    const matches = scanBuzzwords(post.scan_text);
    if (matches.length === 0) continue;

    for (const m of matches) {
      termCounts[m.id] = (termCounts[m.id] ?? 0) + 1;
    }

    matched.push({
      id: post.id,
      date: post.date,
      slug: post.slug,
      link: post.link,
      title: post.title,
      categories: post.categories,
      collections: post.collections ?? [],
      matched_terms: matches.map((m) => m.id),
      matches,
    });
  }

  matched.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const sourceListings = listingUrlsForScope(meta.scope);

  return {
    fetched_at: meta.fetched_at,
    source_listing: sourceListings[0] ?? NEWS_LISTING_URL,
    source_listings: sourceListings,
    scope: meta.scope,
    lang: meta.lang,
    category_ids: collectionsForScope(meta.scope)
      ? Object.fromEntries(
          (collectionsForScope(meta.scope) ?? []).map((id) => [
            id,
            id === "news" ? NEWS_CATEGORY_ID : SUCCESS_STORY_CATEGORY_ID,
          ])
        )
      : null,
    posts_collected: posts.length,
    posts_matched: matched.length,
    collection_counts: collectionCounts,
    term_counts: termCounts,
    buzzwords: BUZZWORDS.map((t) => ({ id: t.id, label: t.label })),
    matches: matched,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const outputDir = resolve(
    repoRoot,
    process.env.OUTPUT_DIR ?? DEFAULT_OUTPUT_DIR
  );
  const outputJson = resolve(
    repoRoot,
    process.env.OUTPUT_JSON ?? DEFAULT_OUTPUT_JSON
  );
  const timeoutMs = parsePositiveInt(
    process.env.FETCH_TIMEOUT_MS,
    60_000,
    "FETCH_TIMEOUT_MS"
  );
  const retryCount = Number(process.env.FETCH_RETRIES ?? 2);
  if (!Number.isInteger(retryCount) || retryCount < 0) {
    throw new Error(
      `FETCH_RETRIES must be a non-negative integer, got: ${process.env.FETCH_RETRIES}`
    );
  }
  const lang = process.env.NEWS_LANG || "en";
  const perPage = parsePositiveInt(
    process.env.NEWS_PER_PAGE ?? 100,
    100,
    "NEWS_PER_PAGE"
  );
  if (perPage > 100) {
    throw new Error("NEWS_PER_PAGE must be ≤ 100 (WordPress API limit)");
  }

  const listingUrls = listingUrlsForScope(args.scope);
  console.log(
    `Crawling NFDI posts (scope=${args.scope}, lang=${lang}) via WP REST API`
  );
  for (const url of listingUrls) {
    console.log(`Listing page reference: ${url}`);
  }

  const collection = await collectPosts({
    scope: args.scope,
    lang,
    perPage,
    limit: args.limit,
    timeoutMs,
    retries: retryCount,
  });

  const posts = collection.posts.map(normalizePost);
  const fetchedAt = new Date().toISOString();
  const report = buildReport(posts, {
    fetched_at: fetchedAt,
    scope: args.scope,
    lang,
  });

  const sourcePayload = {
    fetched_at: fetchedAt,
    source_listing: listingUrls[0] ?? NEWS_LISTING_URL,
    source_listings: listingUrls,
    api: WP_POSTS_URL,
    scope: args.scope,
    lang,
    category_ids: {
      news: NEWS_CATEGORY_ID,
      "success-story": SUCCESS_STORY_CATEGORY_ID,
    },
    totals_by_query: collection.totalsByQuery,
    total_reported: collection.totalReported,
    total_pages_reported: collection.totalPagesReported,
    pages_fetched: collection.pagesFetched,
    posts: posts.map(({ scan_text, ...rest }) => rest),
  };

  const meta = {
    id: "nfdi-news",
    label: "NFDI news & success stories (English)",
    source_url: listingUrls[0] ?? NEWS_LISTING_URL,
    source_urls: listingUrls,
    fetch_url: WP_POSTS_URL,
    type: "json",
    scope: args.scope,
    lang,
    fetched_at: fetchedAt,
    posts_collected: posts.length,
    posts_matched: report.posts_matched,
    collection_counts: report.collection_counts,
    filename: "posts.json",
  };

  console.log(
    `\nCollected ${posts.length} post(s); ${report.posts_matched} match buzzwords.`
  );
  if (report.collection_counts) {
    console.log(
      `  collections: news=${report.collection_counts.news}, success-story=${report.collection_counts["success-story"]}`
    );
  }
  for (const [id, count] of Object.entries(report.term_counts)) {
    if (count > 0) console.log(`  ${id}: ${count} post(s)`);
  }
  if (report.matches.length) {
    console.log("\nMatched posts:");
    for (const hit of report.matches) {
      const collections =
        hit.collections?.length > 0 ? hit.collections.join("+") : "other";
      console.log(
        `  - ${hit.date?.slice(0, 10) ?? "????-??-??"}  [${collections}]  ${hit.title}`
      );
      console.log(`    ${hit.link}`);
      console.log(`    terms: ${hit.matched_terms.join(", ")}`);
    }
  }

  if (args.dryRun) {
    console.log("\nDry run: no files written.");
    return;
  }

  mkdirSync(outputDir, { recursive: true });
  mkdirSync(dirname(outputJson), { recursive: true });

  writeFileSync(
    join(outputDir, "posts.json"),
    JSON.stringify(sourcePayload, null, 2) + "\n"
  );
  writeFileSync(join(outputDir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(outputJson, JSON.stringify(report, null, 2) + "\n");

  console.log(`\nWrote ${join(outputDir, "posts.json")}`);
  console.log(`Wrote ${join(outputDir, "meta.json")}`);
  console.log(`Wrote ${outputJson}`);
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

# Dashboard Data Pipeline Scripts

Node.js utilities that fetch, parse, sync, and materialize integration data (incubators + use cases) for the Base4NFDI Integration Dashboard. They sit between public service sources, NocoDB, and the Zola content tree.

Most day-to-day work is covered by `./build.sh` at the repository root. The scripts below are the individual stages of that pipeline, plus maintenance tools for NocoDB.

---

## Prerequisites

| Requirement | Notes |
| --- | --- |
| **Node.js** | Required for all scripts (`node scripts/….mjs`) |
| **Zola** | Site build only (`./build.sh` / `zola build`) |
| **`.env` or env vars** | Needed for any script that talks to NocoDB |

Create an API token at [NocoDB account tokens](https://nocodb.nfdi.de/dashboard/#/account/tokens) and set:

```bash
NOCODB_API_TOKEN=your-xc-token
```

Scripts that need credentials load `.env` from the repository root when present.

---

## Pipeline overview

```text
Public sources          Parsed JSON              NocoDB / site
─────────────────       ─────────────────        ─────────────────
fetch-source-pages  →   parse-* / parse-source-pages
                        ↓                        ↓
                   data/parsed/*.json     fetch-nocodb-data → static/data.json
                        ↓                 (Incubators + User_Stories)
              push / patch / fill          generate-incubator-pages
                                           → content/incubators/{ts,dmp,iam,pid}/
```

**Typical build path** (`./build.sh`):

1. `fetch-source-pages.mjs` — download source pages  
2. `parse-source-pages.mjs` — parse all services + write comparison summary  
3. `fetch-nocodb-data.mjs` — refresh `static/data.json` from Incubators + User_Stories (skipped if no token)  
4. `cache-partner-logos.mjs` — download partner logos into `static/img/partner-logos/` (skip if already present) and rewrite local paths  
5. `cache-fonts.mjs` — download Base4NFDI `fonts.css` + `.woff2` files into `static/fonts/` (skip if already present)  
6. `generate-incubator-pages.mjs` — create missing Markdown report pages  
7. `zola build`

---

## Environment variables

### Shared (NocoDB)

| Variable | Default | Used by |
| --- | --- | --- |
| `NOCODB_API_TOKEN` | — (required for live API) | fetch, push, patch, fill |
| `NOCODB_BASE_URL` | `https://nocodb.nfdi.de` | same |
| `NOCODB_TABLE_ID` | incubators table id | same |
| `NOCODB_VIEW_ID` | unset for full-table dashboard export (view filters apply if set) | same |
| `NOCODB_USER_STORIES_TABLE_ID` | `mtq40pxpo5p0jmx` | fetch, PID push, schema ensure |
| `NOCODB_USER_STORIES_VIEW_ID` | unset for full-table export | fetch, PID push |
| `NOCODB_PAGE_SIZE` | `100` | same |
| `FETCH_TIMEOUT_MS` | `60000` | HTTP clients |

### Fetch / parse

| Variable | Default | Script |
| --- | --- | --- |
| `OUTPUT_DIR` | `data/sources` | `fetch-source-pages.mjs` |
| `FETCH_RETRIES` | `2` | `fetch-source-pages.mjs`, `cache-partner-logos.mjs`, `cache-fonts.mjs` |
| `OUTPUT_JSON` | `static/data.json` | `fetch-nocodb-data.mjs`, `cache-partner-logos.mjs` |
| `DMP_INPUT` / `DMP_OUTPUT` | `data/sources/dmp4nfdi/…` → `data/parsed/…` | `parse-dmp4nfdi.mjs` |
| `IAM_INPUT` / `IAM_OUTPUT` | `data/sources/iam4nfdi/…` → `data/parsed/…` | `parse-iam4nfdi.mjs` |
| `TS_INPUT` / `TS_OUTPUT` | `data/sources/ts4nfdi/…` → `data/parsed/…` | `parse-ts4nfdi.mjs` |
| `PID_INPUT` / `PID_OUTPUT` | `data/sources/pid4nfdi/…` → `data/parsed/…` | `parse-pid4nfdi.mjs` |
| `OUTPUT_DIR` / `OUTPUT_JSON` | `data/sources/nfdi-news` / `data/parsed/nfdi-news.json` | `crawl-nfdi-news.mjs` |
| `NEWS_LANG` / `NEWS_PER_PAGE` | `en` / `100` | `crawl-nfdi-news.mjs` |
| `NOCODB_PARTNERS_TABLE_ID` | partners table id | `push-source-pages-to-nocodb.mjs` |

---

## Scripts

### 1. Fetch source pages

**File:** `fetch-source-pages.mjs`

Downloads the public incubator sources used by the parsers and stores them under `data/sources/`:

| Source | Type | Stored as |
| --- | --- | --- |
| IAM4NFDI incubator dashboard | HTML | `data/sources/iam4nfdi/page.html` |
| TS4NFDI projects | JSON | `data/sources/ts4nfdi/projects.json` |
| DMP4NFDI incubator content | Markdown | `data/sources/dmp4nfdi/incubator.md` |
| PID4NFDI use cases | HTML | `data/sources/pid4nfdi/page.html` |

Also writes per-source `meta.json` and a top-level `manifest.json`. All sources must succeed; a partial failure aborts without writing a mixed set.

```bash
node scripts/fetch-source-pages.mjs
```

---

### 2. Parse source pages

#### Orchestrator — `parse-source-pages.mjs`

Runs the three service parsers in sequence, then merges their comparison reports into `data/parsed/comparison.json` (parsed sources vs `static/data.json`).

```bash
node scripts/parse-source-pages.mjs
```

#### Service parsers

Each parser reads a stored source file, emits NocoDB-aligned records, and writes a side-by-side comparison against the current NocoDB export.

| Script | Input (default) | Output |
| --- | --- | --- |
| `parse-dmp4nfdi.mjs` | `data/sources/dmp4nfdi/incubator.md` | `data/parsed/dmp4nfdi.json` (+ `.comparison.json`) |
| `parse-iam4nfdi.mjs` | `data/sources/iam4nfdi/page.html` | `data/parsed/iam4nfdi.json` (+ `.comparison.json`) |
| `parse-ts4nfdi.mjs` | `data/sources/ts4nfdi/projects.json` | `data/parsed/ts4nfdi.json` (+ `.comparison.json`) |
| `parse-pid4nfdi.mjs` | `data/sources/pid4nfdi/page.html` | `data/parsed/pid4nfdi.json` (+ `.comparison.json`) |

```bash
node scripts/parse-dmp4nfdi.mjs
node scripts/parse-iam4nfdi.mjs
node scripts/parse-ts4nfdi.mjs
node scripts/parse-pid4nfdi.mjs
```

Override paths with the `*_INPUT` / `*_OUTPUT` variables listed above when needed.

---

### 3. Fetch NocoDB data

**File:** `fetch-nocodb-data.mjs`

Pulls incubator rows from the Incubators table and use-case rows from User_Stories, normalizes partner/entity fields into a shared shape, and writes `static/data.json` (the site’s primary data feed). Refuses to overwrite the file if the Incubators API returns zero records.

```bash
node scripts/fetch-nocodb-data.mjs
```

Requires `NOCODB_API_TOKEN`.

---

### 4. Cache partner logos

**File:** `cache-partner-logos.mjs`

Downloads remote `logo_project` / `logo_consortia` images into `static/img/partner-logos/` and rewrites those fields in `static/data.json` plus incubator Markdown frontmatter to site-relative paths (`img/partner-logos/<id>.<ext>`). If a logo file already exists, the download is skipped.

```bash
node scripts/cache-partner-logos.mjs
node scripts/cache-partner-logos.mjs --dry-run
node scripts/cache-partner-logos.mjs --force
node scripts/cache-partner-logos.mjs --skip-markdown
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report planned downloads/rewrites; no files written |
| `--force` | Re-download even when a local file already exists |
| `--skip-markdown` | Only update `static/data.json` / logo files |
| `-h`, `--help` | Show usage |

A `manifest.json` beside the cached images maps source URL → local path.

Known broken upstream URLs can be remapped in `LOGO_URL_ALIASES` inside `scripts/lib/logo-cache.mjs` (e.g. Chaldene’s moved GitHub path) so builds keep working before the source site updates.

---

### 5. Cache project fonts

**File:** `cache-fonts.mjs`

Downloads the Base4NFDI Nicepage `fonts.css` and every relative `.woff2` it references into `static/fonts/`. The site template loads the local stylesheet so Fira Sans is not blocked by missing CORS headers on the upstream host. Existing files are skipped unless `--force` is passed.

```bash
node scripts/cache-fonts.mjs
node scripts/cache-fonts.mjs --dry-run
node scripts/cache-fonts.mjs --force
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report planned downloads; no files written (CSS is still fetched to discover file list) |
| `--force` | Re-download even when local files already exist |
| `-h`, `--help` | Show usage |

A `manifest.json` beside the cached fonts maps source URL → local path.

---

### 6. Generate incubator pages

**File:** `generate-incubator-pages.mjs`

Creates missing Markdown report pages under `content/incubators/{ts,dmp,iam,pid}/` from `static/data.json`. Existing files are left alone unless `--force` is passed.

```bash
node scripts/generate-incubator-pages.mjs
node scripts/generate-incubator-pages.mjs --dry-run
node scripts/generate-incubator-pages.mjs --force
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report what would be written; no files created |
| `--force` | Overwrite existing Markdown files |
| `-h`, `--help` | Show usage |

---

### 7. Push parsed sources into NocoDB

**File:** `push-source-pages-to-nocodb.mjs`

Creates incubator rows that exist in `data/parsed/{dmp,iam,ts}4nfdi.json` but not yet in NocoDB. Default mode is dry-run; use `--apply` to insert.

```bash
node scripts/push-source-pages-to-nocodb.mjs
node scripts/push-source-pages-to-nocodb.mjs --apply
node scripts/push-source-pages-to-nocodb.mjs --service dmp4nfdi,ts4nfdi
node scripts/push-source-pages-to-nocodb.mjs --limit 5 --apply
node scripts/push-source-pages-to-nocodb.mjs --local
```

| Flag | Effect |
| --- | --- |
| `--apply` | Create rows in NocoDB |
| `--dry-run` | Preview only (default) |
| `--local` | Compare against `static/data.json` instead of a live fetch |
| `--service <ids>` | Comma-separated: `dmp4nfdi`, `iam4nfdi`, `ts4nfdi` |
| `--limit <n>` | Cap how many records are pushed after filtering |
| `-h`, `--help` | Show usage |

Requires `NOCODB_API_TOKEN` for live NocoDB access (not needed for `--local` dry comparison against the local export).

---

### 8. Patch logo fields

**File:** `patch-logo-consortia.mjs`

Matches parsed records to existing NocoDB rows and updates `logo_consortia` / `logo_project` where the source value is non-empty and differs. Default is dry-run; `--apply` PATCHes NocoDB.

```bash
node scripts/patch-logo-consortia.mjs
node scripts/patch-logo-consortia.mjs --local
node scripts/patch-logo-consortia.mjs --service dmp4nfdi,ts4nfdi
node scripts/patch-logo-consortia.mjs --only-host https://www.dmp4nfdi.de/
node scripts/patch-logo-consortia.mjs --service ts4nfdi --apply
```

| Flag | Effect |
| --- | --- |
| `--apply` | PATCH NocoDB |
| `--dry-run` | Preview only (default) |
| `--local` | Compare against `static/data.json` (no live fetch) |
| `--service <ids>` | Limit to selected parsers |
| `--only-host <prefix>` | Only rewrite existing logos whose URL starts with the prefix; empty logos are still filled |
| `--limit <n>` | Cap number of row updates |
| `-h`, `--help` | Show usage |

---

### 9. Fill empty key articles

**File:** `fill-key-articles.mjs`

Maintenance helper: fills blank `key_article` values using `{basic_service}-{inc_name}` (lowercased / slugified), e.g. TS + RADAR → `ts-radar`. Existing non-empty values are never overwritten.

```bash
node scripts/fill-key-articles.mjs
node scripts/fill-key-articles.mjs --apply
```

| Flag | Effect |
| --- | --- |
| `--apply` | PATCH NocoDB |
| `--dry-run` | Preview only (default) |
| `-h`, `--help` | Show usage |

Requires `NOCODB_API_TOKEN`.

---

### 10. Ensure User_Stories schema / push PID use cases

**Files:** `ensure-user-stories-schema.mjs`, `push-pid-use-cases-to-nocodb.mjs`

Creates Incubators-aligned columns on the NocoDB User_Stories table (idempotent), then inserts parsed PID use cases. Both default to dry-run-safe behaviour (`ensure` writes unless `--dry-run`; `push` requires `--apply`).

```bash
node scripts/ensure-user-stories-schema.mjs --dry-run
node scripts/ensure-user-stories-schema.mjs
node scripts/push-pid-use-cases-to-nocodb.mjs
node scripts/push-pid-use-cases-to-nocodb.mjs --apply
```

### 11. Crawl NFDI news for Base4NFDI buzzwords

**File:** `crawl-nfdi-news.mjs`

Collects English NFDI news posts that appear on [nfdi.de/news](https://www.nfdi.de/news/?lang=en) (WordPress REST API, full article bodies) and scans them for Base4NFDI / basic-service terms. Divi “Related Articles” / “Other posts” footers are stripped before scanning so related-post chrome does not create false hits:

`Base4NFDI`, `basic service(s)`, `TS4NFDI`, `Jupyter4NFDI`, `DMP4NFDI`, `RDMTraining4NFDI`, `RDMT4NFDI`, `PID4NFDI`, `Accounting4NFDI`, `KGI4NFDI`, `nfdi.software`, `IAM4NFDI`.

Writes the full collection under `data/sources/nfdi-news/` and a matches report to `data/parsed/nfdi-news.json`.

```bash
node scripts/crawl-nfdi-news.mjs
node scripts/crawl-nfdi-news.mjs --scope all
node scripts/crawl-nfdi-news.mjs --dry-run --limit 20
```

| Flag | Effect |
| --- | --- |
| `--scope news` | Only the WordPress **News** category (default; matches the listing page) |
| `--scope all` | Every English post (newsletters, success stories, press, …) |
| `--dry-run` | Print summary only; do not write files |
| `--limit <n>` | Cap how many posts to fetch (testing) |
| `-h`, `--help` | Show usage |

| Variable | Default | Notes |
| --- | --- | --- |
| `OUTPUT_DIR` | `data/sources/nfdi-news` | Raw posts + `meta.json` |
| `OUTPUT_JSON` | `data/parsed/nfdi-news.json` | Matches report |
| `NEWS_LANG` | `en` | Polylang language code |
| `NEWS_PER_PAGE` | `100` | WP API page size (max 100) |
| `FETCH_TIMEOUT_MS` / `FETCH_RETRIES` | `60000` / `2` | Shared HTTP settings |

---

## Shared libraries

These modules are imported by the scripts above; they are not meant to be run directly.

| Module | Role |
| --- | --- |
| `lib/http-utils.mjs` | Timed `fetch`, retries helpers, NocoDB list pagination |
| `lib/parse-utils.mjs` | Record shape, date/status/partner normalization, NocoDB matching, JSON I/O |
| `lib/logo-cache.mjs` | Partner logo download, manifest, Markdown/data path rewrites |
| `lib/font-cache.mjs` | Project font CSS + woff2 download into `static/fonts/` |

---

## Recommended workflows

### Refresh site data and rebuild

```bash
./build.sh
```

### Re-parse sources only (offline)

```bash
node scripts/parse-source-pages.mjs
```

Inspect `data/parsed/comparison.json` for source vs NocoDB diffs.

### Onboard new incubators into NocoDB

```bash
node scripts/fetch-source-pages.mjs
node scripts/parse-source-pages.mjs
node scripts/push-source-pages-to-nocodb.mjs            # review dry-run
node scripts/push-source-pages-to-nocodb.mjs --apply
node scripts/fetch-nocodb-data.mjs
node scripts/generate-incubator-pages.mjs
```

### Onboard PID use cases into User_Stories

Source of truth: [PID4NFDI use cases](https://pid.services.base4nfdi.de/community/use-cases/). Rows land in the NocoDB [User_Stories](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/mtq40pxpo5p0jmx/vwlhq1q3k6gcqrjd/user_stories) table and are merged into the Integration Dashboard export.

```bash
node scripts/ensure-user-stories-schema.mjs             # create aligned columns (once)
node scripts/fetch-source-pages.mjs
node scripts/parse-pid4nfdi.mjs
node scripts/push-pid-use-cases-to-nocodb.mjs           # review dry-run
node scripts/push-pid-use-cases-to-nocodb.mjs --apply
node scripts/fetch-nocodb-data.mjs
node scripts/generate-incubator-pages.mjs
```

### Sync logos from sources

```bash
node scripts/parse-source-pages.mjs
node scripts/patch-logo-consortia.mjs --local           # optional preview vs export
node scripts/patch-logo-consortia.mjs --apply
node scripts/fetch-nocodb-data.mjs
node scripts/cache-partner-logos.mjs                   # materialize static copies
```

---

## Safety notes

- Scripts that mutate NocoDB default to **dry-run**. Pass `--apply` only after reviewing the preview output.
- Prefer `--local` when iterating on matching logic without hitting the live API.
- Keep `NOCODB_API_TOKEN` out of version control; use `.env` or CI secrets.

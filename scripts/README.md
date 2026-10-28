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
                                           → content/integrations/{ts,dmp,iam,pid}/

Already published rows are not created again. During `./build.sh` (when NocoDB
credentials are available), `patch-published-integrations.mjs --apply` fills
fields the detail page is missing and sets status to Finished when `inc_end` is
before today. Parsers apply that same end-date rule while parsing.
```

## What the basic services get back

Traffic is one way. IAM4NFDI, TS4NFDI, DMP4NFDI, and PID4NFDI publish public pages. This repository reads those pages and the NocoDB tables. It does not write comments, status, or corrections back to the service sites.

What a service gets is a public Integration Dashboard entry: an overview row in `static/data.json` and, once a page exists, a detail page under `content/integrations/`. That only happens for rows that are already in NocoDB. A new incubator on a service site stays off the dashboard until someone reviews `push-source-pages-to-nocodb.mjs` (or `push-pid-use-cases-to-nocodb.mjs` for PID) and passes `--apply`. `./build.sh` does not create those rows.

NocoDB remains the record the site publishes. Editors can correct wording, partners, and status there. The next build will not replace a filled cell with the public-source text (see below).

## When the dashboard updates

There is no cron job in this repository. `static/data.json` and the generated pages change only when someone runs `./build.sh` (or the same scripts) with `NOCODB_API_TOKEN` or a root `.env`. Without credentials the build keeps the `static/data.json` already in the tree and still rebuilds the site from it.

A build does not rewrite every NocoDB row. `patch-published-integrations.mjs` matches parsed records to existing rows and then:

| Situation | What the build does |
| --- | --- |
| Cell is empty and the public source has a value | Fills that cell |
| Description is a strict prefix of the newer source text | Replaces the description with the full source text |
| Description, dates, partners, or other filled cells differ from the source | Leaves the NocoDB value |
| End date is before today | Sets status to `Finished`. Does not move `Finished` back to `Running` |
| Source has a row that is not in NocoDB | Leaves it out. Onboarding is a separate `--apply` push |
| NocoDB has a row the public source no longer lists | Leaves the row, its partners, and its Markdown page |

So a withdrawn or never-started incubator (workflow change, incubator that did not begin) stays on the dashboard until someone deletes or archives that row in NocoDB. The scripts do not delete rows, and `generate-incubator-pages.mjs` does not remove Markdown for rows that disappeared. `fetch-nocodb-data.mjs` also refuses to replace `static/data.json` when the Incubators API returns zero records, so an empty API response cannot wipe the export.

Compare a fresh parse with the current export in `data/parsed/comparison.json` before pushing or patching. Patch and push default to dry-run outside `./build.sh`.

**Typical build path** (`./build.sh`):

1. `fetch-source-pages.mjs` — download source pages  
2. `parse-source-pages.mjs` — parse all services + write comparison summary  
3. `crawl-nfdi-news.mjs --scope both` — collect English NFDI news and success stories, then write `data/parsed/nfdi-news.json`  
4. `ensure-incubators-schema.mjs` — ensure Incubator columns used by detail pages (skipped if no token)  
5. `patch-published-integrations.mjs --apply` — backfill published rows when public sources have grown (skipped if no token)  
6. `fetch-nocodb-data.mjs` — refresh `static/data.json` from Incubators + User_Stories (skipped if no token)  
7. `sync-ref-directory.mjs` — sync partner and institution logos (skipped if no token)  
8. `cache-partner-logos.mjs` — download partner logos into `static/img/partner-logos/` (skip if already present) and rewrite local paths  
9. `cache-fonts.mjs` — download Base4NFDI `fonts.css` + `.woff2` files into `static/fonts/` (skip if already present)  
10. `generate-incubator-pages.mjs` — create missing Markdown pages; `--update` when NocoDB was refreshed  
11. `zola build`

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
| `NOCODB_REF_ENTITIES_TABLE_ID` | `7v80fm7p5jpa7xj` | `push-ref-entities-to-nocodb.mjs` |
| `NOCODB_REF_ENTITIES_VIEW_ID` | unset for full-table access | `push-ref-entities-to-nocodb.mjs` |
| `NOCODB_PARTNERS_TABLE_ID` | `pf8ggs9jduxse4x` | `push-source-pages-to-nocodb.mjs`, `patch-ref-partners-logos.mjs` |
| `NOCODB_PARTNERS_VIEW_ID` | unset for full-table access | `patch-ref-partners-logos.mjs` |
| `NOCODB_PAGE_SIZE` | `100` | same |
| `FETCH_TIMEOUT_MS` | `60000` | HTTP clients |
| `WIKIDATA_USER_AGENT` | Base4NFDI dashboard UA | `push-ref-entities-to-nocodb.mjs`, `patch-ref-partners-logos.mjs` |

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
| PID4NFDI use cases | Markdown | `data/sources/pid4nfdi/use-cases.md` |

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
| `parse-pid4nfdi.mjs` | `data/sources/pid4nfdi/use-cases.md` | `data/parsed/pid4nfdi.json` (+ `.comparison.json`) |

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

### 6. Generate integration pages

**File:** `generate-incubator-pages.mjs`

Creates missing Markdown integration pages under `content/integrations/{ts,dmp,iam,pid}/` from `static/data.json`. Existing files are left alone unless `--force` is passed.

```bash
node scripts/generate-incubator-pages.mjs
node scripts/generate-incubator-pages.mjs --dry-run
node scripts/generate-incubator-pages.mjs --force
```

| Flag | Effect |
| --- | --- |
| `--dry-run` | Report what would be written; no files created |
| `--update` | Rewrite an existing page when generated Markdown differs |
| `--force` | Overwrite existing Markdown files |
| `-h`, `--help` | Show usage |

`--update` rewrites an existing page when generated Markdown differs. `./build.sh`
runs it automatically after a NocoDB refresh (patch + `fetch-nocodb-data.mjs`).

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

Create payloads include `inc_activity_type`, `inc_caai`, `inc_ownership`, `inc_service_type`, and `inc_activity_page`. Run `ensure-incubators-schema.mjs` once before the first create or patch that writes those columns.

---

### 8. Ensure Incubators columns

**File:** `ensure-incubators-schema.mjs`

Creates the Incubators columns the detail pages need for source fields that were previously dropped:

| Column | Type | Source |
| --- | --- | --- |
| `inc_activity_type` | single-line text | IAM activity badge |
| `inc_caai` | single-line text | IAM `CAAI:` badge (`regapp`, …) |
| `inc_service_type` | single-line text | DMP service list |
| `inc_ownership` | long text | IAM ownership & utilisation |
| `inc_activity_page` | URL | IAM / TS activity page |

Idempotent. Writes unless `--dry-run`. User_Stories is unchanged.

```bash
node scripts/ensure-incubators-schema.mjs --dry-run
node scripts/ensure-incubators-schema.mjs
```

---

### 9. Patch already published integrations

**File:** `patch-published-integrations.mjs`

Updates matched incubator and PID use-case rows when the public source has grown. Default is dry-run. Existing wording is left alone.

| Change | Rule |
| --- | --- |
| Dates, cycle, goals, results, activity type, CAAI, ownership, service type, activity page | Fill only when the NocoDB cell is empty |
| Description | Fill when empty. If the stored text is a strict prefix of the source (a missing tail), replace it with the source text |
| PID use-case fields (`uc_labels`, `pid_providers`, …) | Fill only when empty |
| Partners | Link REF_Partners only when the row has no partners. A non-empty set is not replaced |
| Publication count | Set only when NocoDB is 0 and the source count is greater |
| Status | Set `Finished` when the end date (source, otherwise the stored date) is before today, even if the badge still says Running. Fill an empty status from the source. Never move Finished back to Running |

Parsers apply the same finished-by-end-date rule, so a new parse already shows `Finished` when `inc_end` is in the past.

```bash
node scripts/parse-source-pages.mjs
node scripts/patch-published-integrations.mjs --local
node scripts/patch-published-integrations.mjs --apply
node scripts/fetch-nocodb-data.mjs
node scripts/generate-incubator-pages.mjs --update
```

| Flag | Effect |
| --- | --- |
| `--apply` | PATCH NocoDB |
| `--dry-run` | Preview only (default) |
| `--local` | Compare against `static/data.json` |
| `--service <ids>` | `dmp4nfdi`, `iam4nfdi`, `ts4nfdi`, `pid4nfdi` |
| `--limit <n>` | Cap how many row updates are applied |
| `-h`, `--help` | Show usage |

Writes `data/parsed/published-integrations.patch-report.json`. Requires `NOCODB_API_TOKEN` for a live fetch or `--apply`. Partner links need the token even in `--local` mode; without it, unresolved partner names are reported and not written.

---

### 10. Patch logo fields

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

### 11. Fill empty key articles

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

### 12. Ensure User_Stories schema / push PID use cases

**Files:** `ensure-user-stories-schema.mjs`, `push-pid-use-cases-to-nocodb.mjs`

Ensures User_Stories has use-case columns (`uc_name`, `uc_descr`, `key_article`, `basic_service`, …). Renames legacy `title` → `uc_name` when needed. Then creates missing PID rows and backfills blank use-case fields on matches. `ensure` writes unless `--dry-run`; `push` requires `--apply`.

```bash
node scripts/ensure-user-stories-schema.mjs --dry-run
node scripts/ensure-user-stories-schema.mjs
node scripts/push-pid-use-cases-to-nocodb.mjs
node scripts/push-pid-use-cases-to-nocodb.mjs --apply
```

### 13. Sync REF_Entities from Wikidata

**File:** `push-ref-entities-to-nocodb.mjs`

Pulls German research institutes from the [Wikidata Query Service](https://query.wikidata.org/) (`P31=Q31855`, `P17=Q183`) with English `name`, `official_website` (`P856`), and `official_logo` (`P154`), then syncs them into the NocoDB [REF_Entities](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/7v80fm7p5jpa7xj/9avpyay7fl9c5ar/ref_entities) table. Existing rows are matched by `wikidata_identifier` (Q-id) or normalized `name` and only receive missing website/logo values (never overwrites filled cells).

Also supports an interactive `--search` mode: look up a candidate by name, preview Wikidata fields, and confirm insert/backfill.

```bash
node scripts/push-ref-entities-to-nocodb.mjs
node scripts/push-ref-entities-to-nocodb.mjs --backfill-only --apply
node scripts/push-ref-entities-to-nocodb.mjs --limit 25 --apply
node scripts/push-ref-entities-to-nocodb.mjs --search "FIZ Karlsruhe"
node scripts/push-ref-entities-to-nocodb.mjs --search "DKRZ" --pick 1 --apply
```

| Flag | Effect |
| --- | --- |
| `--apply` | POST/PATCH NocoDB |
| `--dry-run` | Preview only (default) |
| `--backfill-only` | Only fill blank website/logo on existing rows |
| `--limit <n>` | Cap creates |
| `--search <name>` | Interactive Wikidata lookup + optional insert |
| `--pick <n>` | With `--search`, select result *n* without a prompt |
| `-h`, `--help` | Show usage |

Writes a plan to `data/parsed/ref-entities.push-report.json`. Requires `NOCODB_API_TOKEN`. Wikidata has ~2k German research institutes — review the dry-run (or use `--backfill-only` / `--limit`) before `--apply`.

### 14. Patch REF_Partners official logos

**File:** `patch-ref-partners-logos.mjs`

Fills blank `official_logo` on the NocoDB [REF_Partners](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/pf8ggs9jduxse4x/wfo9jjldqwgz5ky/ref_partners) table. Existing values are never overwritten. Candidates, in order:

1. Wikidata `P154` (Commons FilePath) via the row’s `wikidata_identifier`
2. Name-matched remote `logo_consortia` from `data/parsed/{dmp,iam,ts,pid}4nfdi.json` (and `static/data.json` after reversing cached paths through `static/img/partner-logos/manifest.json`)
3. Zenodo community logos from `communities.csv` in the sibling [zenodo-analyzer](https://github.com/base4nfdi) checkout (`../../zenodo-analyzer/communities.csv`, or `ZENODO_COMMUNITIES_CSV`). Matched by community title or slug (`nfdi4ds` → NFDI4DataScience, `punch4nfdi` → PUNCH4NFDI, …). Conference, plenary, and CC/WG communities are ignored.

A dashboard logo is used only when the incubator row has **exactly one** partner and the URL/filename contains that partner’s slug. Combined / project logos (RADAR, Coscine, WissKI, …) are skipped. When several dashboard URLs match, the consortium’s own host (Wikidata `P856`) is preferred over `dmp.services.base4nfdi.de` / `incubators.nfdi-aai.de`.

```bash
node scripts/patch-ref-partners-logos.mjs
node scripts/patch-ref-partners-logos.mjs --limit 10
node scripts/patch-ref-partners-logos.mjs --apply
```

| Flag | Effect |
| --- | --- |
| `--apply` | PATCH NocoDB |
| `--dry-run` | Preview only (default) |
| `--limit <n>` | Cap number of row updates |
| `-h`, `--help` | Show usage |

Writes a plan to `data/parsed/ref-partners-logos.push-report.json`. Requires `NOCODB_API_TOKEN`. NFDI sections / circles without a named logo are left empty.

### 15. Patch REF_Partners official websites

**File:** `patch-ref-partners-websites.mjs`

Fills blank `official_website` on [REF_Partners](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/pf8ggs9jduxse4x/wfo9jjldqwgz5ky/ref_partners) from Wikidata `P856` (`wikidata_identifier`). Existing values are never overwritten. Sections, task forces, circles, and other bodies without a Q-id are left empty.

A few retired hosts are rewritten to the live homepage: `nfdi4plants.de` → `https://nfdi4plants.org`, `ghga.dkfz.de` → `https://www.ghga.de/`, `eosc-hub.eu` → `https://eosc.eu/`, `nfdi4energy.de` → `https://nfdi4energy.uol.de/`.

```bash
node scripts/patch-ref-partners-websites.mjs
node scripts/patch-ref-partners-websites.mjs --apply
```

Writes a plan to `data/parsed/ref-partners-websites.push-report.json`. Requires `NOCODB_API_TOKEN`.

### 16. Sync REF logo directory

**File:** `sync-ref-directory.mjs`

Reads [REF_Partners](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/pf8ggs9jduxse4x/wfo9jjldqwgz5ky/ref_partners) and [REF_Entities](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/7v80fm7p5jpa7xj/9avpyay7fl9c5ar/ref_entities) and writes `static/ref-directory.json` (`name`, local `logo`, `official_website`, source URL, `updated_at`). Logos are stored under `static/img/ref-logos/`. A file is downloaded again only when the logo URL changes or NocoDB `updated_at` is newer than the stored copy. Commons `Special:FilePath` links are resolved to `upload.wikimedia.org` before download. A `projects` map holds homepages that are not partner or entity rows (Sensor Management System, also matched as SensorCV). The sync keeps that map.

```bash
node scripts/sync-ref-directory.mjs
node scripts/sync-ref-directory.mjs --dry-run
node scripts/sync-ref-directory.mjs --force
```

Requires `NOCODB_API_TOKEN`. Does not write back to NocoDB. `./build.sh` runs this after `fetch-nocodb-data.mjs`.

### 17. Crawl NFDI news & success stories for Base4NFDI buzzwords

**File:** `crawl-nfdi-news.mjs`

Collects English posts from [nfdi.de/news](https://www.nfdi.de/news/?lang=en) and [nfdi.de/success-stories](https://www.nfdi.de/success-stories/?lang=en) via the WordPress REST API (full article bodies) and scans them for Base4NFDI / basic-service terms. Success stories use WP category **Success Story** (`134`); news uses **News** (`43`). Divi “Related Articles” / “Other posts” footers are stripped before scanning so related-post chrome does not create false hits:

`Base4NFDI`, `basic service(s)`, `TS4NFDI`, `Jupyter4NFDI`, `DMP4NFDI`, `RDMTraining4NFDI`, `RDMT4NFDI`, `PID4NFDI`, `Accounting4NFDI`, `KGI4NFDI`, `nfdi.software`, `IAM4NFDI`.

Writes the full collection under `data/sources/nfdi-news/` and a matches report to `data/parsed/nfdi-news.json`. Each post records `collections` (`news` / `success-story`).

```bash
node scripts/crawl-nfdi-news.mjs
node scripts/crawl-nfdi-news.mjs --scope success-stories
node scripts/crawl-nfdi-news.mjs --scope all
node scripts/crawl-nfdi-news.mjs --dry-run --limit 20
```

| Flag | Effect |
| --- | --- |
| `--scope both` | **News** + **Success Story** categories (default) |
| `--scope news` | Only the WordPress **News** category (`/news/`) |
| `--scope success-stories` | Only the **Success Story** category (`/success-stories/`) |
| `--scope all` | Every English post (newsletters, press, …) |
| `--dry-run` | Print summary only; do not write files |
| `--limit <n>` | Cap how many posts to keep after merge (testing) |
| `-h`, `--help` | Show usage |

| Variable | Default | Notes |
| --- | --- | --- |
| `OUTPUT_DIR` | `data/sources/nfdi-news` | Raw posts + `meta.json` |
| `OUTPUT_JSON` | `data/parsed/nfdi-news.json` | Matches report |
| `NEWS_LANG` | `en` | Polylang / WPML language code |
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

### Update already published incubators and use cases

`./build.sh` runs ensure-schema, `--apply`, fetch, and `--update` when NocoDB
credentials are present. To preview changes without writing:

```bash
node scripts/parse-source-pages.mjs
node scripts/patch-published-integrations.mjs
node scripts/patch-published-integrations.mjs --apply   # after review
node scripts/fetch-nocodb-data.mjs
node scripts/generate-incubator-pages.mjs --update
```

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

Source of truth: [PID4NFDI use-cases.md](https://github.com/base4nfdi/pid4nfdi/blob/main/content/community/use-cases.md). Rows land in the NocoDB [User_Stories](https://nocodb.nfdi.de/dashboard/#/nc/m0rbyklm1wowv50/mtq40pxpo5p0jmx/vwlhq1q3k6gcqrjd/user_stories) table (`uc_name`, `uc_descr`, `key_article`, `basic_service`, …) and are merged into the Integration Dashboard export.

```bash
node scripts/ensure-user-stories-schema.mjs             # rename title→uc_name + create columns (once)
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

### Backfill REF_Partners official logos

```bash
node scripts/patch-ref-partners-logos.mjs               # review dry-run
node scripts/patch-ref-partners-logos.mjs --apply
```

---

## Safety notes

- Scripts that mutate NocoDB default to **dry-run**. Pass `--apply` only after reviewing the preview output.
- Prefer `--local` when iterating on matching logic without hitting the live API.
- Keep `NOCODB_API_TOKEN` out of version control; use `.env` or CI secrets.

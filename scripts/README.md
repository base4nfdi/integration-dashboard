# Dashboard Data Pipeline Scripts

Node.js utilities that fetch, parse, sync, and materialize incubator data for the Base4NFDI dashboard. They sit between public service sources, NocoDB, and the Zola content tree.

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
                        ↓                        ↓
              push / patch / fill          generate-incubator-pages
                                           → content/incubators/{ts,dmp,iam}/
```

**Typical build path** (`./build.sh`):

1. `fetch-source-pages.mjs` — download source pages  
2. `parse-source-pages.mjs` — parse all services + write comparison summary  
3. `fetch-nocodb-data.mjs` — refresh `static/data.json` (skipped if no token)  
4. `generate-incubator-pages.mjs` — create missing Markdown report pages  
5. `zola build`

---

## Environment variables

### Shared (NocoDB)

| Variable | Default | Used by |
| --- | --- | --- |
| `NOCODB_API_TOKEN` | — (required for live API) | fetch, push, patch, fill |
| `NOCODB_BASE_URL` | `https://nocodb.nfdi.de` | same |
| `NOCODB_TABLE_ID` | incubators table id | same |
| `NOCODB_VIEW_ID` | unset for full-table dashboard export (view filters apply if set) | same |
| `NOCODB_PAGE_SIZE` | `100` | same |
| `FETCH_TIMEOUT_MS` | `60000` | HTTP clients |

### Fetch / parse

| Variable | Default | Script |
| --- | --- | --- |
| `OUTPUT_DIR` | `data/sources` | `fetch-source-pages.mjs` |
| `FETCH_RETRIES` | `2` | `fetch-source-pages.mjs` |
| `OUTPUT_JSON` | `static/data.json` | `fetch-nocodb-data.mjs` |
| `DMP_INPUT` / `DMP_OUTPUT` | `data/sources/dmp4nfdi/…` → `data/parsed/…` | `parse-dmp4nfdi.mjs` |
| `IAM_INPUT` / `IAM_OUTPUT` | `data/sources/iam4nfdi/…` → `data/parsed/…` | `parse-iam4nfdi.mjs` |
| `TS_INPUT` / `TS_OUTPUT` | `data/sources/ts4nfdi/…` → `data/parsed/…` | `parse-ts4nfdi.mjs` |
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

```bash
node scripts/parse-dmp4nfdi.mjs
node scripts/parse-iam4nfdi.mjs
node scripts/parse-ts4nfdi.mjs
```

Override paths with the `*_INPUT` / `*_OUTPUT` variables listed above when needed.

---

### 3. Fetch NocoDB data

**File:** `fetch-nocodb-data.mjs`

Pulls incubator rows from NocoDB, normalizes linked partner/entity fields, and writes `static/data.json` (the site’s primary data feed). Refuses to overwrite the file if the API returns zero records.

```bash
node scripts/fetch-nocodb-data.mjs
```

Requires `NOCODB_API_TOKEN`.

---

### 4. Generate incubator pages

**File:** `generate-incubator-pages.mjs`

Creates missing Markdown report pages under `content/incubators/{ts,dmp,iam}/` from `static/data.json`. Existing files are left alone unless `--force` is passed.

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

### 5. Push parsed sources into NocoDB

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

### 6. Patch logo fields

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

### 7. Fill empty key articles

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

## Shared libraries

These modules are imported by the scripts above; they are not meant to be run directly.

| Module | Role |
| --- | --- |
| `lib/http-utils.mjs` | Timed `fetch`, retries helpers, NocoDB list pagination |
| `lib/parse-utils.mjs` | Record shape, date/status/partner normalization, NocoDB matching, JSON I/O |

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

### Sync logos from sources

```bash
node scripts/parse-source-pages.mjs
node scripts/patch-logo-consortia.mjs --local           # optional preview vs export
node scripts/patch-logo-consortia.mjs --apply
node scripts/fetch-nocodb-data.mjs
```

---

## Safety notes

- Scripts that mutate NocoDB default to **dry-run**. Pass `--apply` only after reviewing the preview output.
- Prefer `--local` when iterating on matching logic without hitting the live API.
- Keep `NOCODB_API_TOKEN` out of version control; use `.env` or CI secrets.

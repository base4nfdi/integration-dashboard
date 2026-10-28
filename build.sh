#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "error: required command not found: $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd zola

echo "==> Fetching integration source pages"
node scripts/fetch-source-pages.mjs

echo "==> Parsing source pages"
node scripts/parse-source-pages.mjs

echo "==> Crawling NFDI news and success stories"
node scripts/crawl-nfdi-news.mjs --scope both

INTEGRATION_PAGES_UPDATE=0
if [[ -n "${NOCODB_API_TOKEN:-}" ]] || [[ -f .env ]]; then
  echo "==> Ensuring Incubators schema columns"
  node scripts/ensure-incubators-schema.mjs

  echo "==> Creating incubators missing from NocoDB"
  node scripts/push-source-pages-to-nocodb.mjs --apply

  echo "==> Creating PID use cases missing from NocoDB"
  node scripts/push-pid-use-cases-to-nocodb.mjs --apply

  echo "==> Patching published integrations from public sources"
  node scripts/patch-published-integrations.mjs --apply

  echo "==> Fetching NocoDB data"
  node scripts/fetch-nocodb-data.mjs
  echo "==> Syncing partner and institution logos"
  node scripts/sync-ref-directory.mjs
  INTEGRATION_PAGES_UPDATE=1
else
  echo "No NOCODB_API_TOKEN / .env — using existing static/data.json" >&2
fi

echo "==> Caching partner logos into static/"
node scripts/cache-partner-logos.mjs

echo "==> Caching project fonts into static/"
node scripts/cache-fonts.mjs

echo "==> Generating integration pages"
if [[ "${INTEGRATION_PAGES_UPDATE}" -eq 1 ]]; then
  node scripts/generate-incubator-pages.mjs --update
else
  node scripts/generate-incubator-pages.mjs
fi

echo "==> Building site with Zola"
zola build "$@"
echo "==> Build complete"

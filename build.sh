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

echo "==> Fetching incubator source pages"
node scripts/fetch-source-pages.mjs

echo "==> Parsing source pages"
node scripts/parse-source-pages.mjs

if [[ -n "${NOCODB_API_TOKEN:-}" ]] || [[ -f .env ]]; then
  echo "==> Fetching NocoDB data"
  node scripts/fetch-nocodb-data.mjs
else
  echo "No NOCODB_API_TOKEN / .env — using existing static/data.json" >&2
fi

echo "==> Building site with Zola"
zola build "$@"
echo "==> Build complete"

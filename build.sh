#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ -n "${NOCODB_API_TOKEN:-}" ]] || [[ -f .env ]]; then
  node scripts/fetch-nocodb-data.mjs
else
  echo "No NOCODB_API_TOKEN / .env — using existing static/data.json" >&2
fi

zola build "$@"

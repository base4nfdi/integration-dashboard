# syntax=docker/dockerfile:1

ARG ZOLA_VERSION=0.23.6

# ---------------------------------------------------------------------------
# Build: fetch NocoDB data (optional) + zola build → public/
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ARG ZOLA_VERSION
ARG TARGETARCH
ARG BASE_URL=http://localhost:8080
# Optional at build time. A token is required to fill incubator pages and logos.
# Without it, the image still builds, and those pages stay empty.
ARG NOCODB_API_TOKEN=
ARG NOCODB_BASE_URL=
ARG NOCODB_TABLE_ID=
ARG NOCODB_VIEW_ID=
ARG NOCODB_PAGE_SIZE=
ARG NOCODB_USER_STORIES_TABLE_ID=
ARG NOCODB_USER_STORIES_VIEW_ID=
ARG NOCODB_REF_ENTITIES_TABLE_ID=
ARG NOCODB_REF_ENTITIES_VIEW_ID=
ARG NOCODB_PARTNERS_TABLE_ID=
ARG NOCODB_PARTNERS_VIEW_ID=
ARG FETCH_TIMEOUT_MS=
ARG FETCH_RETRIES=
# Set to 1 to re-download all partner and institution logos (default: reuse cache).
ARG REFRESH_LOGOS=

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
      amd64) ZOLA_ARCH=x86_64-unknown-linux-gnu ;; \
      arm64) ZOLA_ARCH=aarch64-unknown-linux-gnu ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && curl -fsSL \
      "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-${ZOLA_ARCH}.tar.gz" \
      | tar -xz -C /usr/local/bin \
    && zola --version

WORKDIR /app
COPY . .

# The pipeline pulls live data, so an unchanged repo would otherwise hit the
# layer cache and ship stale data. Pass a new value (e.g. a timestamp) to force
# a fresh pipeline run without rebuilding the toolchain layers above.
ARG CACHE_BUST=

# Empty Compose build args must not override script defaults (?? ignores only null/undefined).
# Logo bytes persist in a BuildKit cache mount (not in git / .dockerignore); restore before
# the pipeline and write back after so CACHE_BUST rebuilds do not re-fetch every logo.
RUN --mount=type=cache,target=/logo-cache \
    set -eu; \
    echo "pipeline run: ${CACHE_BUST:-cached}"; \
    for var in NOCODB_API_TOKEN NOCODB_BASE_URL NOCODB_TABLE_ID NOCODB_VIEW_ID NOCODB_PAGE_SIZE \
               NOCODB_USER_STORIES_TABLE_ID NOCODB_USER_STORIES_VIEW_ID \
               NOCODB_REF_ENTITIES_TABLE_ID NOCODB_REF_ENTITIES_VIEW_ID \
               NOCODB_PARTNERS_TABLE_ID NOCODB_PARTNERS_VIEW_ID \
               FETCH_TIMEOUT_MS FETCH_RETRIES REFRESH_LOGOS; do \
      eval "val=\${$var:-}"; \
      if [ -n "$val" ]; then export "$var=$val"; else unset "$var"; fi; \
    done; \
    mkdir -p static/img/ref-logos static/img/partner-logos; \
    if [ -f /logo-cache/ref-directory.json ]; then \
      cp /logo-cache/ref-directory.json static/ref-directory.json; \
    fi; \
    if [ -d /logo-cache/ref-logos ] && [ -n "$(ls -A /logo-cache/ref-logos 2>/dev/null || true)" ]; then \
      cp -a /logo-cache/ref-logos/. static/img/ref-logos/; \
    fi; \
    if [ -d /logo-cache/partner-logos ] && [ -n "$(ls -A /logo-cache/partner-logos 2>/dev/null || true)" ]; then \
      cp -a /logo-cache/partner-logos/. static/img/partner-logos/; \
    fi; \
    ./build.sh --base-url "${BASE_URL}"; \
    mkdir -p /logo-cache/ref-logos /logo-cache/partner-logos; \
    if [ -f static/ref-directory.json ]; then \
      cp static/ref-directory.json /logo-cache/ref-directory.json; \
    fi; \
    if [ -d static/img/ref-logos ]; then \
      cp -a static/img/ref-logos/. /logo-cache/ref-logos/; \
    fi; \
    if [ -d static/img/partner-logos ]; then \
      cp -a static/img/partner-logos/. /logo-cache/partner-logos/; \
    fi

# ---------------------------------------------------------------------------
# Runtime: nginx serves the static site
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/public /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

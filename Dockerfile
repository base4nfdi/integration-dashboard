# syntax=docker/dockerfile:1

ARG ZOLA_VERSION=0.23.6

# ---------------------------------------------------------------------------
# Build: fetch NocoDB data (optional) + zola build → public/
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS builder

ARG ZOLA_VERSION
ARG TARGETARCH
ARG BASE_URL=http://localhost:8080
# Optional at build time; omit token to ship committed static/data.json
ARG NOCODB_API_TOKEN=
ARG NOCODB_BASE_URL=
ARG NOCODB_TABLE_ID=
ARG NOCODB_VIEW_ID=
ARG NOCODB_PAGE_SIZE=

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

# Empty Compose build args must not override script defaults (?? ignores only null/undefined).
RUN set -eu; \
    for var in NOCODB_API_TOKEN NOCODB_BASE_URL NOCODB_TABLE_ID NOCODB_VIEW_ID NOCODB_PAGE_SIZE; do \
      eval "val=\${$var:-}"; \
      if [ -n "$val" ]; then export "$var=$val"; else unset "$var"; fi; \
    done; \
    ./build.sh --base-url "${BASE_URL}"

# ---------------------------------------------------------------------------
# Runtime: nginx serves the static site
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/public /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1

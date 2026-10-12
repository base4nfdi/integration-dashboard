# Base4NFDI Integration Dashboard — deployment

Docker Compose runs **nginx** serving a static site built into the image. Data is prepared at **image build** time (public sources, NocoDB, assets, Zola). The running container does not call NocoDB.

**Script and pipeline reference:** [scripts/README.md](scripts/README.md)

---

## Prerequisites

- **Docker** and **Docker Compose**
- Repository checkout on the host
- **`.env`** on the server (from [`.env.example`](.env.example)): at minimum `NOCODB_API_TOKEN` ([NocoDB tokens](https://nocodb.nfdi.de/dashboard/#/account/tokens)). `BASE_URL` and other values are already set for this environment—leave them as deployed unless the public origin changes.

Never commit `.env`.

---

## Docker Compose: start, stop, remove

Run from the repository root.

### Start (or redeploy)

```bash
docker compose up -d --build
```

| Part | Meaning |
| --- | --- |
| `up` | Create and start the `web` service |
| `-d` | Detached: nginx keeps running in the background |
| `--build` | Rebuild the image first (required after git pull, `.env` token changes, or when data/site content must be regenerated) |

The **build stage** runs the full data pipeline (`fetch` → `parse` → news crawl → NocoDB fetch when a token is present → logo/ref sync → page generation → `zola build` using the configured `BASE_URL`). Without `NOCODB_API_TOKEN`, the build uses the `static/data.json` committed in the repo.

The site is served on host port **`PORT`** from `.env` (default **8080**).

```bash
docker compose ps          # is the container running?
docker compose logs -f web # build errors (from last image build) and nginx logs
```

### Stop (keep container and image)

```bash
docker compose stop
```

Start again without rebuilding:

```bash
docker compose start
# or
docker compose up -d
```

Use `up -d --build` when the image must be rebuilt.

### Remove stack

```bash
docker compose down
```

Removes the container and Compose network. The image `base4nfdi-dashboard:latest` stays on the host until removed:

```bash
docker compose down --rmi local
```

There are **no Compose volumes**; the HTML lives inside the image. Restarting without `--build` does **not** refresh data—use a rebuild.

---

## Updating the site (full data chain)

**Normal refresh** (sources, NocoDB, logos, new integration pages, site build):

```bash
docker compose up -d --build
```

That is the only deploy step. Ensure `.env` includes a valid `NOCODB_API_TOKEN` when the build should pull live NocoDB data.

**Source-driven maintenance** (new rows from public incubator pages, patches into NocoDB, PID push, etc.) is done with the Node scripts documented in [scripts/README.md](scripts/README.md). Those steps change the repo or NocoDB; finish with **`docker compose up -d --build`** so the new state is baked into the image.

---

## NocoDB: manual edits by dashboard reviewers

Reviewers may update rows in the NocoDB UI (Incubators, User_Stories, REF_Partners, REF_Entities). The live site only shows what was built into the last image.

### After reviewer changes (usual case)

```bash
docker compose up -d --build
```

With `NOCODB_API_TOKEN` in `.env`, the image build runs `fetch-nocodb-data`, `sync-ref-directory`, `cache-partner-logos`, and related steps—so the dashboard and `static/data.json` match NocoDB without running scripts on the host.

### When detail integration pages must match NocoDB

The build generates **new** integration Markdown pages but does not overwrite existing ones. If reviewers changed fields that appear on individual integration articles (description, goals, dates, status, …), run the maintenance sequence from [scripts/README.md](scripts/README.md) (`fetch-nocodb-data` → optional logo/ref steps → `generate-incubator-pages.mjs --update`) in a environment where those scripts are run, then deploy:

```bash
docker compose up -d --build
```

### What manual NocoDB edits do not replace

- New incubators that exist only on DMP/IAM/TS public sites → push workflows in [scripts/README.md](scripts/README.md).  
- PID use cases from upstream markdown → `push-pid-use-cases-to-nocodb.mjs`.  
- Backfilling published rows from public sources → `patch-published-integrations.mjs` (dry-run, then `--apply`), then redeploy with Compose.

---

## Safety

- Scripts that write to NocoDB default to **dry-run**; use `--apply` only after review ([scripts/README.md](scripts/README.md)).  
- Keep `NOCODB_API_TOKEN` in `.env` or deployment secrets, not in git.

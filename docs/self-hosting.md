# Self-hosting Calends

[← README](../README.md) · [简体中文](self-hosting.zh-CN.md)

Start with the [Cloudflare or Docker quick start](../README.md#quick-start). This guide covers configuration and deployment options beyond the first launch.

Open Calends at `/` and sign in at `/login`. After signing in, `/` redirects to your configured start page, defaulting to `/overview`. Public sharing is optional: enable it in Settings to make the read-only page available at `/public`. See [routes and login redirects](../ARCHITECTURE.md#web-requests-and-state) for details. Add a passkey after setup in **Settings → Security**.

## Cloudflare from source

```bash
git clone https://github.com/imetn/calends
cd calends
npm ci
npx wrangler login
node scripts/wrangler.mjs secret put SETUP_TOKEN
npm run deploy
```

Use a long random string for `SETUP_TOKEN`. The deploy command builds the app, provisions D1 on first deployment and applies migrations. Open `https://<your-worker>.workers.dev/`, enter the token on the login page and set your password.

## Using prebuilt images

Pull and run the image without a source checkout or local build:

```bash
docker pull xizozhe/calends:latest
docker run -d --name calends --restart unless-stopped -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

Open `http://localhost:8787/` and use the setup token printed in the logs on the login page. The named volume `calends-data` persists all of `/data`, including the SQLite database state and generated setup token. No Cloudflare account is required.

For production, pin a full version tag such as `xizozhe/calends:1.32.0` and change it deliberately when upgrading. `latest` follows the main branch; `1.32` follows releases in that minor series. These moving tags are convenient for updates but do not pin a specific release. You can replace `xizozhe/calends` with `ghcr.io/imetn/calends` in these commands.

If you use the [Compose file from the quick start](../README.md#docker), upgrade with `docker compose pull && docker compose up -d`.

To upgrade an installation using `latest`, pull the new image, then recreate the container with the same volume:

```bash
docker pull xizozhe/calends:latest
docker stop calends
docker rm calends
docker run -d --name calends --restart unless-stopped -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

Removing the container preserves the named volume. Reuse the same volume and any environment variables, restart policy or other options from your original installation. For a pinned version, use the desired version tag in both `docker pull` and `docker run`.

### Image registries

Since v1.1.0, prebuilt images are published to both registries and can be pulled anonymously, without `docker login`:

- Docker Hub: `xizozhe/calends` (equivalently `docker.io/xizozhe/calends`).
- GitHub Container Registry (GHCR): `ghcr.io/imetn/calends`.

Both provide multi-architecture images for `linux/amd64` and `linux/arm64`. [The image workflow](../.github/workflows/docker.yml) publishes `latest` for main-branch builds and version tags such as `1.32.0` and `1.32` for a `v1.32.0` release.

Building from source does not depend on a published Calends image; it still downloads base images and build dependencies.

## Docker from source

The repository includes a [Dockerfile](../docker/Dockerfile) and [Compose configuration](../docker/docker-compose.yml). From a source checkout:

```bash
cd docker
docker compose up -d --build
docker compose logs calends
```

Compose builds `calends:local`, starts the service on port 8787 and mounts the named volume `calends_calends-data` at `/data`. Open `http://localhost:8787/` and use the setup token from the logs on the login page. To update after obtaining newer source, run `docker compose up -d --build` in `docker/` again. `docker compose down` preserves the volume; `docker compose down -v` deletes the ledger volume.

The supplied `docker/docker-compose.yml` builds from source. To use a prebuilt image instead, use [`docker/compose.prebuilt.yml`](../docker/compose.prebuilt.yml).

Use `ghcr.io/imetn/calends:latest` as an alternative, or pin a version such as `1.32.0`. In `docker/`, run `docker compose -f compose.prebuilt.yml pull` followed by `docker compose -f compose.prebuilt.yml up -d` to start or upgrade this configuration. Compose recreates the container when the image changes and retains `calends_calends-data`.

To build and run without Compose, from the repository root:

```bash
docker build -f docker/Dockerfile -t calends:local .
docker run -d --name calends --restart unless-stopped -p 8787:8787 \
  -v calends-data:/data calends:local
docker logs calends
```

Choose one method for an installation: Compose uses the volume `calends_calends-data`, while the `docker run` example uses `calends-data`.

The image runs the same Worker in a single Node process with SQLite. It applies migrations at startup and runs scheduled work every 15 minutes, matching the Cloudflare cron. No Cloudflare account is required.

A typical ledger uses about 100–150 MB of memory with near-zero idle CPU. These are test-environment observations, not a guarantee for every workload; sustained operation on a 1 CPU, 1 GB VPS has not been verified. Compose defaults to a 512 MB container memory limit. The JavaScript heap is capped at 192 MB; backups up to 20 MB can be restored. To change the heap cap, set `NODE_OPTIONS` and keep `--disable-warning=ExperimentalWarning`. Building the image needs far more memory than running it, so use the prebuilt image on small servers. Upgrades keep the data in place, and you can return to an earlier version by running its tag on the same volume, as long as the schema has not moved past that version.

Request bodies are limited to 64 KB for login routes, 20 MB for backups, imports and assistant chat, and 4 MB otherwise. A declared oversized request returns 413. The former `INTERNAL_PORT` setting is no longer used; `PORT` is the only listening port.

The container refuses to start, and keeps restarting with an explanation in `docker logs`, if the database is missing while other databases or the `setup-token` file are still in `/data`. This usually means the volume or `DATA_DIR` changed. Fix the mount; to start over on purpose, delete `setup-token` as well.

Persist all of `/data`, which includes the database state and generated setup token. The frontend is built without personal files from `local/`.

## Without Docker (systemd)

On Debian or Ubuntu, one command installs Calends with its own copy of Node and starts it on `127.0.0.1:8787`. Point your own reverse proxy at that port:

```bash
curl -fsSL https://calends.date/install.sh | sudo bash
```

Run the same command to upgrade. It backs up your data, keeps your settings, and restores the previous version and its data if the new one doesn't start. `--version 1.32.0` installs a specific version, and `--uninstall` removes the program but keeps your data and settings. To read the script first, download it and run it with `sudo bash install.sh`.

The rest of this section is the same installation done by hand, for other distributions.

A small VPS doesn't need Docker. Since 1.26.0, each [release](https://github.com/imetn/calends/releases) includes a tarball that runs the same code as the image, needs no npm install, and works on x86 and ARM. It requires Linux, systemd and a system-wide Node 24 (check with `node -v`); the service can't read a Node installed under a home directory, such as with nvm.

```bash
VERSION=1.32.0
curl -fLO https://github.com/imetn/calends/releases/download/v$VERSION/calends-$VERSION.tar.gz
curl -fLO https://github.com/imetn/calends/releases/download/v$VERSION/calends-$VERSION.tar.gz.sha256
sha256sum -c calends-$VERSION.tar.gz.sha256
sudo mkdir -p /opt/calends
sudo tar -xzf calends-$VERSION.tar.gz -C /opt/calends --strip-components=1 --no-same-owner
sudo cp /opt/calends/calends.service /etc/systemd/system/
sudo systemctl daemon-reload
```

If you're moving from Docker, copy the data now (replace `calends` with your container name) and put the container's environment variables in `/etc/calends.env`, described below. Don't copy over a service that has already started, and don't move a subpath deployment this way. Skip this step on a fresh install:

```bash
sudo docker stop calends
sudo mkdir -p -m 700 /var/lib/private
sudo docker cp calends:/data/. /var/lib/private/calends/
```

Then start the service:

```bash
sudo systemctl enable --now calends
sudo journalctl -u calends -n 20
```

Don't send the setup token and password over the public internet in plain text. Forward the port first with `ssh -L 8787:localhost:8787 user@your-server`, open `http://localhost:8787/` and set your password with the setup token from the log. Data lives in `/var/lib/calends`, memory is capped at 512 MB, and the service restarts if the process exits unexpectedly.

Put settings from [Configuration](#configuration) in `/etc/calends.env`, one `NAME=value` per line and protected with `sudo chmod 600`, then run `sudo systemctl restart calends`. Behind a reverse proxy, set `HOST=127.0.0.1`. Leave `DATA_DIR` unchanged and keep `PORT` above 1024. The tarball is built for the root path; use Docker to deploy under a subpath.

To upgrade or roll back, replace the code and leave the data alone. You can only roll back to a version whose database schema is no older than your data, so export a backup in Settings first. Set `VERSION` to the version you want, download and verify its tarball, then run:

```bash
sudo systemctl stop calends
sudo rm -rf /opt/calends
sudo mkdir -p /opt/calends
sudo tar -xzf calends-$VERSION.tar.gz -C /opt/calends --strip-components=1 --no-same-owner
sudo cp /opt/calends/calends.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl start calends
```

## Configuration

For Cloudflare, set variables and bindings in your Wrangler configuration and use secrets for credentials. For Docker, pass supported environment variables with `-e` or through Compose.

| Setting                                | Cloudflare                  | Docker                                   | Purpose                                                                                                                                                                              |
| -------------------------------------- | --------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SETUP_TOKEN`                          | Secret                      | Environment variable; generated if unset | Used to set the owner password on a fresh install.                                                                                                                                   |
| `SITE_URL`                             | Variable                    | Environment variable                     | Public URL used in reminders and calendar links; auto-detected if unset.                                                                                                             |
| `TRUST_PROXY`                          | —                           | Environment variable                     | Usually leave unset. `off` ignores `X-Forwarded-For`; a comma-separated IP or CIDR list adds proxies to trust, such as another CDN. See [Custom domains](#custom-domains-and-https). |
| `EMAIL`, `MAIL_FROM`, `MAIL_FROM_NAME` | Email binding and variables | Not configured by the image entrypoint   | Optional email delivery; see below. Other notification channels are configured in the app.                                                                                           |
| `OLD_HOSTS`                            | Variable                    | Not forwarded by the image entrypoint    | Comma-separated old domains. With `SITE_URL` set, pages on these hosts redirect there with HTTP 301; API, MCP and calendar feeds remain accessible.                                  |
| `BASE_PATH`                            | Variable                    | Build argument and environment variable  | Optional subpath without a trailing slash, e.g. `/calends`. Use the same value at build time and runtime; see [subpath deployment](#subpath-deployment).                             |
| `DATA_DIR`                             | —                           | Environment variable                     | SQLite data directory; default `/data`. Persist this directory in a volume.                                                                                                          |
| `PORT`                                 | —                           | Environment variable                     | Listening port; default `8787`.                                                                                                                                                      |
| `HOST`                                 | —                           | Environment variable                     | Listening address; default `0.0.0.0`. Without Docker, set `127.0.0.1` behind a reverse proxy. With Docker, leave it and publish with `-p 127.0.0.1:8787:8787`.                       |

### Personal Cloudflare configuration

By default, deployment-specific settings live in the git-ignored `local/` directory:

- `local/wrangler.jsonc`: your domain, database ID, sender address and other Wrangler settings. The npm scripts select this file automatically when it exists.
- `local/public/`: your own icons and other static assets. Files here override matching files in `app/public/` at build time.

When managing secrets for a deployment that uses `local/wrangler.jsonc`, use the same wrapper as the npm scripts:

```bash
node scripts/wrangler.mjs secret put SETUP_TOKEN
```

Set `CALENDS_LOCAL` to keep these files outside the repository. It accepts an absolute path or a path relative to the repository root; an unset or empty value still uses `local/`. Both Wrangler configuration and the `public/` asset overrides use this directory, including during local development.

For example, with the repository checked out as `calends`:

```text
workspace/
├── calends/              # Git checkout
└── my-deploy/            # Personal files outside Git
    ├── wrangler.jsonc
    └── public/
        └── icons/
            └── logo.svg
```

Copy the repository's `wrangler.jsonc` into `my-deploy/`, then adjust its paths. Wrangler resolves relative paths from the configuration file's directory, so update these fields while preserving the other settings and bindings:

```jsonc
{
  "$schema": "../calends/node_modules/wrangler/config-schema.json",
  "main": "../calends/worker/index.ts",
  "assets": { "directory": "../calends/dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": true },
  "d1_databases": [{ "binding": "DB", "database_name": "calends", "migrations_dir": "../calends/worker/migrations" }],
}
```

Run commands from the repository root, using the same directory for deployment and secrets:

```bash
CALENDS_LOCAL=../my-deploy npm run deploy
CALENDS_LOCAL=../my-deploy node scripts/wrangler.mjs secret put SETUP_TOKEN
```

An explicit `--config`/`-c` takes precedence over automatic configuration selection. If the personal `wrangler.jsonc` does not exist, the wrapper leaves Wrangler's default configuration selection intact. Local Worker and migration commands keep data in `<repo>/.wrangler/state` regardless of the configuration directory; an explicit `--persist-to` still takes precedence.

### Custom domains and HTTPS

For Cloudflare, add your domain to the active Wrangler configuration before deploying:

```jsonc
"routes": [{ "pattern": "calends.example.com", "custom_domain": true }],
"vars": { "SITE_URL": "https://calends.example.com" }
```

Merge `SITE_URL` into any existing `vars` object. For Docker, put the service behind Caddy, Nginx or Traefik with HTTPS and set `SITE_URL` to the external URL. Passkeys require a secure context, so use HTTPS for public access.

Calends finds the visitor IP for login rate limiting on its own: `X-Forwarded-For` counts only when the connection comes from a local or private address or from Cloudflare, and the visitor is the first untrusted address reading from the right. Caddy, Traefik and Cloudflare Tunnel work as they are. Nginx must add the header, or anyone can choose the IP used for rate limiting:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
```

Publish the port only to the proxy (`-p 127.0.0.1:8787:8787`). If Calends is reachable without a proxy, set `TRUST_PROXY=off`: visitors on the same private network can set this header, and so can anyone on the internet when Docker shows connections as coming from its gateway, as Docker Desktop, rootless Docker and some IPv6 port mappings do. Behind a CDN other than Cloudflare, add its address ranges, such as `TRUST_PROXY=192.0.2.0/24,198.51.100.7`; without them all visitors share the CDN's address.

### Email reminders

Cloudflare deployments can send email through the `EMAIL` binding. The repository's `wrangler.jsonc` contains commented examples for `send_email`, `MAIL_FROM` and `MAIL_FROM_NAME`; enable these with a verified sender. Then configure the notification channel in the app.

Telegram, Lark/Feishu, DingTalk, WeCom, Slack, Discord, Bark, ntfy, ServerChan and custom webhooks need no additional server configuration.

## Deploy with an AI agent

Copy this prompt into Claude Code, Codex, Cursor or another coding agent with terminal access:

```text
Deploy Calends (https://github.com/imetn/calends), a self-hosted subscription ledger, for me.
Read the README and docs/self-hosting.md first.
1. Ask whether I want Cloudflare Workers or Docker, and whether I have a custom domain.
2. Cloudflare: clone the repo, run npm ci, verify Wrangler login, generate a random SETUP_TOKEN,
   set it with node scripts/wrangler.mjs secret put SETUP_TOKEN, then run npm run deploy.
   Configure my custom domain in the active Wrangler configuration before deploying, if requested.
3. Docker: prefer a prebuilt image from xizozhe/calends (or ghcr.io/imetn/calends).
   Pin a version such as 1.32.0 for production, pull it, then run it on port 8787 with
   calends-data mounted at /data. Read the setup token with docker logs calends.
   Build from source only when needed, for example for subpath deployment.
   For public access, configure HTTPS with my chosen proxy.
4. Verify the app URL at / reaches the login page at /login. Give me the app URL and setup token,
   then explain how to add a passkey and connect an assistant from the AI access page at /connect.
```

## Subpath deployment

To serve Calends under a path such as `https://example.com/calends/`, build and run with the same `BASE_PATH`, and make the reverse proxy keep the prefix when forwarding:

```bash
docker build -f docker/Dockerfile --build-arg BASE_PATH=/calends -t calends:local .
docker run -d --name calends -p 127.0.0.1:8787:8787 -v calends-data:/data \
  -e BASE_PATH=/calends -e SITE_URL=https://example.com/calends calends:local
```

Open `https://example.com/calends/`; after login, it redirects to the configured start page (default `/calends/overview`). Login is at `/calends/login`, AI access at `/calends/connect` and the optional read-only public page at `/calends/public`. MCP clients use `/calends/mcp`. For Cloudflare, set `BASE_PATH` in the environment when running `npm run deploy` and in the Worker's `vars`. See [routes and login redirects](../ARCHITECTURE.md#web-requests-and-state) for access rules.

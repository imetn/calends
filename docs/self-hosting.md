# Self-hosting Calends

[← README](../README.md) · [简体中文](self-hosting.zh-CN.md)

Start with the [Cloudflare or Docker quick start](../README.md#quick-start). This guide covers configuration and deployment options beyond the first launch.

## Using prebuilt images

Pull and run the image without a source checkout or local build:

```bash
docker pull xizozhe/calends:latest
docker run -d --name calends -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

Open `http://localhost:8787/` and use the setup token printed in the logs on the login page. The named volume `calends-data` persists all of `/data`, including the SQLite database state and generated setup token. No Cloudflare account is required.

For production, pin a full version tag such as `xizozhe/calends:1.16.0` and change it deliberately when upgrading. `latest` follows the main branch; `1.16` follows releases in that minor series. These moving tags are convenient for updates but do not pin a specific release. You can replace `xizozhe/calends` with `ghcr.io/imetn/calends` in these commands.

To upgrade an installation using `latest`, pull the new image, then recreate the container with the same volume:

```bash
docker pull xizozhe/calends:latest
docker stop calends
docker rm calends
docker run -d --name calends -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

Removing the container preserves the named volume. Reuse the same volume and any environment variables, restart policy or other options from your original installation. For a pinned version, use the desired version tag in both `docker pull` and `docker run`.

### Image registries

Since v1.1.0, prebuilt images are published to both registries and can be pulled anonymously, without `docker login`:

- Docker Hub: `xizozhe/calends` (equivalently `docker.io/xizozhe/calends`).
- GitHub Container Registry (GHCR): `ghcr.io/imetn/calends`.

Both provide multi-architecture images for `linux/amd64` and `linux/arm64`. [The image workflow](../.github/workflows/docker.yml) publishes `latest` for main-branch builds and version tags such as `1.16.0` and `1.16` for a `v1.16.0` release.

Building from source does not depend on a published Calends image; it still downloads base images and build dependencies.

## Docker from source

The repository includes a [Dockerfile](../docker/Dockerfile) and [Compose configuration](../docker/docker-compose.yml). From a source checkout:

```bash
cd docker
docker compose up -d --build
docker compose logs calends
```

Compose builds `calends:local`, starts the service on port 8787 and mounts the named volume `calends_calends-data` at `/data`. Open `http://localhost:8787/` and use the setup token from the logs on the login page. To update after obtaining newer source, run `docker compose up -d --build` in `docker/` again. `docker compose down` preserves the volume; `docker compose down -v` deletes the ledger volume.

The supplied `docker/docker-compose.yml` builds from source by default. To use a prebuilt image instead, replace the entire `build:` block and the existing `image: calends:local` line with `image: xizozhe/calends:latest`, keeping the remaining settings. For example:

```yaml
name: calends
services:
  calends:
    image: xizozhe/calends:latest
    restart: unless-stopped
    ports:
      - '8787:8787'
    volumes:
      - calends-data:/data
    environment:
      TZ: UTC

volumes:
  calends-data:
```

Use `ghcr.io/imetn/calends:latest` as an alternative, or pin a version such as `1.16.0`. In `docker/`, run `docker compose pull` followed by `docker compose up -d` to start or upgrade this configuration. Compose recreates the container when the image changes and retains `calends_calends-data`.

To build and run without Compose, from the repository root:

```bash
docker build -f docker/Dockerfile -t calends:local .
docker run -d --name calends --restart unless-stopped -p 8787:8787 \
  -v calends-data:/data calends:local
docker logs calends
```

Choose one method for an installation: Compose uses the volume `calends_calends-data`, while the `docker run` example uses `calends-data`.

The image builds the frontend, then runs the same Worker through Wrangler's local workerd runtime with SQLite. The entrypoint applies migrations and triggers scheduled work every 15 minutes, matching the Cloudflare cron. No Cloudflare account is required. Persist all of `/data`, which includes the database state and generated setup token. The frontend is built without personal files from `local/`.

## Configuration

For Cloudflare, set variables and bindings in your Wrangler configuration and use secrets for credentials. For Docker, pass supported environment variables with `-e` or through Compose.

| Setting                                | Cloudflare                  | Docker                                   | Purpose                                                                                                                                                  |
| -------------------------------------- | --------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SETUP_TOKEN`                          | Secret                      | Environment variable; generated if unset | Used to set the owner password on a fresh install.                                                                                                       |
| `SITE_URL`                             | Variable                    | Environment variable                     | Public URL used in reminders and calendar links; auto-detected if unset.                                                                                 |
| `TRUST_PROXY`                          | Variable                    | Environment variable                     | Set to `1` behind a trusted reverse proxy so login rate limiting uses the visitor's forwarded IP.                                                        |
| `EMAIL`, `MAIL_FROM`, `MAIL_FROM_NAME` | Email binding and variables | Not configured by the image entrypoint   | Optional email delivery; see below. Other notification channels are configured in the app.                                                               |
| `OLD_HOSTS`                            | Variable                    | Not forwarded by the image entrypoint    | Comma-separated old domains. With `SITE_URL` set, pages on these hosts redirect there with HTTP 301; API, MCP and calendar feeds remain accessible.      |
| `BASE_PATH`                            | Variable                    | Build argument and environment variable  | Optional subpath without a trailing slash, e.g. `/calends`. Use the same value at build time and runtime; see [subpath deployment](#subpath-deployment). |
| `DATA_DIR`                             | —                           | Environment variable                     | SQLite data directory; default `/data`. Persist this directory in a volume.                                                                              |
| `PORT`                                 | —                           | Environment variable                     | Listening port; default `8787`.                                                                                                                          |
| `INTERNAL_PORT`                        | —                           | Environment variable                     | Container-loopback port of the Worker runtime behind the entrypoint's front listener; default `PORT + 1`. Change it only if that port is taken.          |

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

Merge `SITE_URL` into any existing `vars` object. For Docker, put the service behind Caddy, Nginx or Traefik with HTTPS, set `SITE_URL` to the external URL and set `TRUST_PROXY=1`. Passkeys require a secure context, so use HTTPS for public access.

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
   Pin a version such as 1.16.0 for production, pull it, then run it on port 8787 with
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
docker run -d --name calends -p 8787:8787 -v calends-data:/data \
  -e BASE_PATH=/calends -e SITE_URL=https://example.com/calends -e TRUST_PROXY=1 calends:local
```

Open `https://example.com/calends/`; after login, it redirects to the configured start page (default `/calends/overview`). Login is at `/calends/login`, AI access at `/calends/connect` and the optional read-only public page at `/calends/public`. MCP clients use `/calends/mcp`. For Cloudflare, set `BASE_PATH` in the environment when running `npm run deploy` and in the Worker's `vars`. See [routes and login redirects](../ARCHITECTURE.md#web-requests-and-state) for access rules.

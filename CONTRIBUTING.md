# Contributing to Calends

Thanks for helping! Bug reports, translations and pull requests are all welcome.

Read the relevant section of [ARCHITECTURE.md](ARCHITECTURE.md) and the [code standards](docs/code-standards.md) before changing behavior. [AGENTS.md](AGENTS.md) is the entry point for coding assistants; `CLAUDE.md` imports it so the rules stay in one place.

## Getting started

Use a current Node.js 24.x release, matching CI and Docker. Add `DEV_BYPASS_AUTH=1` to a local `.dev.vars` file without replacing existing values; it skips login only for development. Then run:

```bash
npm ci
npm run db:migrate:local
npm run dev   # http://127.0.0.1:5173/
```

Vite serves the UI on port 5173 and proxies API requests to the Worker on port 8787. Local database state lives in `.wrangler/state`; personal configuration under `local/` is not needed to contribute. Use a fresh checkout or an explicitly isolated Wrangler persistence directory when testing imports or migrations.

Set `CALENDS_LOCAL` to an absolute path or a path relative to the repository root to keep personal configuration and asset overrides outside the checkout; the default remains `local/`. See [personal Cloudflare configuration](docs/self-hosting.md#personal-cloudflare-configuration).

Before opening a PR, make sure these pass:

```bash
npm run typecheck && npm run lint && npm run format:check && npm run i18n:check && npm test && npm run build
```

For MCP release verification, run `node --experimental-strip-types scripts/mcp-release-check.mjs`.
It starts a loopback-only Worker with a fresh temporary persistence directory, creates fictional monthly,
quarterly and half-yearly carpools through the API, checks JSON-RPC schemas, permissions, previews,
dated collection rules, member fees and receipts, then stops the Worker and removes its database.
It does not use personal Wrangler configuration or an existing ledger.

Add `--deepseek` with `DEEPSEEK_API_KEY` supplied through the process environment to run the six
Chinese carpool tasks through both an external MCP client and the in-app assistant using the project's
default model. This optional check calls the real provider and incurs usage; it is separate from `npm test`.
The script checks stored values and receipt history, requires previews before external writes, and verifies
that assistant confirmation-card proposals do not save until `/api/assistant/apply` is called.
Preview-only tasks are never confirmed. Tokens are held in memory; the assistant key exists only in the
disposable local configuration and is cleared before cleanup. Do not paste credentials into shell history.

## Detail layout stress captures

Run `node scripts/detail-shots.mjs --out /tmp/calends-detail-shots` to generate a fictional,
date-relative backup, restore it through the real Worker API, and capture every subscription detail
with ego-browser. Use `--cases 4,15` to select case groups; variants in a group are included.
`--keep` leaves the isolated services running at `http://127.0.0.1:5180/list` and writes process groups
and the disposable data path to `keep.json`. Stop those process groups before deleting that path.
The normal run closes its TaskSpace, stops its services and removes its temporary database.
An interrupted run resumes completed captures in the same output directory only when the date,
fictional backup and tracked UI/domain sources still match `run.json`; each resumed run gets a new
temporary database. A completed output directory is captured afresh on the next invocation.
Crossing midnight fails the run instead of accepting stale “today” fixtures.

The script refuses occupied ports 8790/5180. It uses a generated Wrangler config and fresh
`--persist-to` directory, never the local wrapper, `.dev.vars`, `CALENDS_LOCAL` or `.wrangler/state`.
Vite's optional `VITE_WORKER_ORIGIN` and `VITE_CACHE_DIR` select the isolated API and optimizer cache;
without them, the normal 8787 proxy and cache path are unchanged. Run from the dedicated fixture
worktree without a personal `local/` directory. Only fictional currencies and historical FX are seeded.

`index.html` links cropped Chinese desktop, 1440×900 first-screen and 390px-wide long captures,
English desktop captures for groups 4/15/24/30, and extra expanded-history captures. Regular
fixtures open through `/list`; the proxy fixture opens through the name link on `/behalf`. Long desktop
captures stitch the real scroll container, keeping the sticky header once; narrow captures grow the
viewport until the sheet fits. No detail CSS is overridden. `tiles/` retains the original PNG pieces.
`measurements.json` and each case JSON include card geometry, candidate clipping/overflow,
scroll containers, approximate metric text coverage and visible record counts. Desktop blank ratios
use the full stitched dialog area; single-column layouts report zero. Overlay scrollbar visibility and
clipping flags are candidates for visual review, not automatic failures. Inspect every image and write
`problems.md` with case IDs and screenshot paths; that file is deliberately a human review artifact.

The generator and its descriptions live in `scripts/detail-fixtures.ts`. Its regression tests also
exercise leap day and month end. Group 4 has both the four-record roster with a departed member
and a separate currently-full variant, because a departed member cannot occupy a live seat.
Group 41 covers imported histories with and without recorded charges in Chinese/English, at desktop
and 390px widths, in light/dark themes. Text geometry assertions check ledger-note alignment,
wrapping and bottom spacing without changing the table's edge-to-edge layout.

## Guidelines

- **Domain logic lives in `shared/`** and must run in both the browser and the Worker (no DOM or Node APIs). Add unit tests in `shared/*.test.ts` for billing, phase or metric changes.
- **Every user-visible string goes through `t()`** (`shared/i18n.ts`). Never call `t()` at module top level. Add new keys to `en` and `zh-CN` at least; `npm run i18n:check` lists missing keys in other locales — machine-drafted translations are fine, native-speaker review is even better.
- **Stored data is forever.** Keep old records working; schema changes go in a new file under `worker/migrations/`; backups (`worker/backup.ts`) must round-trip new data.
- **Privacy**: anything that could identify a person or account must stay out of the public page (`shared/mask.ts` allow-lists what's shared).
- Keep the UI consistent with existing components (`app/src/components/ui.tsx`, `Picker.tsx`) and check mobile (390px), desktop, light and dark.

## Preparing a pull request

Describe the trigger and observable before/after behavior. Name affected architecture sections and explain any changes to data, permissions, compatibility or failure handling. Update the relevant reference in the same PR when those contracts change; internal refactors that preserve behavior do not need a prose change.

Record the commands and runtime checks used, what they establish and anything not run. For a logic fix, include a regression case that fails against the old behavior and passes with the fix. UI, Worker and container behavior need the corresponding runtime checks; a production build alone is not that evidence. See the [verification matrix](docs/code-standards.md#verification).

## Service catalogue

The editor's name suggestions come from pack files in `app/src/catalog/`; each pack is optional and deleting one just removes its entries. Only add services the App Store search (shown below the catalogue) does not cover well, such as web-only subscriptions, AI products, domains and developer accounts, or that need preset renewal rules. Check `https://itunes.apple.com/search?term=<name>&entity=software&country=cn` (and `us`) first; if the app is in the top results, leave it out.

Icons must be local files under `app/public/` (`public/brands/` for new ones, with the source and license in its `SOURCE.txt`); never hotlink a third-party favicon. Most email clients do not display SVG, so after adding or replacing an SVG under `ai/` or `brands/`, or a `-rect.svg` under `banks/`, run `node scripts/email-icons.mjs` to regenerate the PNG copies in `app/public/mail/` that reminder emails use; a test fails when one is missing. White logos need a background colour in that script.

## Translations

`shared/locales/<locale>/<namespace>.json`, nested JSON, `{placeholders}` must be kept. Plurals use CLDR categories: `{ "one": "...", "other": "..." }` (Russian also `few`/`many`; Chinese/Japanese/Korean/Indonesian/Vietnamese only `other`).

To add a language: copy `shared/locales/en`, translate, add it to `LOCALES` in `shared/i18n.ts`, add `app/src/locales/<code>.ts` (copy an existing one), then run `npm run i18n`.

## Screenshots

README screenshots live in `docs/screenshots/`, with English and Simplified Chinese versions of the overview and subscription timeline. Capture the current app with an isolated local database filled with fictional subscriptions; never use a personal ledger or a shared production instance. Use the default app logo (`app/public/icons/logo.svg`), a light theme and the same viewport for both languages. Check that icons and fonts have loaded, and keep screenshots free of dialogs and tooltips.

<p align="center">
  <img src="app/public/icons/logo.svg" width="96" height="96" alt="Calends logo" />
</p>

<h1 align="center">Calends</h1>

<p align="center">
  Track subscription charges, shared payments and prepaid balances on your own server.
</p>

<p align="center">
  <a href="https://calends.date">Website</a> ·
  <a href="https://demo.calends.date">Live demo</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#ai--mcp">AI &amp; MCP</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="Calends overview" width="880" />
</p>
<p align="center"><sub>Overview · Fictional demo data</sub></p>

---

## Billing and payment history

Track what you pay, when it renews, and who owes you. Calends brings subscriptions, shared plans and prepaid balances into one private, single-owner ledger, with an optional read-only public page and AI access through MCP.

- **Flexible billing** — monthly, yearly, custom cycles and lifetime purchases, with trials, intro prices, bonus periods, pauses, advance charging and cancellation deadlines.
- **Billing history** — keep price, plan and region changes, gaps and overlapping subscriptions. See total spent, actual monthly cost and every charge.
- **Transfers and split payments** — count second-hand takeovers and resales in net cost, and split a charge across multiple payment methods.
- **Multiple currencies** — historical exchange rates for past charges, current rates for forecasts, and your choice of display currency.
- **Balances and shared plans** — track prepaid credit and gift cards, estimate when balances run out, and manage payments for friends. Shared plans have dated collection rules, member overrides, per-period receipts with skipped-period collection, prepayments and waivers, overdue tracking and exit refunds; the member sheet uses a monthly period grid with receipt details on click, prepayments and waivers, while people have private avatars, custom colors and a separate account for each plan.
- **Reports and calendar** — spending trends, cash vs. accrual, prepaid value, cancellation savings, subscription checkups and a shareable year in review. Includes month/year calendars and a private ICS feed.
- **Search** — find Chinese names by full pinyin, initials or mixed syllables in the subscription list, command palette and pickers.
- **Renewal reminders** — email, Telegram, Lark/Feishu, DingTalk, WeCom, Slack, Discord, Bark, ntfy, ServerChan and custom webhooks.
- **AI access** — query and update your ledger from an MCP-compatible assistant, with scoped tokens and previews for write operations.
- **Import external ledgers** — preview and import CSV files, ZIP backups and databases from Wallos and other services in your browser.
- **Storage and access** — password and passkey sign-in, remote device sign-out, optional public sharing with server-side masking, JSON backup/restore and CSV import/export. Available in 14 languages.

<details>
<summary>Explore the subscription timeline</summary>

<p align="center">
  <img src="docs/screenshots/timeline.png" alt="Calends subscription timeline with billing periods, plan changes and payment methods" width="880" />
</p>
<p align="center"><sub>Billing periods and subscription history · Fictional demo data</sub></p>

</details>

## Quick start

[Try the live demo](https://demo.calends.date) to explore before deploying. It is shared by all visitors and resets daily; external notifications are disabled.

Open Calends at `/` and sign in at `/login`. After signing in, `/` redirects to your configured start page, defaulting to `/overview`. Public sharing is optional: enable it in Settings to make the read-only page available at `/public`. See [routes and login redirects](ARCHITECTURE.md#web-requests-and-state) for details.

### Cloudflare Workers

Use [one-click deployment](https://deploy.workers.cloudflare.com/?url=https://github.com/imetn/calends) with Workers and D1, or deploy from source:

```bash
git clone https://github.com/imetn/calends
cd calends
npm ci
npx wrangler login
node scripts/wrangler.mjs secret put SETUP_TOKEN
npm run deploy
```

Use a long random string for `SETUP_TOKEN`. The deploy command builds the app, provisions D1 on first deployment and applies migrations. Open `https://<your-worker>.workers.dev/`, enter the token on the login page and set your password.

### Docker

Run the prebuilt image directly:

```bash
docker run -d --name calends -p 8787:8787 -v calends-data:/data xizozhe/calends:latest
docker logs calends
```

Open `http://localhost:8787/` and use the setup token printed in the logs on the login page. The named volume `calends-data` persists SQLite data at `/data`. You can also use `ghcr.io/imetn/calends:latest`. For production, pin a version tag such as `1.15.0` instead of `latest`.

Alternatively, build from source with Compose. From a source checkout, Compose (in `docker/`) builds the included [Dockerfile](docker/Dockerfile) and starts the app:

```bash
cd docker
docker compose up -d --build
docker compose logs calends
```

The [Compose configuration](docker/docker-compose.yml) persists SQLite data in a named volume mounted at `/data`. Building locally does not require a published Calends image or a Cloudflare account. See the [Docker guide](docs/self-hosting.md#using-prebuilt-images) for image registries, upgrades and Compose options.

For public access, enable HTTPS through a reverse proxy and set `TRUST_PROXY=1`. Add a passkey after setup in **Settings → Security**.

See the [self-hosting guide](docs/self-hosting.md) for custom domains, configuration, email reminders, subpath deployment and a prompt to delegate deployment to your AI agent.

## AI & MCP

Ask “What renews next week?”, “How much did I spend this year?” or “Netflix went up to $17.99 from today.” Calends provides 34 tools over a stateless [MCP](https://modelcontextprotocol.io) endpoint at `/mcp` using Streamable HTTP.

On the **AI access** page (`/connect`), create a read-only or read/write token, then connect your client. Opening `/mcp` in a browser takes you to this page; MCP clients use the `/mcp` endpoint:

**Claude Code**

```bash
claude mcp add --transport http calends https://your-domain/mcp --header "Authorization: Bearer <token>"
```

**Codex**

```bash
export CALENDS_TOKEN='<token>'
codex mcp add calends --url https://your-domain/mcp --bearer-token-env-var CALENDS_TOKEN
```

Keep `CALENDS_TOKEN` available in the environment that launches Codex. Tools cover subscriptions, spending, trends, receivables and insights, plus changes to prices, plans, status and payments. Every write tool supports `dry_run`; AI access can be turned off in Settings.

## Contributing

Bug reports, translations and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, checks and contribution guidelines.

Start with the [architecture](ARCHITECTURE.md) and [code standards](docs/code-standards.md) before changing a subsystem. Coding agents use [AGENTS.md](AGENTS.md); `CLAUDE.md` imports the same instructions.

Built with React 19, Vite, HeroUI / React Aria, shadcn/ui and Cloudflare Workers + D1 (SQLite). Billing, exchange rates and other domain logic are shared between the browser and Worker in `shared/`.

Translations live in `shared/locales/<locale>/<namespace>.json`, with English and Simplified Chinese as the source languages.

## About the name

_Calends_ were the first day of every Roman month, when accounts were settled and debts called in. It is also where the word _calendar_ comes from.

## License

Calends is open source under the MIT License; see [LICENSE](LICENSE). You may use, modify and redistribute it, including commercially, provided you retain the copyright and license notices in copies or substantial portions of the software. If you fork Calends, please use a distinct name and credit Calends as the upstream source so users can distinguish your version from this project.

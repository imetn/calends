// Skills over MCP (SEP-2640, io.modelcontextprotocol/skills) + MCP Resources + MCP Prompts for Calends.
// Keeps static SKILL.md and reference docs deterministic so SHA-256 digests pass strict host verification,
// while MCP prompts hydrate live ledger context (today, categories, payment methods, files_enabled) at request time.
import { categoryList } from '../../shared/categories.ts';
import type { AppState } from '../../shared/types.ts';
import { filesEnabled } from '../files.ts';
import type { ToolCtx } from './tool-kit.ts';

export const SKILL_EXTENSION_ID = 'io.modelcontextprotocol/skills';
export const PRIMARY_SKILL_URI = 'skill://calends-ledger/SKILL.md';

export interface SkillResourceRef {
  uri: string;
  digest: string;
  size: number;
}

export interface SkillEntry {
  uri: string;
  frontmatter: {
    name: string;
    description: string;
    [key: string]: unknown;
  };
  resources: SkillResourceRef[];
}

export interface SkillResourceMeta {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: 'text/markdown';
  size: number;
}

export interface McpPromptMeta {
  name: string;
  title: string;
  description: string;
  arguments?: Array<{ name: string; description: string; required?: boolean }>;
}

const SKILL_NAME = 'calends-ledger';
const SKILL_DESCRIPTION =
  'Accurate workflows and accounting rules for reading, creating, updating, and auditing personal subscriptions, billing history, shared carpools, spending reports, and receipt files in Calends.';

const SKILL_MD = `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Calends Subscription Ledger Skill

Use this skill whenever reading, creating, updating, or auditing subscriptions, charges, wallets, shared plans (carpools), spending reports, or receipt files through the Calends MCP server.

## 1. Pre-flight Context (Always Do First)

1. Read the connection JSON in \`initialize.instructions\` or call \`get_settings\` first. It gives you:
   - \`today\`, \`timezone\`, \`base_currency\`, \`default_method_id\`, \`files_enabled\`
   - \`categories\`: exact category names already in the ledger
   - \`payment_methods\`: exact wallet/card \`id\`, \`name\`, \`kind\`, \`currency\`, \`region\`
2. **Never invent an unknown category name.** Reuse an exact name from \`categories\` (or call \`list_categories\`). Only pass \`create_category: true\` (or call \`save_category action="create"\`) when the user explicitly wants a new category.
3. **Match payment methods accurately.** Pick the matching \`id\` or exact \`name\` from \`payment_methods\` (e.g. a card, App Store region, or wallet mentioned on the receipt). Pass \`method: null\` when a subscription has no payment method (e.g. free bundled perk); omit \`method\` only when the default payment method applies.
4. **Search before creating.** Call \`list_subscriptions\` by service name or account before creating a record so you know whether to update an existing subscription or create a separate one. Same-name subscriptions with different accounts, regions, or uses are independent — never merge or cancel merely because names match.

## 2. Creating & Updating Subscriptions Accurately

- **Name with plan/tier**: Include the specific tier when known (e.g. \`ChatGPT Plus\`, \`Claude Max 5x\`, \`Spotify Family\`, \`iCloud+ 200GB\`).
- **Original currency & region**: Record amounts in the exact billing currency shown on the store/receipt (e.g. App Store Türkiye -> \`currency: "TRY"\`, \`region: "TR"\`). Never pre-convert to base currency.
- **Dates**:
  - \`start\` = first charge/purchase date (or renewal date if only that is shown).
  - Trials: \`status: "trial"\` + \`trial_end\`.
  - Promotional first-period price: \`intro: { price, until }\`.
- **Icons & URLs**:
  - When \`icon\` is omitted on \`create_subscription\`, exact matches from \`search_services\` automatically fill \`icon\`, \`url\`, and \`category\` (\`service_match\` reports what was filled).
  - For services not matched automatically, call \`search_services\` or \`search_app_store\` (with \`country = region ?? "us"\`, preferring 256x256 artwork) and pass \`icon\` and \`url\`.
- **Preserve history**: Never overwrite historical prices or plans with \`update_subscription\` when a real change happened on a date — use \`change_price\` or \`change_plan\`.
- **Safe writes**: Preview non-trivial, batch, or destructive writes with \`dry_run: true\` first, verify the returned preview against the user's request, then execute with \`dry_run: false\`.

## 3. Spending & Financial Reports (Never Do Mental Math)

- **Single calendar month** (e.g. "how much in March", "this month vs last month"): call \`get_insights(section="month_report", month="YYYY-MM")\` so totals match the Calendar page (net cash including second-hand transfers).
- **Filtered subset** (category, status, payment method, tag, region, search keywords, or specific subscriptions): call \`get_insights(section="scope_report", filter=...)\`.
- **Custom ranges or groupings**: call \`spending_stats\` (pass \`include_transfers: true\` to count transfer cash).
- **Missing exchange rates**: If any result returns \`incomplete: true\`, explicitly tell the user which currencies lack FX rates; never treat \`null\` amounts as zero.

## 4. Deeper References (Load On Demand)

- For multi-month bill tables, price/plan changes, stop/cancel/terminate/refund rules, bundled perks, multi-phase \`save_subscription\`, and meters: read \`skill://calends-ledger/references/subscriptions-and-history.md\`.
- For shared plans (carpools), member fees/receivables, proxy payments, and archiving receipt/invoice PDFs & images: read \`skill://calends-ledger/references/carpool-and-files.md\`.
`;

const SUBSCRIPTIONS_REF_MD = `# Subscriptions, Billing History & Lifecycle Rules

Load this reference when importing multi-month bills, recording price/plan/region changes, stopping subscriptions with refunds, linking bundled perks, or tracking usage meters.

## Multi-Month Bill Tables & Statements
- A table with one row per month and one column per service/line is **ONE subscription per service** — never one subscription per month.
- \`start\` = first month with a real amount (day 1 if no day is shown). Blank/\`—\` cells are not charges.
- \`price\` = latest month's amount.
- When monthly amounts vary (usage-based bills), pass **every** listed month (including ones equal to \`price\`) inside \`create_subscription.payments\`; do not call \`change_price\` or \`record_payment\` separately.

## Price Changes, Plan Switches & Multi-Phase History
- **Price change from a date**: call \`change_price\` (keeps earlier charges at the old price).
- **Plan, cycle, currency, or region switch**: call \`change_plan\` (\`action: "switch"\`).
- **Missing history before current start** (e.g. one-time purchase before recurring plan): call \`change_plan\` (\`action: "earlier"\`); never create a duplicate subscription.
- **Complete multi-phase history in one shot**: use \`save_subscription\` (with phases, per-phase payments, free intervals, or stop details). When \`phases\` is present, payments belong inside their owning phase, never at top level.
- **Fixing a wrong start date**: \`update_subscription\` \`set.start\` keeps billing day and later dates; pass \`shift_billing: true\` only when the charge dates themselves were wrong.

## Three Ways to Stop (and How to Undo/Resume)
1. **Non-renewal** (active until period ends): \`set_status(action="cancel", immediate=false, at="<last service day>")\`.
2. **Voluntary early stop**: \`set_status(action="cancel", immediate=true, at="<stop date>", refund?)\`.
3. **Provider-disabled / banned / shut down**: \`set_status(action="terminate", at="<stop date>", reason?, refund?)\`.
- Never guess \`at\`: pass the actual date, or \`at: null\` if the user only says it already stopped (undated stops cannot carry refund/reason).
- **Refund rules**: \`refund.currency\` must equal the subscription currency (use \`settled\` for card-currency settlement), and total refunds cannot exceed current period paid amount.
- **Correcting a stop**: call \`set_status\` with \`edit: true\` and only the changed fields.
- **Undo a mistaken stop**: \`set_status(action="reactivate")\`.
- **Resubscribing after a real stop**: \`change_plan(action="resume", ...)\` to start a new phase while keeping the stopped history intact.

## Bundled Perks, Transfers & Meters
- **Bundled perk / add-on**: pass \`bundle: { parent: "<parent id or name>", follow: true }\`. Free perks use \`price: 0\` and omit/\`null\` \`method\` (never invent a hypothetical MSRP).
- **Second-hand takeover / handoff cash**: use \`record_transfer\`.
- **Separate bill & payment dates**: \`update_subscription\` \`set.settlement\`.
- **Custom usage metrics** (electricity, traffic, mileage): \`set_meters\` + \`add_readings\`; read computed totals and unit prices from \`get_subscription.meters\`.
`;

const CARPOOL_FILES_REF_MD = `# Shared Plans (Carpools), Proxy Payments & Receipt Files

Load this reference when managing family/group sharing, recording member payments or proxy reimbursements, or uploading/linking receipt PDFs and screenshots.

## Shared Plans (Carpools)
- \`set_share\`: enable or update sharing (\`seats\` includes the owner) and set the shared collection \`rule: { fee, bill_every, currency }\` and optional \`collect_from\`.
- \`save_share_member\`: add or edit a member. New members follow the plan rule by default; pass \`follow_rule: false\` with custom \`fee\` / \`bill_every\` for exceptions.
  - Extra seats used by the owner themselves: add an \`exempt: true\` member (e.g. \`Self · Seat 2\`).
  - Fee changes default \`fee_from\` to \`today\` and preserve earlier history.
  - Mid-period joins align to the shared anchor (\`first_period\` defaults to \`prorate\`).
- \`record_receivable\`: settle member periods. Omit \`periods\` and \`amount\` to record the earliest unsettled period; pass \`periods\` (from \`get_subscription\`) or \`count\` for specific/multiple periods; use \`action: "waive"\` to forgive unpaid periods.
- \`get_carpool\`: always read \`next_collection_date\`, \`pending_amount\`, yearly cost vs. income, and profit directly from \`get_carpool\` — never compute them by mental arithmetic.

## Proxy Payments (Paying for Someone Else)
- Use \`set_proxy\` to mark a subscription paid on behalf of a person (links or creates a roster person via \`person\` / \`for_name\`).
- Record reimbursements with \`record_receivable(kind="proxy", ...)\`. Proxy spending is excluded from "my spending" totals automatically.

## Receipt & Invoice File Center
- Check \`files_enabled\` in \`initialize\` / \`get_settings\` before calling file write tools. If \`files_enabled\` is \`false\`, tell the user to bind R2 (\`FILES\`) on Cloudflare or verify Docker \`/data/files\`.
- Supported formats (verified by magic bytes, up to 10 MB): **PDF, PNG, JPEG, WebP**.
- **Linking rules (\`upload_file\` / \`update_file\`)**:
  - \`kind: "charge"\` + \`date: "YYYY-MM-DD"\` — invoice/receipt for a specific charge date.
  - \`kind: "contract"\` + \`date: "YYYY-MM-DD"\` — contract document anchored to a contract term's start date.
  - \`kind: "receipt"\` + \`receipt: "<receipt_id>"\` (from \`get_subscription\` or \`record_receivable.after.id\`; \`date\` defaults to that receipt's date) — transfer screenshot/proof for a specific shared-plan member collection or proxy collection receipt. Files reused across multiple collection receipts are flagged with \`duplicate_receipt: true\`.
  - \`kind: "sub"\` (no \`date\`) — general plan documents, welcome guides, or policies.
  - Omit \`subscription\` to store an unlinked file in the Pending tab.
- **Collection receipt workflow**: when archiving a shared-plan member or proxy payment screenshot, record the payment with \`record_receivable\` first (or read an existing \`receipt_id\` from \`get_subscription\`), then call \`upload_file\` / \`update_file\` with \`kind: "receipt"\` and \`receipt: "<receipt_id>"\`.
- **Uploading local or large files**:
  - Prefer \`upload_link: true\` (requires \`site_url\` configured) for local PDFs/screenshots so you receive a one-time 15-minute upload URL and can \`curl -X PUT --data-binary @file "<url>"\` without bloating context with base64.
  - Use \`url\` for public HTTPS file links, or \`content_base64\` only for small payloads.
- **Inspecting & auditing files**: use \`list_files\` (supports \`receipt_scope: "carpool" | "proxy"\`, \`receipt: "<receipt_id>"\`, \`duplicate_only: true\`, and \`query\` matching titles, names, or payers) to find file IDs, check \`get_carpool\` (\`receipt_files\` / \`duplicate_receipt_files\`) and \`get_subscription\` (\`periods[].file_ids\`), and call \`get_file\` to read image/PDF bytes (inline up to 5 MB, otherwise download link).
`;

interface StaticResource {
  uri: string;
  name: string;
  title: string;
  description: string;
  text: string;
}

const STATIC_RESOURCES: readonly StaticResource[] = [
  {
    uri: PRIMARY_SKILL_URI,
    name: 'calends-ledger/SKILL.md',
    title: 'Calends Ledger Skill (SKILL.md)',
    description: SKILL_DESCRIPTION,
    text: SKILL_MD,
  },
  {
    uri: 'skill://calends-ledger/references/subscriptions-and-history.md',
    name: 'calends-ledger/references/subscriptions-and-history.md',
    title: 'Subscriptions, Billing History & Lifecycle Rules',
    description: 'Detailed rules for multi-month bills, price/plan changes, stop/refund handling, bundled perks, multi-phase save_subscription, and meters.',
    text: SUBSCRIPTIONS_REF_MD,
  },
  {
    uri: 'skill://calends-ledger/references/carpool-and-files.md',
    name: 'calends-ledger/references/carpool-and-files.md',
    title: 'Shared Plans, Proxy Payments & Receipt Files',
    description: 'Detailed rules for carpool sharing, member receivables, proxy payments, and archiving receipt PDFs/images in the file center.',
    text: CARPOOL_FILES_REF_MD,
  },
];

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

let cachedSkillPromise: Promise<SkillEntry> | undefined;

async function buildPrimarySkill(): Promise<SkillEntry> {
  const resources: SkillResourceRef[] = [];
  for (const r of STATIC_RESOURCES) {
    const bytes = enc.encode(r.text);
    const digest = `sha256:${hex(await crypto.subtle.digest('SHA-256', bytes))}`;
    resources.push({ uri: r.uri, digest, size: bytes.byteLength });
  }
  return {
    uri: PRIMARY_SKILL_URI,
    frontmatter: {
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
    },
    resources,
  };
}

function getPrimarySkill(): Promise<SkillEntry> {
  cachedSkillPromise ??= buildPrimarySkill();
  return cachedSkillPromise;
}

/** SEP-2640 skills/list */
export async function listSkills(): Promise<{ skills: SkillEntry[] }> {
  return { skills: [await getPrimarySkill()] };
}

/** SEP-2640 skills/get */
export async function getSkill(uri: string): Promise<SkillEntry | undefined> {
  if (uri === PRIMARY_SKILL_URI) return getPrimarySkill();
  return undefined;
}

/** Standard MCP resources/list (exposes SKILL.md and reference docs for all MCP clients) */
export function listSkillResources(): SkillResourceMeta[] {
  return STATIC_RESOURCES.map((r) => ({
    uri: r.uri,
    name: r.name,
    title: r.title,
    description: r.description,
    mimeType: 'text/markdown',
    size: enc.encode(r.text).byteLength,
  }));
}

/** Standard MCP resources/read */
export function readSkillResource(uri: string): { contents: Array<{ uri: string; mimeType: 'text/markdown'; text: string }> } | undefined {
  const hit = STATIC_RESOURCES.find((r) => r.uri === uri);
  if (!hit) return undefined;
  return { contents: [{ uri: hit.uri, mimeType: 'text/markdown', text: hit.text }] };
}

/** Standalone copyable SKILL.md for clients that do not yet auto-load SEP-2640 Skills over MCP */
export function renderStandaloneSkillMd(): string {
  return [SKILL_MD.trim(), '', '---', '', SUBSCRIPTIONS_REF_MD.trim(), '', '---', '', CARPOOL_FILES_REF_MD.trim(), ''].join('\n');
}

export const MCP_PROMPTS: readonly McpPromptMeta[] = [
  {
    name: 'organize_receipts',
    title: 'Organize receipts & archive files',
    description:
      'Parse pasted receipts, invoices, or transfer screenshots, create/update subscriptions or receivables accurately, and attach files to charge dates or shared-plan/proxy collection receipts.',
    arguments: [{ name: 'input', description: 'Receipt text, email content, transfer screenshot summary, or file list to organize.', required: false }],
  },
  {
    name: 'spending_summary',
    title: 'Analyze subscription spending',
    description: 'Answer monthly, yearly, or filtered spending questions using authoritative report tools without mental math.',
    arguments: [{ name: 'question', description: 'Spending question or period (e.g. 2026-11, AI category, this year).', required: false }],
  },
  {
    name: 'batch_import_subscriptions',
    title: 'Batch import subscriptions or bill table',
    description: 'Import multiple subscriptions or a multi-month bill table while preserving exact categories, payment methods, icons, and charge history.',
    arguments: [{ name: 'data', description: 'Bill table, list of subscriptions, or notes to import.', required: false }],
  },
  {
    name: 'audit_carpool',
    title: 'Audit shared plans & receivables',
    description: 'Check shared carpools and proxy subscriptions for overdue members, pending amounts, net cost, and next collection dates.',
    arguments: [{ name: 'subscription', description: 'Optional specific subscription or member name to focus on.', required: false }],
  },
];

export function listPrompts(): McpPromptMeta[] {
  return [...MCP_PROMPTS];
}

function liveContextBlock(ctx: ToolCtx, st: AppState, today: string): string {
  const cats = categoryList(st.settings, st.subscriptions).map((c) => c.name);
  const methods = st.methods.map((m) => `${m.id} (${m.name}, ${m.kind}, ${m.currency}${m.region ? `, ${m.region}` : ''})`);
  return [
    '## Current Ledger Snapshot',
    `- Today: ${today} (${st.settings.timezone})`,
    `- Base currency: ${st.settings.baseCurrency}`,
    `- Default payment method: ${st.settings.defaultMethodId ?? 'none'}`,
    `- File center storage (R2/files): ${filesEnabled(ctx.env) ? 'enabled' : 'disabled'}`,
    `- Existing categories (reuse exact names): ${cats.join(', ') || 'none'}`,
    `- Existing payment methods (pass id or exact name): ${methods.join('; ') || 'none'}`,
  ].join('\n');
}

export function getPrompt(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolCtx,
  st: AppState,
  today: string,
): { description: string; messages: Array<{ role: 'user'; content: { type: 'text'; text: string } }> } | undefined {
  const meta = MCP_PROMPTS.find((p) => p.name === name);
  if (!meta) return undefined;
  const ctxBlock = liveContextBlock(ctx, st, today);
  const userArg = (k: string) => (typeof args[k] === 'string' && args[k].trim() ? `\n\n## User Input\n${args[k].trim()}` : '');

  let body = '';
  switch (name) {
    case 'organize_receipts':
      body = `${SKILL_MD}\n\n${CARPOOL_FILES_REF_MD}\n\n${ctxBlock}\n\n## Task\nParse the provided receipts/invoices/transfer proofs, check \`list_subscriptions\` to avoid duplicates, preview changes with \`dry_run: true\`, confirm or execute writes, and if file storage is enabled, link provider invoices to their \`charge\` date or shared-plan/proxy collection screenshots to \`kind="receipt"\` with \`receipt="<receipt_id>"\` via \`upload_file\` / \`update_file\` (flagging any \`duplicate_receipt\`).${userArg('input')}`;
      break;
    case 'spending_summary':
      body = `${SKILL_MD}\n\n${ctxBlock}\n\n## Task\nAnswer the user's spending question using \`get_insights\` (\`month_report\` or \`scope_report\`) or \`spending_stats\`. Present both original and base currency numbers accurately, never do mental arithmetic, and disclose any missing FX rates (\`incomplete: true\`).${userArg('question')}`;
      break;
    case 'batch_import_subscriptions':
      body = `${SKILL_MD}\n\n${SUBSCRIPTIONS_REF_MD}\n\n${ctxBlock}\n\n## Task\nExtract every subscription cleanly (one subscription per service/column for bill tables), match exact categories and payment methods, let exact \`search_services\` matches auto-fill icons or call \`search_app_store\`, preview with \`dry_run: true\`, then apply.${userArg('data')}`;
      break;
    case 'audit_carpool':
      body = `${SKILL_MD}\n\n${CARPOOL_FILES_REF_MD}\n\n${ctxBlock}\n\n## Task\nUse \`get_carpool\`, \`get_receivables\`, and (when file storage is enabled) \`list_files\` with \`receipt_scope="carpool"\` / \`"proxy"\` and \`duplicate_only=true\` to audit shared plans and proxy subscriptions. Report overdue members, exact pending amounts, next collection dates, owner net cost, and any duplicate or missing collection receipt proofs from tool outputs.${userArg('subscription')}`;
      break;
    default:
      return undefined;
  }

  return {
    description: meta.description,
    messages: [{ role: 'user', content: { type: 'text', text: body } }],
  };
}

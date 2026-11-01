import type { AppState } from '../../shared/types.ts';
import { t } from '../../shared/i18n.ts';
import { ledgerTools, paymentMethodTool } from './ledger-tools.ts';
import { validateToolInput, type Schema } from '../../shared/tool-schema.ts';
import type { ToolCtx, Tool } from './tool-kit.ts';
import {
  get_overview,
  list_categories,
  list_subscriptions,
  get_subscription,
  list_charges,
  spending_stats,
  get_trends,
  list_payment_methods,
  list_people,
  get_receivables,
  get_insights,
  list_events,
  search_app_store,
} from './read-tools.ts';
import {
  create_subscription,
  save_subscription,
  update_subscription,
  change_price,
  change_plan,
  set_status,
  record_payment,
  delete_payment,
  record_transfer,
  set_meters,
  add_readings,
  delete_subscription,
} from './subscription-tools.ts';
import { get_carpool, set_share, save_share_member, remove_share_member, record_receivable } from './share-tools.ts';

export const toolTitle = (name: string) => t(`mcp.tool.${name}`);

export function connectionInfo(ctx: ToolCtx, settings: AppState['settings'], today: string) {
  const scope = ctx.access?.scope ?? 'read';
  let site: string | null = null;
  try {
    const url = new URL(ctx.env.SITE_URL || settings.siteUrl || '');
    site = url.origin + url.pathname;
  } catch {
    /* Unconfigured deployment. */
  }
  return {
    ledger: settings.displayName || 'Calends',
    site_url: site,
    timezone: settings.timezone,
    today,
    base_currency: settings.baseCurrency,
    client: ctx.access?.client ?? 'unknown',
    scope,
    writes_require_confirmation: ctx.access?.client === 'assistant',
    tools: TOOLS.filter((x) => scope === 'write' || !x.write).map((x) => ({ name: x.name, read_only: !x.write, preview: !!x.write })),
  };
}

export const CATALOGUE: Tool[] = [
  ...ledgerTools(connectionInfo),
  get_overview,
  list_categories,
  list_subscriptions,
  get_subscription,
  list_charges,
  spending_stats,
  get_trends,
  list_payment_methods,
  list_people,
  get_receivables,
  get_insights,
  list_events,
  search_app_store,
  create_subscription,
  save_subscription,
  update_subscription,
  change_price,
  change_plan,
  set_status,
  record_payment,
  delete_payment,
  record_transfer,
  set_meters,
  add_readings,
  get_carpool,
  delete_subscription,
  set_share,
  save_share_member,
  remove_share_member,
  record_receivable,
  paymentMethodTool,
];

export const TOOLS: Tool[] = CATALOGUE.map((tool) => ({
  ...tool,
  run: async (args, ctx) => {
    validateToolInput(tool.inputSchema as Schema, args);
    return tool.run(args, ctx);
  },
}));

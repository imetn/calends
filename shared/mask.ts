// 公开页脱敏：服务端只下发这里处理过的数据，浏览器拿不到原始信息
import { DEFAULT_SETTINGS, type AppState, type Payment, type PaymentMethod, type Phase, type Stop, type Subscription } from './types.ts';
import { effectiveStatus, fnv1a, isStopped, migrateRenewalRules, priceAt, todayIn } from './billing.ts';
import { isLocale, t } from './i18n.ts';
import { categoryList, isDomainCategory, presetOf, type Category } from './categories.ts';
import { publicConfigForVisitors, publicParts, type PublicPart } from './public-layout.ts';

const DOMAIN = /\b((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+)([a-z]{2,})\b/gi;

/** framingflow.com → f••••••••.com；只保留首字母和顶级域 */
export function maskDomain(text: string): string {
  return text.replace(DOMAIN, (_m, labels: string, tld: string) => {
    const parts = labels.slice(0, -1).split('.');
    const masked = parts.map((p) => (p.length <= 1 ? '•' : p[0] + '•'.repeat(Math.min(p.length - 1, 8))));
    return `${masked.join('.')}.${tld}`;
  });
}

/** 域名类订阅：「域名」分类（改过名也认得，需传入分类表）、标签或备注提到域名、名称像域名 */
export function isDomainSub(s: Pick<Subscription, 'name' | 'category' | 'tags' | 'notes'>, cats: Category[] = []): boolean {
  // 内置「域名」分类在任何语言下的名字都认（访客的语言可能和建分类时不同）
  if (s.category === '域名' || isDomainCategory(cats, s.category) || presetOf(s.category)?.code === 'domains') return true;
  return /域名|domain/i.test(`${s.category} ${s.tags.join(' ')} ${s.notes ?? ''}`) || new RegExp(DOMAIN.source, 'i').test(s.name);
}

function publicMethod(m: PaymentMethod): PaymentMethod {
  return {
    id: m.id,
    kind: m.kind,
    currency: m.currency,
    region: m.region,
    color: m.color,
    name: m.region ? t('core.publicMethod', { kind: t(`core.methodKind.${m.kind}`), region: m.region }) : t(`core.methodKind.${m.kind}`),
  };
}

/** FNV-1a 短哈希：公开数据里不暴露可能含域名的 id */
const shortHash = (text: string) => fnv1a(text).toString(36);

/** 只保留网址的协议与域名；写得不像网址的不下发（避免整个公开页报错） */
function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith('http') ? url : `https://${url}`).origin;
  } catch {
    return undefined;
  }
}

/** 公开页的一笔扣款（白名单）：不带备注；拆分付款只留来源 id 与金额（与 methodId 同口径，来源本身由 publicMethod 脱敏） */
function publicPayment(pay: Payment): Payment {
  return {
    date: pay.date,
    amount: pay.amount,
    currency: pay.currency,
    kind: pay.kind,
    settled: pay.settled && { amount: pay.settled.amount, currency: pay.settled.currency },
    methodId: pay.methodId,
    ...(pay.funding?.length ? { funding: pay.funding.map(({ methodId, amount }) => ({ methodId, amount })) } : {}),
    ...(pay.periods?.length ? { periods: pay.periods.filter((d) => typeof d === 'string') } : {}),
  };
}

const publicStop = (stop: Stop | undefined) => stop && { kind: stop.kind, date: stop.date, paidThrough: stop.paidThrough, pausedAt: stop.pausedAt };

/** 公开页的一个阶段（白名单）：计费需要的字段，不带备注与停用原因；以后新增的阶段字段不会被顺带公开 */
function publicPhase(p: Phase): Phase {
  return {
    start: p.start,
    billingStart: p.billingStart,
    end: p.end,
    stop: publicStop(p.stop),
    price: p.price,
    currency: p.currency,
    cycle: p.cycle,
    billing: p.billing,
    methodId: p.methodId,
    region: p.region,
    priceHistory: p.priceHistory,
    intro: p.intro,
    bonus: p.bonus,
    payments: p.payments?.filter((pay) => pay.kind !== 'refund').map(publicPayment),
    nextDue: p.nextDue,
    planned: p.planned,
    chargeLeadDays: p.chargeLeadDays,
    cancelLeadDays: p.cancelLeadDays,
    renewalHistory: p.renewalHistory,
    renewalOffsetDays: p.renewalOffsetDays,
  };
}

function publicSub(s: Subscription, cats: Category[]): Subscription {
  s = migrateRenewalRules(s);
  const domain = isDomainSub(s, cats);
  // 未上线项目的域名打码；已上线的（showOnPublic）原样展示
  const hide = domain && !s.showOnPublic;
  return {
    id: hide ? `d-${shortHash(s.id)}` : s.id,
    name: hide ? maskDomain(s.name) : s.name,
    // 域名统一用域名图标；隐藏的域名连网址也不下发，避免暴露真实域名
    icon: domain ? undefined : s.icon,
    url: hide ? undefined : originOf(s.url),
    category: s.category,
    tags: [],
    price: s.price,
    currency: s.currency,
    cycle: s.cycle,
    billing: s.billing,
    settlement: s.settlement,
    start: s.start,
    billingStart: s.billingStart,
    estimateFrom: s.estimateFrom,
    chargeLeadDays: s.chargeLeadDays,
    cancelLeadDays: s.cancelLeadDays,
    renewalHistory: s.renewalHistory,
    renewalOffsetDays: s.renewalOffsetDays,

    end: s.end,
    status: s.status,
    stop: publicStop(s.stop),
    trialEnd: s.trialEnd,
    pausedAt: s.pausedAt,
    pauses: s.pauses,
    methodId: s.methodId,
    region: s.region,
    intro: s.intro,
    bonus: s.bonus,
    priceHistory: s.priceHistory,
    // 计费需要的结构原样保留：阶段、实际扣款、下次扣款日（不含敏感信息）
    phases: s.phases?.map(publicPhase),
    payments: s.payments?.filter((pay) => pay.kind !== 'refund').map(publicPayment),
    nextDue: s.nextDue,
    // 不带合租：公开页展示订阅本身的价格，成员付满整价时也不显示 0；成员的分摊与收款记录不公开
  };
}

/** 哪些部分用到哪类数据：相关部分全部隐藏后，这类数据就不下发；只隐藏一部分时仍要下发 */
const NEEDS_NAMES: PublicPart[] = ['timeline', 'list', 'ended', 'lifetime', 'pile', 'calendar', 'years', 'tenure', 'treemap', 'changes'];
const NEEDS_HISTORY: PublicPart[] = ['stats', 'timeline', 'chart', 'list', 'calendar', 'years', 'tenure', 'changes', 'waterfall'];
const NEEDS_ENDED: PublicPart[] = ['stats', 'timeline', 'chart', 'ended', 'calendar', 'years', 'tenure', 'changes', 'waterfall'];
const NEEDS_CATEGORIES: PublicPart[] = ['composition', 'list', ...NEEDS_NAMES];
/** 用到地区的部分：地球只要地区和金额，不要名字 */
const NEEDS_REGIONS: PublicPart[] = ['globe', ...NEEDS_NAMES];
/** 用到金额的部分（订阅堆按金额筛选）：全部隐藏后订阅和付款来源都不下发 */
const NEEDS_AMOUNTS: PublicPart[] = [
  'stats',
  'timeline',
  'chart',
  'composition',
  'fx',
  'list',
  'ended',
  'lifetime',
  'pile',
  'calendar',
  'years',
  'tenure',
  'treemap',
  'changes',
  'waterfall',
  'globe',
];

/** 去掉扣款和价格历史，只留算出 day 当天价格所需的一条 */
function withoutHistory<T extends Phase>(p: T, day: string): T {
  const price = priceAt(p as unknown as Subscription, day);
  return { ...p, price, payments: undefined, priceHistory: undefined, renewalHistory: undefined, nextDue: undefined };
}

export function maskForPublic(state: AppState, opts: { untrimmed?: boolean } = {}): AppState {
  const cats = categoryList(state.settings, state.subscriptions);
  const config = state.settings.publicPage;
  // 自定义里隐藏的组件，只有不再被其他可见部分用到的数据才不下发。编辑页预览传 untrimmed，草稿可能重新打开任何组件
  const parts = opts.untrimmed ? undefined : publicParts(config);
  const needs = (of: PublicPart[]) => !parts || of.some((x) => parts.has(x));
  const today = todayIn(state.settings.timezone);
  // 代付涉及他人，公开页完全不出现；设置里取消展示的也不下发
  const hidden = new Set(state.settings.publicHidden ?? []);
  const keepEnded = needs(NEEDS_ENDED);
  const keepLifetime = needs(['lifetime']);
  const keepAmounts = needs(NEEDS_AMOUNTS);
  const subs = state.subscriptions.filter(
    (s) =>
      keepAmounts && !s.proxy && !hidden.has(s.id) && (keepEnded || !isStopped(effectiveStatus(s, today)) || (keepLifetime && s.cycle.unit === 'lifetime')),
  );
  const keepCategories = needs(NEEDS_CATEGORIES);
  const used = new Set(keepCategories ? subs.map((s) => s.category) : []);
  const keepNames = needs(NEEDS_NAMES);
  const keepHistory = needs(NEEDS_HISTORY);
  const keepRegions = needs(NEEDS_REGIONS);
  const trimSub = (s: Subscription, i: number): Subscription => {
    // 已结束的订阅按结束那天的价格算「原来每月多少」，结束日在未来也一样（已付至未来）
    const day = isStopped(effectiveStatus(s, today)) ? (s.end ?? today) : today;
    const flat = keepHistory
      ? s
      : { ...withoutHistory(s, day), ...(s.cycle.unit === 'lifetime' ? { price: s.price } : {}), phases: s.phases?.map((p) => withoutHistory(p, day)) };
    return {
      ...flat,
      ...(keepNames ? {} : { id: `s${i}`, name: '', icon: undefined, url: undefined }),
      ...(keepRegions ? {} : { region: undefined, phases: flat.phases?.map((p) => ({ ...p, region: undefined })) }),
      ...(keepCategories ? {} : { category: '' }),
    };
  };
  return {
    readonly: true,
    fx: state.fx,
    fxHistory: state.fxHistory,
    // 设置只挑公开页需要的字段（白名单），以后新增的设置不会被顺带公开
    settings: {
      ...DEFAULT_SETTINGS,
      baseCurrency: state.settings.baseCurrency,
      signedAmounts: state.settings.signedAmounts !== false,
      timezone: state.settings.timezone,
      // 自定义了标题就不再需要真实名字
      displayName: state.settings.publicTitle?.trim() ? '' : state.settings.displayName,
      avatar: config?.avatar ?? state.settings.avatar,
      publicTitle: state.settings.publicTitle,
      publicPage: publicConfigForVisitors(config),
      weekStart: state.settings.weekStart,
      // 公开页跟主人的界面语言走；主人跟随浏览器时用后台最近实际用的语言
      language: isLocale(state.settings.language) ? state.settings.language : state.settings.languageSeen,
      gainColor: state.settings.gainColor,
      publicView: true,
      remindDays: 0,
      monthlyDigest: false,
      // 分类只下发公开订阅用到的：名称、图标、颜色，以及「域名」标记（公开页据此用注册商图标）
      categories: cats
        .filter((c) => used.has(c.name))
        .map((c) => ({ name: c.name, icon: c.icon, color: c.color, preset: c.preset === 'domains' ? c.preset : undefined })),
    },
    // 不展示名字时付款来源的名字不留；不展示地区时地区也不能留：methodId 连着它就能还原订阅的地区
    methods: keepAmounts
      ? state.methods
          .map(publicMethod)
          .map((m) => (keepNames ? m : { ...m, name: '' }))
          .map((m) => (keepRegions ? m : { ...m, region: undefined }))
      : [],
    subscriptions: subs.map((s, i) => trimSub(publicSub(s, cats), i)),
  };
}

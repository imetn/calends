import { bankOf, domainOf, faviconOf, isDataIcon, METHOD_BRAND_LOGO } from '../../shared/icon.ts';
import { indigo, red, purple, green, orange, teal, pink, iris, gray, gold, slate, blue } from '@radix-ui/colors';
import { base } from './base.ts';
import { addDays, addMonths, chargesBetween, convert, effectiveStatus, parseDay, type Charge } from '../../shared/billing.ts';
import { chargeBaseOrNaN, chargeValue } from '../../shared/fx.ts';
import type { AppState, CardNetwork, MethodKind, PaymentMethod, Subscription } from '../../shared/types.ts';
import { locale, t } from '../../shared/i18n.ts';
import { categoryColor, categoryList, findCategory, isDomainCategory, presetCategory, type Category } from '../../shared/categories.ts';

/** 当前生效的分类表（名称、图标、颜色、顺序）：后台和公开页每次渲染前用最新数据同步，各处按分类名查 */
let REG: Category[] = [];
let regKey: unknown[] = [];
export function syncCategories(state: Pick<AppState, 'settings' | 'subscriptions'>): Category[] {
  // 语言变了也要重算：没存过分类表时，内置分类按当前语言命名
  const key = [state.settings.categories, state.subscriptions, locale()];
  if (key.some((k, i) => k !== regKey[i])) {
    REG = categoryList(state.settings, state.subscriptions);
    regKey = key;
  }
  return REG;
}
export const categories = (): Category[] => REG;
const catOf = (name: string): Category | undefined => findCategory(REG, name);
/** 分类图标：Lucide 图标名或 emoji */
export const catIcon = (name: string): string => catOf(name)?.icon ?? 'tag';
export const catColor = (name: string, step: 3 | 9 | 11 = 9): string => {
  const color = paletteColor(categoryColor(catOf(name), name));
  if (step === 9) return color;
  const families = ['indigo', 'red', 'purple', 'green', 'orange', 'teal', 'pink', 'iris', 'gray', 'gold'];
  const category = /^var\(--c(\d+)\)$/.exec(color);
  const family = category ? families[Number(category[1]) - 1] : /var\(--([a-z]+)-9\)/.exec(color)?.[1];
  return `var(--${family ?? 'gray'}-${step})`;
};
/** 「域名」分类：域名用注册商图标、可在公开页打码；改过名也认得 */
export const isDomainCat = (name: string): boolean => isDomainCategory(REG, name);
/** 某个内置分类现在的名称（用户可能改过名），新建订阅的默认分类、App Store 类别映射用它 */
export const presetCat = (code: string): string => presetCategory(REG, code);

/** 支付方式类型名；用 getter 在读取时才取文案（模块加载时语言包还没就绪） */
export const KIND_LABEL: Record<MethodKind, string> = {
  get debit() {
    return t('list.kind.debit');
  },
  get credit() {
    return t('list.kind.credit');
  },
  get alipay() {
    return t('list.kind.alipay');
  },
  get wechat() {
    return t('list.kind.wechat');
  },
  get paypal() {
    return t('list.kind.paypal');
  },
  get appstore() {
    return t('list.kind.appstore');
  },
  get googleplay() {
    return t('list.kind.googleplay');
  },
  get giftcard() {
    return t('list.kind.giftcard');
  },
  get prepaid() {
    return t('list.kind.prepaid');
  },
  get phone() {
    return t('list.kind.phone');
  },
  get crypto() {
    return t('list.kind.crypto');
  },
  get other() {
    return t('list.kind.other');
  },
};

// 卡面底色：中性石墨或品牌纯色，不用蓝紫渐变；App Store 卡另有钛金属卡面
export const KIND_BG: Record<MethodKind, string> = {
  debit: 'linear-gradient(135deg,#3a3f47,#1c1f24)',
  credit: 'linear-gradient(135deg,#2c2c30,#111113)',
  alipay: '#1677ff',
  wechat: '#07c160',
  paypal: '#003087',
  appstore: 'linear-gradient(135deg,#fbfbfd,#e4e4e8)',
  googleplay: '#ffffff',
  giftcard: 'linear-gradient(135deg,#f08a4b,#d4532b)',
  prepaid: 'linear-gradient(135deg,#3a3f47,#1c1f24)',
  phone: 'linear-gradient(135deg,#2fbf71,#0f7d55)',
  crypto: 'linear-gradient(135deg,#1f2933,#4a3b10)',
  other: 'linear-gradient(135deg,#55626c,#262e34)',
};

/** Map legacy custom UI colors to the shared palette without rewriting stored preferences. */
const swatches = { indigo, red, purple, green, orange, teal, pink, iris, gray, gold, slate, blue };
const rgb = (hex: string) => {
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};
export function paletteColor(value: string | undefined, fallback = 'var(--c9)'): string {
  if (!value) return fallback;
  // Category colors already refer to the shared c1–c10 aliases.
  if (/^var\(--(?:c(?:10|[1-9])|[a-z]+-(?:[1-9]|1[0-2]))\)$/.test(value)) return value;
  const map = (hex: string) => {
    const source = rgb(hex);
    const neutral = Math.max(...source) - Math.min(...source) < 20;
    const nearest = Object.entries(neutral ? { slate, gray } : swatches).sort(([, a], [, b]) => {
      const distance = (scale: object) => rgb(Object.values(scale)[8].slice(1)).reduce((sum, c, i) => sum + (c - source[i]) ** 2, 0);
      return distance(a) - distance(b);
    })[0][0];
    return `color-mix(in srgb, var(--${nearest}-9) 75%, var(--black-a12))`;
  };
  if (/^#[\da-f]{3}(?:[\da-f]{3})?$/i.test(value)) return map(value.slice(1));
  if (/^linear-gradient\(\d+deg,\s*#[\da-f]{3,6},\s*#[\da-f]{3,6}\)$/i.test(value)) {
    return value.replace(/#([\da-f]{3,6})/gi, (_, hex: string) => map(hex));
  }
  return fallback;
}

/**
 * 平台品牌：这几类支付方式本身就是一个平台，选了类型就自动用它的 logo。
 * 其余的（银行卡从银行列表选；加密卡、商家余额、运营商等）由用户自己设 logo，不在代码里写死某一家。
 */
interface Brand {
  key: string;
  name: string;
  logo: string;
  kinds: MethodKind[];
  /** logo 是白色的，放在品牌色底上 */
  onColor?: boolean;
}
export const BRANDS: Brand[] = [
  { key: 'appstore', name: 'App Store', logo: base(METHOD_BRAND_LOGO.appstore!), kinds: ['appstore'] },
  { key: 'googleplay', name: 'Google Play', logo: base(METHOD_BRAND_LOGO.googleplay!), kinds: ['googleplay'] },
  { key: 'paypal', name: 'PayPal', logo: base(METHOD_BRAND_LOGO.paypal!), kinds: ['paypal'], onColor: true },
  {
    key: 'alipay',
    get name() {
      return t('list.kind.alipay');
    },
    logo: base(METHOD_BRAND_LOGO.alipay!),
    kinds: ['alipay'],
    onColor: true,
  },
  {
    key: 'wechat',
    get name() {
      return t('list.kind.wechat');
    },
    logo: base(METHOD_BRAND_LOGO.wechat!),
    kinds: ['wechat'],
    onColor: true,
  },
];

/** 卡面品牌 logo */
const BRAND_LOGO: Record<string, string> = Object.fromEntries(BRANDS.map((b) => [b.key, b.logo]));

/** 平台品牌（只按类型认） */
export function brandOf(m: Pick<PaymentMethod, 'kind'>): string | undefined {
  return BRANDS.find((b) => b.kinds.includes(m.kind))?.key;
}

/** 支付方式的 logo：自定义 > 平台品牌 > 官网图标；银行卡没设自定义时用银行图标集（见 bankOf） */
export function methodLogo(m: Pick<PaymentMethod, 'logo' | 'kind' | 'url' | 'bank' | 'name'>): string | undefined {
  if (m.logo) return m.logo;
  const b = brandOf(m);
  if (b) return BRAND_LOGO[b];
  if (bankOf(m)) return undefined;
  return faviconOf(m.url);
}

/** 只用一种货币的国家：没填地区时，App Store、礼品卡、话费按币种推断国旗 */
const CCY_REGION: Record<string, string> = {
  CNY: 'CN',
  TRY: 'TR',
  NGN: 'NG',
  PHP: 'PH',
  JPY: 'JP',
  HKD: 'HK',
  MOP: 'MO',
  TWD: 'TW',
  KRW: 'KR',
  INR: 'IN',
  PKR: 'PK',
  EGP: 'EG',
  BRL: 'BR',
  ARS: 'AR',
  GBP: 'GB',
  MYR: 'MY',
  THB: 'TH',
  VND: 'VN',
  IDR: 'ID',
  SGD: 'SG',
  CAD: 'CA',
  AUD: 'AU',
  RUB: 'RU',
  UAH: 'UA',
  KZT: 'KZ',
  CHF: 'CH',
  MXN: 'MX',
};

/** 支付方式所属的地区：填了就用填的；按地区区分的账户（App Store、礼品卡、话费）没填时看币种 */
export function methodRegion(m: Pick<PaymentMethod, 'region' | 'kind' | 'currency'>): string | undefined {
  if (m.region) return m.region;
  if (['appstore', 'googleplay', 'giftcard', 'phone'].includes(m.kind)) return CCY_REGION[m.currency];
  return undefined;
}

/** 卡组织名称；图标在 public/networks（datatrans/payment-logos，CC BY-SA 4.0） */
export const NETWORKS: Record<CardNetwork, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  get unionpay() {
    return t('list.network.unionpay');
  },
  jcb: 'JCB',
  'american-express': 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  maestro: 'Maestro',
};

export { bankOf, domainOf, faviconOf };

/** 支付方式显示名（纯文字；国旗用 FlagImg 另画，不拼 emoji） */
export function methodName(m: Pick<PaymentMethod, 'name' | 'region' | 'kind' | 'currency'>): string {
  return m.name;
}

export function liveSubs(state: AppState, today: string): Subscription[] {
  return state.subscriptions.filter((s) => {
    const st = effectiveStatus(s, today);
    return st === 'active' || st === 'ending' || st === 'trial';
  });
}

/** 按当前汇率换算到本位币；缺汇率为 NaN（金额显示「—」），不当作 0 */
export function toBase(state: AppState, amount: number, ccy: string): number {
  return convert(amount, ccy, state.settings.baseCurrency, state.fx);
}

/** 账本里最早的开始日（没有更早的就是今天）：时间线、年份选择从这里开始 */
export const firstStart = (state: AppState, today: string) => state.subscriptions.reduce((m, s) => (s.start < m ? s.start : m), today);

/** 排序用：缺汇率（NaN）的排在最后，其余按数值；正常数据与直接相减相同 */
export const sortValue = (v: number) => (Number.isFinite(v) ? v : -Infinity);

/** 区间内的扣款。默认不含代付（那是替别人付的，不算我的支出）；日历等需要看卡上实际扣款时传 withProxy */
export function allCharges(state: AppState, from: string, to: string, today: string, withProxy = false): Charge[] {
  return state.subscriptions
    .filter((s) => withProxy || !s.proxy)
    .flatMap((s) => chargesBetween(s, from, to, today))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 订阅的图片图标，用作卡片和详情的背景光晕：图片链接 > 官网图标；域名类不用 */
export function subImage(s: Pick<Subscription, 'category' | 'icon' | 'url'>): string | undefined {
  if (isDomainCat(s.category)) return undefined;
  if (s.icon?.startsWith('http') || isDataIcon(s.icon)) return s.icon;
  return faviconOf(s.url);
}

export type Period = 'day' | 'week' | 'month' | 'year';

/** 当前周期向前/后偏移 offset 个周期的 [from, to]（含两端） */
export function periodRange(p: Period, today: string, offset = 0): [string, string] {
  if (p === 'day') {
    const d = addDays(today, offset);
    return [d, d];
  }
  if (p === 'week') {
    const dow = (new Date(parseDay(today)).getUTCDay() + 6) % 7;
    const from = addDays(today, -dow + offset * 7);
    return [from, addDays(from, 6)];
  }
  if (p === 'month') {
    const from = addMonths(today.slice(0, 8) + '01', offset);
    return [from, addDays(addMonths(from, 1), -1)];
  }
  const y = Number(today.slice(0, 4)) + offset;
  return [`${y}-01-01`, `${y}-12-31`];
}

/** 一组扣款折算后的合计；to 缺省为本位币。缺汇率的按 0 计：只用于图表几何（柱高、坐标），显示的合计用 sumBaseOrNaN */
export function sumBase(state: AppState, charges: Charge[], to?: string): number {
  return charges.reduce((a, c) => a + chargeValue(state, c, to), 0);
}

/** 显示用的合计：任一笔缺汇率则为 NaN，金额显示「—」，不把不完整的数当成合计 */
export function sumBaseOrNaN(state: AppState, charges: Charge[], to?: string): number {
  return charges.reduce((a, c) => a + chargeBaseOrNaN(state, c, to), 0);
}

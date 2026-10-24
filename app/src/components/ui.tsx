import { submitSheet } from '../keyboard.ts';
import { numberFormat } from '../../../shared/intl.ts';
import { copyParts } from './copy.tsx';
import './ui.css';
import { createPortal } from 'react-dom';
import { tooltipPosition } from './tooltip-position.ts';
import { base } from '../base.ts';
import type { ReactNode as ComponentChildren, CSSProperties, HTMLAttributes, JSX } from 'react';
import {
  Button as AriaButton,
  Tooltip,
  TooltipTrigger,
  Dialog,
  Heading,
  Modal,
  ModalOverlay,
  Switch as AriaSwitch,
  ToggleButton,
  ToggleButtonGroup,
} from 'react-aria-components';
import { Children, Fragment, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { currencyDecimals, moneyDecimals, flowSign, symbol } from '../../../shared/format.ts';
import { FLAGS } from '../display.ts';
import type { CardNetwork, PaymentMethod, Subscription } from '../../../shared/types.ts';
import { bankOf, BRANDS, brandOf, catColor, catIcon, faviconOf, isDomainCat, KIND_BG, paletteColor, methodLogo, methodRegion, NETWORKS } from '../derive.ts';
import { CatGlyph } from './CatGlyph.tsx';
import { intlLocale, t } from '../../../shared/i18n.ts';
import { Toaster, toast as notify } from 'sonner';

// ---------- SF Symbols 风格线性图标 ----------
const P: Record<string, JSX.Element> = {
  key: (
    <>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2M17 6l3 3M14 9l2 2" />
    </>
  ),
  chart: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  cal: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="3" />
      <path d="M3 9.5h18M8 2.5v4M16 2.5v4" />
    </>
  ),
  list: (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="3" />
      <path d="M7.5 9h9M7.5 12.5h9M7.5 16h5" />
    </>
  ),
  wallet: (
    <>
      <rect x="3" y="5" width="18" height="14.5" rx="3" />
      <path d="M3 9.5h18M15.5 14.5h2" />
    </>
  ),
  car: (
    <>
      <circle cx="8" cy="8" r="3" />
      <circle cx="16.5" cy="9" r="2.5" />
      <path d="M2.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M14 14.2c.8-.4 1.6-.7 2.5-.7 2.3 0 4.2 1.8 4.7 4.5" />
    </>
  ),
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  menu: <path d="M4 7h16M4 12h10M4 17h16" />,
  compose: <path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M18.4 3.6a2 2 0 0 1 2.8 2.8L12 15.6l-3.6.8.8-3.6z" />,
  home: <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  // 拖动排序的把手
  grip: (
    <>
      <circle cx="9" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="15" cy="18" r="1" />
    </>
  ),
  // 侧边栏「AI 助手」：带两行字的对话气泡
  chat: (
    <>
      <path d="M21 12a8.5 8.5 0 0 1-12.6 7.45L3 21l1.55-5.4A8.5 8.5 0 1 1 21 12Z" />
      <path d="M8.5 10.5h7M8.5 14h4.5" />
    </>
  ),
  // 侧边栏「AI」
  bot: (
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 8V4.5M10 4.5h4M2 13.5v2M22 13.5v2M9.5 13v1.5M14.5 13v1.5" />
    </>
  ),
  users: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  // 代付：一来一回
  swap: <path d="M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />,
  left: <path d="m15 18-6-6 6-6" />,
  'sort-asc': <path d="m3 8 4-4 4 4M7 4v16M11 12h4M11 16h7M11 20h10" />,
  'sort-desc': <path d="m3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4" />,
  right: <path d="m9 18 6-6-6-6" />,
  down: <path d="m6 9 6 6 6-6" />,
  updown: <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  ban: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m5.7 5.7 12.6 12.6" />
    </>
  ),
  receipt: <path d="M6 2.5h12v19l-3-2-3 2-3-2-3 2zM9 7.5h6M9 11.5h6M9 15.5h3" />,
  link: <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1" />,
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  download: <path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16" />,
  edit: <path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4" />,
  bell: <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0" />,
  leaf: <path d="M5 19c0-8 5-13 15-14-1 10-6 15-14 15M5 19l7-7" />,
  sidebar: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="M9 4v16" />
    </>
  ),
  coins: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M18.09 10.37A6 6 0 1 1 10.34 18M7 6h1v4M16.71 13.88l.7.71-2.82 2.82" />
    </>
  ),
  copy: (
    <>
      <rect x="8" y="8" width="12" height="12" rx="2.5" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>
  ),
  share: <path d="M12 3v12M8 7l4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
};

export function Icon({ name, size }: { name: keyof typeof P | string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden="true"
      className="i"
    >
      {P[name]}
    </svg>
  );
}

// ---------- 订阅图标：emoji > 图片 URL > 站点图标 > 渐变首字母 ----------
const failed = new Set<string>();

/** proxied：经 /api/img 同源中转，导出图片时画布不会被跨域图片污染 */
export function SubIcon({ sub, size = 40, proxied }: { sub: Pick<Subscription, 'name' | 'icon' | 'url' | 'category'>; size?: number; proxied?: boolean }) {
  // failed 是模块级的集合，React Compiler 看不到它的变化：用 tried 计数让「挑哪张图」随失败重新计算
  const [tried, force] = useState(0);
  const tint = catColor(sub.category);
  const style = { '--s': `${size}px`, '--tint': tint } as Record<string, string>;
  // 域名用注册商的图标，不用各自的站点图标：默认 Cloudflare，其他注册商在 icon 里填它的图标
  if (isDomainCat(sub.category)) {
    return (
      <span className="ico domain" style={style}>
        <img
          decoding="async"
          src={sub.icon?.startsWith('http') ? (proxied ? base(`/api/img?u=${encodeURIComponent(sub.icon)}`) : sub.icon) : base('/brands/cloudflare.svg')}
          alt=""
        />
      </span>
    );
  }
  const icon = sub.icon?.trim();
  // 不是链接也不是站内图片路径（/ai/claude.svg）的，当 emoji 显示
  if (icon && !/^(https?:|\/)/.test(icon)) {
    return (
      <span className="ico emoji" style={style}>
        {icon}
      </span>
    );
  }
  // 依次尝试：填写的图标 → 官网图标；都加载失败才用首字母
  const viaProxy = (u: string) => (proxied && /^https?:/.test(u) ? base(`/api/img?u=${encodeURIComponent(u)}`) : base(u));
  const raw = [icon, faviconOf(sub.url)].find((u): u is string => tried >= 0 && !!u && !failed.has(viaProxy(u)));
  const src = raw && viaProxy(raw);
  if (src) {
    const fail = () => {
      failed.add(src);
      force((n) => n + 1);
    };
    return (
      // 目录里的矢量标志（public/ai、public/brands/*.svg）是透明底，按站点图标那样放在白底上
      <span className={`ico ${raw === icon && !/^\/(ai\/|brands\/.*\.svg$)/.test(icon) ? 'app' : 'fav'}`} style={style}>
        <img
          decoding="async"
          src={base(src)}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={(e) => {
            // Google 对未知域名返回 16px 的地球占位图
            if (raw !== icon && e.currentTarget.naturalWidth <= 16) fail();
          }}
          onError={fail}
          // 失败的图片（尤其是缓存里的）可能在监听器挂上之前就已报错：挂载时补查一次
          ref={(el) => {
            if (el?.complete && el.naturalWidth === 0) queueMicrotask(fail);
          }}
        />
      </span>
    );
  }
  const letter = [...sub.name.replace(/^(域名|VPS)\s*/, '')][0]?.toUpperCase() ?? '?';
  return (
    <span className="ico mono" style={style}>
      {letter}
    </span>
  );
}

/**
 * 支付方式胶囊：只讲「用什么付」。商店账户显示产品名（App Store、Google Play），用户起的账户名放在提示里；
 * 地区是订阅自己的属性，由 RegionTag 单独显示，这里不加国旗角标。
 */
export function PayBadge({ m }: { m?: PaymentMethod }) {
  if (!m) return <span className="pay none">{t('ui.method.none')}</span>;
  const store = m.kind === 'appstore' || m.kind === 'googleplay';
  return (
    <span className="pay" title={m.name}>
      <MethodMark m={m} size={16} flag={false} />
      <span className="pay-name">{store ? t(`core.methodKind.${m.kind}`) : m.name}</span>
    </span>
  );
}

/** 地区名跟随当前语言 */
const regionNameCache = new Map<string, Intl.DisplayNames | undefined>();
export function regionLabel(cc: string): string {
  const loc = intlLocale();
  if (!regionNameCache.has(loc)) {
    try {
      regionNameCache.set(loc, new Intl.DisplayNames([loc], { type: 'region' }));
    } catch {
      regionNameCache.set(loc, undefined);
    }
  }
  try {
    return regionNameCache.get(loc)?.of(cc.toUpperCase()) ?? cc.toUpperCase();
  } catch {
    return cc.toUpperCase();
  }
}

/** 订阅的地区：订阅自己填的优先，没填时用支付账户的地区（商店账户、手机卡等） */
export function subRegion(sub: { region?: string }, m?: PaymentMethod): string | undefined {
  return sub.region || (m ? methodRegion(m) : undefined) || undefined;
}

/** 地区胶囊：国旗 + 地区名，和分类、支付方式并排独立显示 */
export function RegionTag({ cc }: { cc?: string }) {
  if (!cc) return null;
  return (
    <span className="region-tag" title={cc.toUpperCase()}>
      <FlagImg cc={cc} />
      <span>{regionLabel(cc)}</span>
    </span>
  );
}

/** 分类图标（按分类表里设的图标或 emoji） */
export function CatIcon({ cat, size = 14 }: { cat: string; size?: number }) {
  return <CatGlyph icon={catIcon(cat)} size={size} />;
}

/** 分类胶囊：分类色 + 图标 + 名称 */
export function CatChip({ cat }: { cat: string }) {
  return (
    <span className="cat-chip" style={{ '--tint': catColor(cat), '--tint-text': catColor(cat, 11), '--tint-soft': catColor(cat, 3) } as Record<string, string>}>
      <CatIcon cat={cat} size={12} />
      {cat}
    </span>
  );
}

/**
 * 支付方式标记：统一显示支付产品自己的 logo —— 银行卡用银行图标集，
 * App Store、Plasma、SMART、Bybit 用各自的标；有地区的在右下角加国旗角标。没有可用 logo 时用卡片图标。
 */
export function MethodMark({ m, size = 36, proxied, flag = true }: { m: PaymentMethod; size?: number; proxied?: boolean; flag?: boolean }) {
  const brand = brandOf(m);
  const bank = bankOf(m);
  const region = methodRegion(m);
  // 小圆标优先用银行图标集（专为小尺寸设计）；其余用自定义 / 平台 / 官网 logo
  const logo = bank ? undefined : methodLogo(m);
  const src = bank
    ? base(`/banks/${bank}-rect.svg`)
    : logo
      ? proxied && /^https?:/.test(logo)
        ? base(`/api/img?u=${encodeURIComponent(logo)}`)
        : base(logo)
      : undefined;
  const [failedSrc, setFailedSrc] = useState<string>();
  const fallback = brand !== 'appstore' && (!src || failedSrc === src);
  const bg = fallback
    ? markBg(m, undefined, undefined)
    : bank || brand === 'appstore'
      ? undefined
      : markBg(m, logo, BRANDS.find((b) => b.key === brand)?.onColor);
  const style = { '--s': `${size}px`, background: bg } as Record<string, string>;
  return (
    <span className={`mmark ${bank && !fallback ? 'bank' : (brand ?? '')} ${m.logoWide ? 'wide' : ''}`} style={style} aria-hidden="true">
      {fallback ? (
        <Icon name="wallet" size={Math.round(size * 0.7)} />
      ) : brand === 'appstore' ? (
        <i className="mm-glyph" />
      ) : (
        <img
          src={src}
          alt=""
          onError={() => setFailedSrc(src)}
          ref={(el) => {
            if (el?.complete && el.naturalWidth === 0) queueMicrotask(() => setFailedSrc(src));
          }}
        />
      )}
      {flag && region && <FlagImg cc={region} className="mm-flag" />}
    </span>
  );
}

/** 标记底色：白色 logo 放在卡面色上，彩色 logo 放在白底上 */
function markBg(m: PaymentMethod, logo: string | undefined, onColor: boolean | undefined): string {
  if (onColor) return KIND_BG[m.kind] ?? KIND_BG.other;
  if (logo) return m.color && m.logo ? paletteColor(m.color) : 'var(--white-a12)';
  return paletteColor(m.color, KIND_BG[m.kind] || KIND_BG.other);
}

/** 卡组织标：Visa、Mastercard、银联… */
export function NetworkMark({ network, height = 20 }: { network?: CardNetwork; height?: number }) {
  if (!network) return null;
  return <img className="net-mark" src={base(`/networks/${network}.svg`)} alt={NETWORKS[network]} title={NETWORKS[network]} style={{ height }} />;
}

/** 小组件式金额：小数位缩小 */
export function Amount({ value, ccy, compact, plain, decimals }: { value: number; ccy: string; compact?: boolean; plain?: boolean; decimals?: number }) {
  if (!Number.isFinite(value)) return <span className="amt">—</span>;
  const abs = Math.abs(value);
  const digits = moneyDecimals(value, ccy, { compact, decimals });
  // 整数分组和小数点都跟随当前语言（德语 1.234,56、法语 1 234,56），小数部分缩小显示
  const parts = numberFormat(intlLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).formatToParts(abs);
  const int = parts
    .filter((p) => p.type !== 'decimal' && p.type !== 'fraction')
    .map((p) => p.value)
    .join('');
  const point = parts.find((p) => p.type === 'decimal')?.value;
  const dec = parts.find((p) => p.type === 'fraction')?.value;
  return (
    <span className="amt" style={!plain && value > 0 ? { color: 'var(--green)' } : undefined}>
      {plain ? (value < 0 ? '−' : '') : flowSign(value)}
      <span className="cur">{symbol(ccy).trim()}</span>
      {int}
      {dec && (
        <small className="amt-fraction" style={{ color: 'inherit', opacity: 0.72 }}>
          {point}
          {dec}
        </small>
      )}
    </span>
  );
}

/** 分段控件：单选、不能取消；左右方向键切换（react-aria 的 ToggleButtonGroup） */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  small,
  disabledKeys,
}: {
  value: T;
  options: Array<[T, string]>;
  onChange: (v: T) => void;
  small?: boolean;
  disabledKeys?: T[];
}) {
  return (
    <ToggleButtonGroup
      className={`seg ${small ? 'sm' : ''}`}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k != null && k !== value) onChange(k as T);
      }}
    >
      {options.map(([k, l]) => (
        <ToggleButton key={k} id={k} isDisabled={disabledKeys?.includes(k)} className={({ isSelected }) => (isSelected ? 'on' : '')}>
          {l}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

/** 独立灰底指标卡；等宽排列并随容器换行，金额与颜色由调用处提供。 */
/**
 * 一组并列指标。页面顶部与弹窗顶部用独立灰卡；放在另一张卡片里时传 inline，改为竖线分隔的一行，避免卡片套卡片；
 * 窄栏里的四项（概览、报告的大数字下方）传 plain：两行两列，不加底色与分割线。
 */
export function MetricCards({ children, inline = false, plain = false }: { children: ComponentChildren; inline?: boolean; plain?: boolean }) {
  const count = Children.toArray(children).length;
  if (count === 0) return null;
  return (
    <div
      className={`metric-cards ${inline ? 'inline' : ''} ${plain ? 'plain' : ''}`}
      style={{ '--metric-columns': Math.min(4, count) } as CSSProperties}
      data-count={count}
    >
      <div className="metric-grid">{children}</div>
    </div>
  );
}

export function Metric({
  label,
  value,
  note,
  accessory,
  valueClassName = '',
  valueStyle,
  noteStyle,
  ...props
}: {
  label: ComponentChildren;
  value: ComponentChildren;
  note?: ComponentChildren;
  accessory?: ComponentChildren;
  valueClassName?: string;
  valueStyle?: CSSProperties;
  noteStyle?: CSSProperties;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div {...props} className="metric">
      <div className="metric-top">
        <small>{label}</small>
        {accessory}
      </div>
      <div className={`metric-value ${valueClassName}`} style={valueStyle}>
        {value}
      </div>
      {note != null && (
        <div className="metric-note" style={noteStyle}>
          {note}
        </div>
      )}
    </div>
  );
}

/** 页面工具栏：桌面端为半透明窗口工具栏，手机端为大标题 */
export function Toolbar({ title, sub, children }: { title: ComponentChildren; sub?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <header className="toolbar">
      <IconButton className="sb-btn tb-lead" aria-label={t('ui.toolbar.openSidebar')} onClick={() => window.dispatchEvent(new Event('ledger:drawer'))}>
        <Icon name="menu" />
      </IconButton>
      <div className="tb-title">
        <h1>{copyParts(title)}</h1>
        {sub && <div className="tb-sub">{copyParts(sub)}</div>}
      </div>
      <IconButton className="sb-btn tb-trail" aria-label={t('ui.toolbar.add')} onClick={() => window.dispatchEvent(new Event('ledger:add'))}>
        <Icon name="compose" />
      </IconButton>
      <div className="tb-actions">{children}</div>
    </header>
  );
}

// ---------- 弹层 ----------
/** 打开中的弹窗，后开的在上面 */
const openSheets: object[] = [];

/**
 * 弹窗（react-aria Modal）：宽屏居中，窄屏贴底。点遮罩、按 Esc 关闭，多层叠放时只关最上面那层；
 * 打开期间焦点留在弹窗里、背景不滚动，关闭后焦点回到打开它的按钮。
 * 没有标题（bare）时用 label 作为读屏名称。
 */
export function Sheet(props: {
  title?: ComponentChildren;
  label?: string;
  onClose: () => void;
  children: ComponentChildren;
  foot?: ComponentChildren;
  narrow?: boolean;
  bare?: boolean;
  actions?: ComponentChildren;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // 兜底：焦点不在弹窗里（如落在 body 上）时 react-aria 收不到 Esc，这里替最上面那层关掉
  const close = useEffectEvent(() => props.onClose());
  useEffect(() => {
    const me = {};
    openSheets.push(me);
    const onKey = (e: KeyboardEvent) => {
      if (openSheets[openSheets.length - 1] !== me) return;
      if (e.key === 'Escape' && e.target === document.body) close();
      if (dialog.current) submitSheet(e, dialog.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      openSheets.splice(openSheets.indexOf(me), 1);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);
  return (
    <ModalOverlay className="scrim" isOpen isDismissable onOpenChange={(o) => !o && props.onClose()}>
      <Modal className={`sheet ${props.narrow ? 'narrow' : ''} ${props.bare ? 'bare' : ''}`}>
        <Dialog ref={dialog} className="sheet-dlg" aria-label={props.bare ? props.label : undefined}>
          <div className="grabber" />
          <div className={`sheet-head ${props.bare ? 'bare-head' : ''}`} data-snapshot-hide>
            {!props.bare && (
              <Heading slot="title" level={3} className="ui-title">
                <span className="ui-title-text">{copyParts(props.title)}</span>
              </Heading>
            )}
            <div className="sheet-head-actions">
              {props.actions}
              <IconButton onClick={props.onClose} aria-label={t('ui.close')}>
                <Icon name="x" />
              </IconButton>
            </div>
          </div>
          <div className="sheet-body">{props.children}</div>
          {props.foot && <div className="sheet-foot sheet-actions">{copyParts(props.foot)}</div>}
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const toNum = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/**
 * 数字输入：自己保存正在输入的文字（「12.」「0.0」），只把解析出的数字往外报，小数点不会被吞。
 * 正在输入时不被外部值覆盖；没在输入时外部改了值（如切换周期重算）就显示新值，失焦时按当前值整理
 */
export function NumInput({
  value,
  onValue,
  ccy,
  ...rest
}: { value: number | undefined; onValue: (n: number | undefined) => void; ccy?: string } & Omit<JSX.IntrinsicElements['input'], 'value' | 'onChange'>) {
  const shown = (v: number | undefined) => (v == null ? '' : String(v));
  const [text, setText] = useState(shown(value));
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!Object.is(value, seen)) {
    setSeen(value);
    if (!focused && toNum(text) !== value) setText(shown(value));
  }
  return (
    <input
      inputMode={ccy && currencyDecimals(ccy) === 0 ? 'numeric' : 'decimal'}
      step={ccy ? 10 ** -currencyDecimals(ccy) : undefined}
      {...rest}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        if (toNum(text) !== value) setText(shown(value));
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        if (ccy && !acceptCurrencyInput(e.target.value, ccy)) return;
        setText(e.target.value);
        onValue(toNum(e.target.value));
      }}
    />
  );
}

/** 新输入的零小数金额拒绝小数；已有值与汇率计算结果不在这里改写。 */
export function acceptCurrencyInput(text: string, ccy: string): boolean {
  const n = toNum(text);
  if (currencyDecimals(ccy) === 0 && n != null && !Number.isInteger(n)) {
    notify.error(t('ui.error.wholeCurrency', { currency: ccy }));
    return false;
  }
  return true;
}

/** 保留字符串草稿语义的金额输入（空值、负号等由调用方校验）。 */
export function MoneyInput({ ccy, onChange, ...props }: { ccy: string } & JSX.IntrinsicElements['input']) {
  return (
    <input
      {...props}
      inputMode={currencyDecimals(ccy) === 0 ? 'numeric' : 'decimal'}
      step={10 ** -currencyDecimals(ccy)}
      onChange={(e) => {
        if (acceptCurrencyInput(e.target.value, ccy)) onChange?.(e);
      }}
    />
  );
}

/**
 * 确认弹窗：替代浏览器原生 confirm（全局禁止 alert / confirm / prompt）。
 * const ok = await ask('删除？')；取消、Esc、点遮罩都算否。由 AskLayer 统一渲染
 */
type AskReq = { message: ComponentChildren; ok?: string; resolve: (v: boolean) => void };
let askSet: ((r: AskReq | null) => void) | null = null;
export function ask(message: ComponentChildren, opts: { ok?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => (askSet ? askSet({ message, ...opts, resolve }) : resolve(false)));
}

export function AskLayer() {
  const [req, setReq] = useState<AskReq | null>(null);
  askSet = setReq;
  if (!req) return null;
  const done = (v: boolean) => {
    setReq(null);
    req.resolve(v);
  };
  return (
    <Sheet
      narrow
      title={t('common.confirmTitle')}
      onClose={() => done(false)}
      foot={
        <>
          <button className="btn" autoFocus onClick={() => done(false)}>
            {t('common.cancel')}
          </button>
          <button className="btn danger-solid" onClick={() => done(true)}>
            {req.ok ?? t('common.confirm')}
          </button>
        </>
      }
    >
      <p className="ask-msg">{req.message}</p>
    </Sheet>
  );
}

/** 全局提示（Sonner）：跟随亮色/暗色主题；手机上避开底部的安全区 */
export function Toasts() {
  const [theme, setTheme] = useState(() => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'));
  useEffect(() => {
    const el = document.documentElement;
    const mo = new MutationObserver(() => setTheme(el.dataset.theme === 'dark' ? 'dark' : 'light'));
    mo.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return (
    <Toaster
      theme={theme as 'light' | 'dark'}
      position="bottom-center"
      offset={24}
      mobileOffset={{ bottom: 'calc(16px + env(safe-area-inset-bottom))' }}
      gap={8}
      visibleToasts={4}
      toastOptions={{ className: 'ledger-toast' }}
    />
  );
}

/** 跟踪元素的实际宽度（ResizeObserver）：图表按它布局，未测量前为 0 */
/**
 * 国旗：用图片，不用 emoji（Windows 不显示国旗 emoji，只会变成两个字母）；没有对应图片时不显示
 */
export function FlagImg({ cc, className = '' }: { cc?: string; className?: string }) {
  const k = cc?.trim().toLowerCase();
  if (!k || !FLAGS.has(k)) return null;
  return <img className={`flag-img ${className}`} src={base(`/flags/${k}.png`)} alt="" loading="lazy" />;
}

/** 只提示需注意的状态；正常计费与已结清不显示胶囊。 */
export function StatusPill({ tone, children }: { tone: 'ok' | 'owe' | 'stop' | 'notice'; children: ComponentChildren }) {
  if (tone === 'ok') return null;
  return (
    <span className={`ph-status ${tone}`}>
      {tone === 'stop' ? <Icon name="ban" size={13} /> : <i />}
      {children}
    </span>
  );
}

/**
 * 卡片里的订阅名：悬停出现下划线，点它只打开订阅本身；卡片其余区域打开合租 / 代付自己的弹窗
 */
export function NameLink({ children, onClick }: { children: ComponentChildren; onClick: () => void }) {
  return (
    <span
      className="name-link text-ellipsis"
      role="link"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      {children}
    </span>
  );
}

export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  const watching = useRef<{ el: T | null; ro?: ResizeObserver }>({ el: null });
  // 被测的元素可能条件渲染（如日历年视图没有月网格）：每次渲染后对一下，元素出现才监听、换了就重挂、没了就停
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === watching.current.el) return;
    watching.current.ro?.disconnect();
    watching.current = { el };
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    watching.current.ro = ro;
  });
  useEffect(() => () => watching.current.ro?.disconnect(), []);
  return [ref, w] as const;
}

// ---------- 悬浮提示 ----------
type Tip = { x: number; top: number; bottom: number; html: ComponentChildren };
let tipSet: ((tip: Tip | null) => void) | undefined;

export function TipLayer() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const ref = useRef<HTMLDivElement>(null);
  tipSet = setTip;
  useLayoutEffect(() => {
    if (!tip || !ref.current) return;
    const box = ref.current.getBoundingClientRect();
    setPosition(tooltipPosition(tip, box, { width: window.innerWidth, height: window.innerHeight }));
  }, [tip]);
  useEffect(() => {
    const hide = () => setTip(null);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
      window.removeEventListener('keydown', key);
      tipSet = undefined;
    };
  }, []);
  return (
    tip &&
    createPortal(
      <div ref={ref} className="tip" role="tooltip" style={position}>
        {copyParts(tip.html)}
      </div>,
      document.body,
    )
  );
}

/** 悬浮提示里的明细表：名称左对齐、金额右对齐，标题行与明细同一套两列 */
export function TipTable({
  head,
  rows,
}: {
  head: [ComponentChildren, ComponentChildren];
  rows: Array<{ key: string; label: ComponentChildren; value: ComponentChildren }>;
}) {
  return (
    <div className="tip-table">
      <b>{head[0]}</b>
      <b className="num">{head[1]}</b>
      {rows.map((r) => (
        <Fragment key={r.key}>
          <span>{r.label}</span>
          <span className="num">{r.value}</span>
        </Fragment>
      ))}
    </div>
  );
}

export function tipProps(html: () => ComponentChildren) {
  const show = (e: { currentTarget: EventTarget }) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    tipSet?.({ x: r.left + r.width / 2, top: r.top, bottom: r.bottom, html: html() });
  };
  const hide = () => tipSet?.(null);
  return { onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide };
}

/** 标题内容和说明始终作为一个居中对齐的整体，操作区由 card-h 等容器承载。 */
export function CardTitle({
  as: Tag = 'h3',
  className = '',
  hint,
  children,
}: {
  as?: 'h2' | 'h3' | 'h4' | 'div' | 'span';
  className?: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <Tag className={`ui-title ${className}`}>
      <span className="ui-title-text">{copyParts(children)}</span>
      {hint && <Hint text={hint} />}
    </Tag>
  );
}

/** 所有圆形图标操作共用命中区域和状态；尺寸由 CSS 按视口统一。 */
export function IconButton({ className = '', type = 'button', ...props }: JSX.IntrinsicElements['button'] & { 'aria-label': string }) {
  return <button {...props} type={type} className={`icon-btn ${className}`} />;
}

/** 说明可悬停、键盘聚焦或点按；React Aria 负责 portal、翻转、视口边界和 Escape。 */
export function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipTrigger isOpen={open} onOpenChange={setOpen} shouldCloseOnPress={false} delay={150} closeDelay={100}>
      <AriaButton
        className="icon-btn hint"
        aria-label={text}
        onHoverStart={() => setOpen(true)}
        onHoverEnd={() => setOpen(false)}
        onPress={() => setOpen(true)}
      >
        <Icon name="info" />
      </AriaButton>
      <Tooltip className="info-tip" placement="top" offset={8} containerPadding={8}>
        {copyParts(text)}
      </Tooltip>
    </TooltipTrigger>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <AriaSwitch className="toggle" isSelected={checked} onChange={onChange} aria-label={label}>
      <i />
    </AriaSwitch>
  );
}

/** iOS 分组列表 */
export function Group({
  title,
  foot,
  children,
  submit,
}: {
  title?: ComponentChildren;
  foot?: ComponentChildren;
  children: ComponentChildren;
  submit?: string;
}) {
  return (
    <section className="group" data-submit={submit}>
      {title && <div className="group-title">{copyParts(title)}</div>}
      <div className="group-body">{children}</div>
      {foot && <div className="group-foot">{copyParts(foot)}</div>}
    </section>
  );
}

export function Cell({
  label,
  children,
  onClick,
  sub,
}: {
  label: ComponentChildren;
  children?: ComponentChildren;
  onClick?: () => void;
  sub?: ComponentChildren;
}) {
  const inner = (
    <>
      <span className="cell-l">
        {copyParts(label)}
        {sub && <small>{copyParts(sub)}</small>}
      </span>
      <span className="cell-r">{copyParts(children)}</span>
    </>
  );
  return onClick ? (
    <button className="cell tap" onClick={onClick}>
      {inner}
      <Icon name="right" />
    </button>
  ) : (
    <div className="cell">{inner}</div>
  );
}

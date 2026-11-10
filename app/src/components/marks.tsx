import { isDataIcon, isImageIcon } from '../../../shared/icon.ts';
import './ui.css';
import { base } from '../base.ts';
import type { ReactNode as ComponentChildren } from 'react';
import { useState } from 'react';
import { FLAGS } from '../display.ts';
import type { CardNetwork, PaymentMethod, Subscription } from '../../../shared/types.ts';
import { bankOf, BRANDS, brandOf, catColor, catIcon, faviconOf, isDomainCat, KIND_BG, paletteColor, methodLogo, methodRegion, NETWORKS } from '../derive.ts';
import { CatGlyph } from './CatGlyph.tsx';
import { t } from '../../../shared/i18n.ts';
import { Icon } from './icons.tsx';
import { regionLabel } from '../region.ts';

// ---------- 订阅图标：emoji > 图片 URL > 站点图标 > 渐变首字母 ----------
export const failed = new Set<string>();

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
  // 不是链接、站内图片路径（/ai/claude.svg）或内嵌图片的，当 emoji 显示
  if (icon && !isImageIcon(icon)) {
    return (
      <span className="ico emoji" style={style}>
        {icon}
      </span>
    );
  }
  // 依次尝试：填写的图标 → 官网图标；都加载失败才用首字母
  const viaProxy = (u: string) => (isDataIcon(u) ? u : proxied && /^https?:/.test(u) ? base(`/api/img?u=${encodeURIComponent(u)}`) : base(u));
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

/** 分类胶囊：中性底 + 分类色图标 + 名称 */
export function CatChip({ cat }: { cat: string }) {
  return (
    <span className="cat-chip" style={{ '--tint-text': catColor(cat, 11) } as Record<string, string>}>
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
export function markBg(m: PaymentMethod, logo: string | undefined, onColor: boolean | undefined): string {
  if (onColor) return KIND_BG[m.kind] ?? KIND_BG.other;
  if (logo) return m.color && m.logo ? paletteColor(m.color) : 'var(--white-a12)';
  return paletteColor(m.color, KIND_BG[m.kind] || KIND_BG.other);
}

/** 卡组织标：Visa、Mastercard、银联… */
export function NetworkMark({ network, height = 20 }: { network?: CardNetwork; height?: number }) {
  if (!network) return null;
  return <img className="net-mark" src={base(`/networks/${network}.svg`)} alt={NETWORKS[network]} title={NETWORKS[network]} style={{ height }} />;
}

/**
 * 国旗：用图片，不用 emoji（Windows 不显示国旗 emoji，只会变成两个字母）；没有对应图片时不显示
 */
export function FlagImg({ cc, className = '' }: { cc?: string; className?: string }) {
  const k = cc?.trim().toLowerCase();
  if (!k || !FLAGS.has(k)) return null;
  return <img className={`flag-img ${className}`} src={base(`/flags/${k}.png`)} alt="" loading="lazy" />;
}

/** 只提示需注意的状态；正常计费与已结清不显示胶囊。 */
export function StatusPill({ tone, children }: { tone: 'ok' | 'owe' | 'stop' | 'notice' | 'done'; children: ComponentChildren }) {
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

// 地区名与订阅地区推断：应用和公开页共用（不带样式依赖）
import { intlLocale } from '../../shared/i18n.ts';
import type { PaymentMethod } from '../../shared/types.ts';
import { methodRegion } from './derive.ts';

/** 地区名跟随当前语言 */
export const regionNameCache = new Map<string, Intl.DisplayNames | undefined>();

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

/** 登录设备的位置（Worker 存「城市, 国家代码」）：有国旗的国家换成本地化国名，其余原样显示 */
export function deviceLocation(location: string, hasFlag: (cc: string) => boolean): { cc?: string; text: string } {
  const parts = location
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts.at(-1) ?? '';
  if (/^[A-Za-z]{2}$/.test(last) && hasFlag(last.toLowerCase())) {
    const cc = last.toLowerCase();
    return { cc, text: [regionLabel(cc), ...parts.slice(0, -1)].join(' · ') };
  }
  return { text: parts.join(', ') };
}

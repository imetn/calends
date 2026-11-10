import { base } from './base.ts';
import { CURRENCIES } from '../../shared/format.ts';
import type { AppState } from '../../shared/types.ts';
// 金额显示偏好：列表里显示原币，还是折算成本位币。只存在本机，侧边栏与列表共用
import { usePref, writePref } from './prefs.ts';

/**
 * 不放进货币列表的代码：特别提款权、智利记账单位这类不是真正流通的货币；离岸人民币与人民币重复；
 * 泽西、马恩岛、根西、法罗、基里巴斯、图瓦卢的本地币与英镑 / 丹麦克朗 / 澳元等值挂钩，没有单独的 ISO 代码；
 * 克罗地亚库纳、旧利昂、旧津巴布韦元已经停用。
 */
export const HIDDEN_CCY = new Set(['XDR', 'CLF', 'CNH', 'JEP', 'IMP', 'GGP', 'FOK', 'KID', 'TVD', 'HRK', 'SLL', 'ZWL']);

export { ccyName } from '../../shared/format.ts';

/** 货币下拉的候选：汇率接口里的全部货币（去掉上面这些），按代码排序；汇率表还没取到时退回常用列表 */
export function allCurrencies(rates: Record<string, number> | undefined): string[] {
  const codes = Object.keys(rates ?? {}).filter((c) => !HIDDEN_CCY.has(c));
  return (codes.length ? codes : CURRENCIES).slice().sort();
}

/** 常用货币：美元、人民币，再加订阅里实际用到的币种（含各个分段），按出现次数排 */
export function usedCurrencies(state: Pick<AppState, 'subscriptions'>): string[] {
  const count = new Map<string, number>();
  for (const s of state.subscriptions) for (const c of new Set([s.currency, ...(s.phases ?? []).map((p) => p.currency)])) count.set(c, (count.get(c) ?? 0) + 1);
  return [...new Set(['USD', 'CNY', ...[...count].sort((a, b) => b[1] - a[1]).map(([c]) => c)])];
}

export function setOrig(orig: boolean) {
  writePref('list-ccy', orig ? 'orig' : 'base');
}

/** 列表是否显示原币（多台设备同步） */
export function useOrig(): boolean {
  const [v] = usePref<'orig' | 'base'>('list-ccy', 'orig', (x): x is 'orig' | 'base' => x === 'orig' || x === 'base');
  return v !== 'base';
}

/** public/flags 里有的国旗（来自 flagpedia，公有领域），避免请求不存在的图片 */
export const FLAGS = new Set(
  'ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et eu fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws xk ye yt za zm zw'.split(
    ' ',
  ),
);
/** 跨国货币直接对应的旗帜；X 开头的超国家货币、贵金属没有旗帜 */
const CCY_FLAG: Record<string, string> = { EUR: 'eu', ANG: 'cw', XCG: 'cw', XCD: 'ag', XAF: 'cm', XOF: 'sn', XPF: 'pf' };

/** 货币对应的国旗图片地址：一般取代码前两位作国家码 */
export function ccyFlag(code: string): string | undefined {
  const cc = CCY_FLAG[code] ?? (code.startsWith('X') ? '' : code.slice(0, 2).toLowerCase());
  return cc && FLAGS.has(cc) ? base(`/flags/${cc}.png`) : undefined;
}

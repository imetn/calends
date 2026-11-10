import { useMemo, useState } from 'react';
import { OTHER, flowLevels, netByItem, shareProfile } from '../../../shared/chart-data.ts';
import { paymentMethodGroups } from '../../../shared/payment-groups.ts';
import { flow } from '../../../shared/format.ts';
import { sumTotals, totalNote } from '../../../shared/fx-total.ts';
import { t } from '../../../shared/i18n.ts';
import type { SpendPiece } from '../../../shared/scope-report.ts';
import type { AppState } from '../../../shared/types.ts';
import { methodTint, tint } from '../derive.ts';
import { CardTitle } from './ui.tsx';
import { CopyImageButton } from './CopyImageButton.tsx';
import { useWidth } from './inputs.tsx';
import { tipProps } from './overlays.tsx';

/** 并进的小项写「其他」；没填分类的订阅写「未分类」 */
const otherLabel = (k: string, label: string) => (k === OTHER ? t('common.other') : label || t('scope.uncategorized'));

/** 标签之间至少隔 gap，整体不超出 [lo, hi]；先往下推，再从底部往上推 */
function spread(ys: number[], gap: number, lo: number, hi: number) {
  const out = [...ys];
  for (let i = 0; i < out.length; i++) out[i] = Math.max(out[i], i ? out[i - 1] + gap : lo);
  for (let i = out.length - 1; i >= 0; i--) out[i] = Math.min(out[i], i < out.length - 1 ? out[i + 1] - gap : hi);
  return out;
}

/**
 * 钱从哪张卡、经哪个分类、流到哪个订阅：三层桑基。第一层按支付方式着色，后两层灰色；
 * 宽屏横排（左到右），窄屏竖排（上到下），标签在节点条下方，可以压在带子上。
 */
export function FlowCard({ state, pieces }: { state: AppState; pieces: SpendPiece[] }) {
  const base = state.settings.baseCurrency;
  const [box, W] = useWidth();
  const [hovered, setHover] = useState<{ lv: number; key: string } | null>(null);
  const g = useMemo(() => {
    const groups = paymentMethodGroups(
      state.methods,
      pieces.map((p) => ({ methodId: p.methodId || undefined, value: p.amount, item: p })),
      t('report.comp.unassigned'),
    );
    const names = new Map(groups.map((x) => [x.id, x.name]));
    const rows = netByItem(pieces.map((p) => ({ id: p.sub.id, from: p.methodId || '', to: p.sub.category, value: p.amount, sub: p.sub })));
    return flowLevels(
      rows.map((x) => ({ path: [x.from, x.to, x.id], labels: [names.get(x.from) ?? '', x.to, x.sub.name], value: x.value })),
      [5, 6, 8],
    );
  }, [state.methods, pieces]);
  // 缺汇率的部分没算进去：和构成卡一样在标题提示里说明
  const note = useMemo(() => totalNote(sumTotals(pieces.map((p) => p.partial))), [pieces]);
  // 换年份后原来悬停的节点可能已不在，不在就当没悬停
  const hover = hovered && g.levels[hovered.lv]?.some((x) => x.key === hovered.key) ? hovered : null;
  const litPaths = useMemo(() => (hover ? g.paths.filter((p) => p.path[hover.lv] === hover.key) : null), [g, hover]);
  // 只有一张卡或一个分类时，构成卡已经说清楚了
  if (g.levels[0].length < 2 && g.levels[1].length < 2) return null;

  const vertical = W > 0 && W < 560;
  const bar = 8;
  const gap = vertical ? 4 : 8;
  const most = Math.max(...g.levels.map((l) => l.length));
  // 主轴：节点排开的方向；横排是高度，竖排是宽度
  const main = vertical ? W : Math.max(320, most * 34);
  const labelW = Math.round(Math.min(150, Math.max(84, W * 0.18)));
  const H = vertical ? 400 : main;
  const cross = vertical ? [0, 168, 336] : [labelW, Math.round((labelW + W - labelW - bar) / 2), W - labelW - bar];
  const k = Math.min(...g.levels.map((l) => (main - gap * (l.length - 1)) / g.total));
  const at = g.levels.map((nodes) => {
    let o = (main - (g.total * k + gap * (nodes.length - 1))) / 2;
    return new Map(
      nodes.map((nd) => {
        const p = { o, len: nd.value * k };
        o += p.len + gap;
        return [nd.key, p];
      }),
    );
  });
  // 带子在节点两端按另一端的顺序叠，交叉最少
  const idx = g.levels.map((nodes) => new Map(nodes.map((x, i) => [x.key, i])));
  const ribbons = g.links.map((l) => ({ ...l, w: l.value * k, s: 0, d: 0 }));
  const out = new Map<string, number>();
  const into = new Map<string, number>();
  for (const r of [...ribbons].sort(
    (a, b) => a.level - b.level || idx[a.level].get(a.from)! - idx[a.level].get(b.from)! || idx[a.level + 1].get(a.to)! - idx[a.level + 1].get(b.to)!,
  )) {
    const key = `${r.level}\u0001${r.from}`;
    const o = out.get(key) ?? 0;
    r.s = at[r.level].get(r.from)!.o + o;
    out.set(key, o + r.w);
  }
  for (const r of [...ribbons].sort(
    (a, b) => a.level - b.level || idx[a.level + 1].get(a.to)! - idx[a.level + 1].get(b.to)! || idx[a.level].get(a.from)! - idx[a.level].get(b.from)!,
  )) {
    const key = `${r.level}\u0001${r.to}`;
    const o = into.get(key) ?? 0;
    r.d = at[r.level + 1].get(r.to)!.o + o;
    into.set(key, o + r.w);
  }
  const label = (lv: number, nd: { key: string; label: string }) =>
    nd.key.startsWith(OTHER) ? t('common.other') : lv === 1 ? nd.label || t('scope.uncategorized') : nd.label;
  const methodIdx = new Map(g.levels[0].map((x, i) => [x.key, i]));
  // 未指定支付方式和「其他」不算一张卡，用灰色，与构成卡一致
  const methodColor = (key: string) =>
    key === OTHER || !key
      ? 'var(--gray-9)'
      : methodTint(
          state.methods.find((m) => m.id === key),
          methodIdx.get(key)!,
        );
  const lit = (r: { level: number; from: string; to: string }) => !litPaths || litPaths.some((p) => p.path[r.level] === r.from && p.path[r.level + 1] === r.to);
  const path = (r: (typeof ribbons)[number]) => {
    const a = cross[r.level] + bar;
    const b = cross[r.level + 1];
    const m = (a + b) / 2;
    const P = (c: number, o: number) => (vertical ? `${o},${c}` : `${c},${o}`);
    return `M${P(a, r.s)}C${P(m, r.s)} ${P(m, r.d)} ${P(b, r.d)}L${P(b, r.d + r.w)}C${P(m, r.d + r.w)} ${P(m, r.s + r.w)} ${P(a, r.s + r.w)}Z`;
  };
  const pct = (v: number) => `${Math.round((v / g.total) * 100)}%`;
  const nodeProps = (lv: number, key: string, name: string, v: number) => {
    const tip = tipProps(() => `${name}\n${flow(-v, base)}\n${pct(v)}`);
    return {
      ...tip,
      onMouseEnter: (e: { currentTarget: EventTarget }) => {
        setHover({ lv, key });
        tip.onMouseEnter(e);
      },
      onMouseLeave: () => {
        setHover(null);
        tip.onMouseLeave();
      },
    };
  };
  // 横排：同一列标签之间至少隔两行字；竖排：标签在节点条下方居中，放不下名字的小节点只留悬停提示
  const labels = (lv: number) => {
    const nodes = g.levels[lv];
    const mids = nodes.map((nd) => at[lv].get(nd.key)!.o + at[lv].get(nd.key)!.len / 2);
    const ys = vertical ? mids : spread(mids, 32, 16, H - 16);
    return nodes.map((nd, i) => ({ nd, c: ys[i], len: at[lv].get(nd.key)!.len }));
  };
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={note || undefined}>
          {t('report.flow.title')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <div
        className={`flow-chart${vertical ? ' v' : ''}`}
        ref={box}
        style={{ height: H }}
        role="img"
        aria-label={g.links
          .map((r) => {
            const from = g.levels[r.level].find((x) => x.key === r.from)!;
            const to = g.levels[r.level + 1].find((x) => x.key === r.to)!;
            return `${label(r.level, from)} → ${label(r.level + 1, to)} ${flow(-r.value, base)}`;
          })
          .join(', ')}
      >
        {W > 0 && (
          <>
            <svg width={W} height={H} aria-hidden="true">
              {ribbons.map((r) => {
                const from = g.levels[r.level].find((x) => x.key === r.from)!;
                const to = g.levels[r.level + 1].find((x) => x.key === r.to)!;
                const on = lit(r);
                return (
                  <path
                    key={`${r.level}\u0001${r.from}\u0001${r.to}`}
                    d={path(r)}
                    style={{
                      fill: r.level === 0 ? tint(methodColor(r.from), 7) : 'var(--gray-6)',
                      fillOpacity: on ? (hover ? 0.85 : 0.55) : 0.15,
                    }}
                    {...tipProps(() => `${label(r.level, from)} → ${label(r.level + 1, to)}\n${flow(-r.value, base)}`)}
                  />
                );
              })}
              {g.levels.map((nodes, lv) =>
                nodes.map((nd) => {
                  const p = at[lv].get(nd.key)!;
                  const len = Math.max(p.len, 1);
                  return (
                    <rect
                      key={`${lv}\u0001${nd.key}`}
                      x={vertical ? p.o : cross[lv]}
                      y={vertical ? cross[lv] : p.o}
                      width={vertical ? len : bar}
                      height={vertical ? bar : len}
                      rx={2}
                      style={{ fill: lv === 0 ? methodColor(nd.key) : 'var(--gray-9)' }}
                      {...nodeProps(lv, nd.key, label(lv, nd), nd.value)}
                    />
                  );
                }),
              )}
            </svg>
            {g.levels.map((_, lv) =>
              labels(lv).map(({ nd, c, len }) => {
                const name = label(lv, nd);
                if (vertical && len < 40) return null;
                const style = vertical
                  ? { left: c, top: cross[lv] + bar + 4, width: Math.min(len + gap, 120) }
                  : lv === 0
                    ? { top: c, width: labelW - 8 }
                    : { top: c, left: cross[lv] + bar + 8, width: labelW - 8 };
                return (
                  <div
                    key={`${lv}\u0001${nd.key}`}
                    className={`flow-label ${vertical ? 'v' : lv === 0 ? 'l' : lv === 1 ? 'm' : 'r'}`}
                    style={style}
                    {...nodeProps(lv, nd.key, name, nd.value)}
                  >
                    <span className="flow-name">{name}</span>
                    <span className="num">{flow(-nd.value, base, { compact: true })}</span>
                  </div>
                );
              }),
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** 支出结构两期对比：各分类占该期合计的比例，本期实线、上期虚线；两期总额不同也能比结构 */
export function ProfileCard({ pieces, prev, names }: { pieces: SpendPiece[]; prev: SpendPiece[]; names: [string, string] }) {
  const [now, before] = names;
  const [box, W] = useWidth();
  const axes = useMemo(() => {
    const cats = (xs: SpendPiece[]) =>
      netByItem(xs.map((p) => ({ id: p.sub.id, from: '', to: p.sub.category, value: p.amount }))).map((x) => ({ key: x.to, value: x.value }));
    return shareProfile(cats(pieces), cats(prev));
  }, [pieces, prev]);
  // 两期合在一张图里，不写具体未换算金额（写了会像是今年的），只说结果不完整
  const note = useMemo(() => ([...pieces, ...prev].some((p) => p.partial.incomplete) ? t('core.fxIncomplete') : ''), [pieces, prev]);
  if (!axes.length) return null;

  const S = Math.min(W, 380);
  // 左右标签锚在 R + 14 处向外伸：留够标签宽度才不会伸出卡片；窄屏标签收窄
  const labelMax = S < 360 ? 64 : 84;
  const pad = 14 + labelMax;
  const R = Math.max(40, S / 2 - pad);
  const c = S / 2;
  const peak = Math.max(...axes.flatMap((x) => [x.a, x.b]));
  const top = Math.min(1, Math.ceil(peak * 10) / 10);
  const angle = (i: number) => -Math.PI / 2 + (i / axes.length) * Math.PI * 2;
  const pt = (i: number, v: number) => {
    const r = (v / top) * R;
    return [c + Math.cos(angle(i)) * r, c + Math.sin(angle(i)) * r] as const;
  };
  const poly = (f: (x: (typeof axes)[number]) => number) => axes.map((x, i) => pt(i, f(x)).join(',')).join(' ');
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <div className="card copy-card" data-copy-card>
      <div className="card-h">
        <CardTitle as="h3" hint={note || undefined}>
          {t('report.profile.title')}
        </CardTitle>
        <div className="copy-tools">
          <CopyImageButton hover />
        </div>
      </div>
      <div className="profile-chart" ref={box}>
        {W > 0 && (
          <div
            className="profile-plot"
            style={{ width: S, height: S }}
            role="img"
            aria-label={axes.map((x) => `${otherLabel(x.key, x.key)} ${now} ${pct(x.a)} ${before} ${pct(x.b)}`).join(', ')}
          >
            <svg width={S} height={S} aria-hidden="true">
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <polygon key={f} points={axes.map((_, i) => pt(i, top * f).join(',')).join(' ')} className="profile-ring" />
              ))}
              {axes.map((_, i) => {
                const [x, y] = pt(i, top);
                return <line key={i} x1={c} y1={c} x2={x} y2={y} className="profile-ring" />;
              })}
              <polygon points={poly((x) => x.b)} className="profile-prev" />
              <polygon points={poly((x) => x.a)} className="profile-now" />
              {axes.map((x, i) => {
                const [px, py] = pt(i, x.a);
                return <circle key={x.key} cx={px} cy={py} r={2.5} className="profile-dot" />;
              })}
            </svg>
            {axes.map((x, i) => {
              const r = R + 14;
              const cos = Math.cos(angle(i));
              const sin = Math.sin(angle(i));
              const name = otherLabel(x.key, x.key);
              return (
                <div
                  key={x.key}
                  className="profile-label"
                  style={{
                    left: c + cos * r,
                    top: c + sin * r,
                    transform: `translate(${cos > 0.3 ? '0' : cos < -0.3 ? '-100%' : '-50%'}, ${sin > 0.3 ? '0' : sin < -0.3 ? '-100%' : '-50%'})`,
                    textAlign: cos > 0.3 ? 'left' : cos < -0.3 ? 'right' : 'center',
                    maxWidth: labelMax,
                  }}
                  {...tipProps(() => `${name}\n${now}  ${pct(x.a)}\n${before}  ${pct(x.b)}`)}
                >
                  <b>{name}</b>
                  <span className="num">{pct(x.a)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className="legend-inline profile-legend">
        <span>
          <svg className="profile-key" width={14} height={2} aria-hidden="true">
            <line x1={0} x2={14} y1={1} y2={1} className="profile-now" />
          </svg>
          {now}
        </span>
        <span>
          <svg className="profile-key" width={14} height={2} aria-hidden="true">
            <line x1={0} x2={14} y1={1} y2={1} className="profile-prev" />
          </svg>
          {before}
        </span>
      </div>
    </div>
  );
}

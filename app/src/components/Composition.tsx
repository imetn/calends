import { useSnapshotRender } from '../snapshot-render.tsx';
import { useRef, useState } from 'react';
import { sumTotals, totalNote } from '../../../shared/fx-total.ts';
import { currentPhase, cycleDays } from '../../../shared/billing.ts';
import { paymentMethodGroups } from '../../../shared/payment-groups.ts';
import { mrrTotal, contributionOn } from '../../../shared/metrics.ts';
import { flow } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { SpendPiece } from '../../../shared/scope-report.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { CardTitle } from './ui.tsx';
import { CopyImageButton } from './CopyImageButton.tsx';
import { copyParts } from './copy.tsx';
import { CatIcon, SubIcon } from './marks.tsx';
import { Seg, useWidth } from './inputs.tsx';
import { squarify } from './charts.tsx';
import { tipProps } from './overlays.tsx';
import { catColor, paletteColor, KIND_BG } from '../derive.ts';
const perMonth = (amount: string) => t('report.perMonth', { amount });
type Dim = 'cat' | 'pay' | 'ccy' | 'cycle';

type Item = { s: Subscription; v: number; method: string; ccy: string };

/** 构成：树状图，面积 = 每月成本；传入 pieces 时面积 = 累计实付，支付方式、币种按每笔扣款归属 */
export function Composition({
  state,
  today,
  onOpen,
  pieces,
  hint,
  snapshotSelection,
}: {
  state: AppState;
  today: string;
  onOpen: (s: Subscription) => void;
  pieces?: SpendPiece[];
  /** 口径说明；缺汇率时后面再接一行提示 */
  hint?: string;
  snapshotSelection?: { dim: Dim; focus: string | null };
}) {
  const base = state.settings.baseCurrency;
  const [dim, setDim] = useState<Dim>(snapshotSelection?.dim ?? 'cat');
  const [focus, setFocus] = useState<string | null>(snapshotSelection?.focus ?? null);
  const [box, W] = useWidth();
  const captureRef = useRef<HTMLDivElement>(null);
  useSnapshotRender(captureRef, () => (
    <Composition state={state} today={today} onOpen={onOpen} pieces={pieces} hint={hint} snapshotSelection={{ dim, focus }} />
  ));
  const H = W < 560 ? 320 : 400;
  const fmt = pieces ? (amount: string) => amount : perMonth;
  const items: Item[] = pieces
    ? pieces.map((p) => ({ s: p.sub, v: p.amount, method: p.methodId, ccy: p.currency }))
    : state.subscriptions
        .map((s) => ({ s, v: contributionOn(state, s, today), method: currentPhase(s, today).methodId ?? '', ccy: s.currency }))
        .filter((x) => x.v > 0);
  const partial = pieces ? sumTotals(pieces.map((p) => p.partial)) : mrrTotal(state, today);
  const keyOf = (x: Item) => {
    if (dim === 'cat') return x.s.category;
    if (dim === 'pay') return x.method;
    if (dim === 'ccy') return x.ccy;
    const days = cycleDays(x.s.cycle);
    return days >= 300 ? t('report.comp.yearly') : days >= 80 ? t('report.comp.quarterly') : t('report.comp.monthly');
  };
  // 同一组里同一订阅（累计时可能分几笔、几种币）合成一块；净额不为正的不画
  const merge = (xs: Item[]) => {
    const m = new Map<string, Item>();
    for (const x of xs) {
      const e = m.get(x.s.id);
      m.set(x.s.id, e ? { ...e, v: e.v + x.v } : x);
    }
    return [...m.values()].filter((x) => x.v > 0.005).sort((a, b) => b.v - a.v);
  };
  const groups = new Map<string, Item[]>();
  for (const x of items) {
    const k = keyOf(x);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const entries = (
    dim === 'pay'
      ? paymentMethodGroups(
          state.methods,
          items.map((x) => ({ methodId: x.method || undefined, value: x.v, item: x })),
          t('report.comp.unassigned'),
        ).map((g) => ({ k: g.id, name: g.name, xs: g.items }))
      : [...groups.entries()].map(([k, xs]) => ({ k, name: k, xs }))
  )
    .map((e) => {
      const xs = merge(e.xs);
      return { ...e, xs, v: xs.reduce((a, x) => a + x.v, 0) };
    })
    .filter((e) => e.xs.length)
    .sort((a, b) => b.v - a.v);
  const total = entries.reduce((a, e) => a + e.v, 0);
  const color = (k: string, i: number) => {
    if (dim === 'cat') return catColor(k);
    if (dim === 'pay') {
      const m = state.methods.find((x) => x.id === k);
      return m ? paletteColor(m.color, KIND_BG[m.kind]) : 'var(--c9)';
    }
    return `var(--c${(i % 10) + 1})`;
  };
  const sel = focus ? entries.find((e) => e.k === focus) : undefined;
  const rects = squarify(entries.map((e) => e.v));
  /** 每个订阅一块，图标按块的大小放大，空间够再写名称和金额 */
  const tiles = (xs: Item[], b: { x: number; y: number; w: number; h: number }, bg: (cat: string) => string, onPick?: () => void) =>
    squarify(
      xs.map((x) => x.v),
      b.x,
      b.y,
      b.w,
      b.h,
    ).map((r) => {
      const x = xs[r.i];
      const side = Math.min(r.w, r.h);
      const label = r.w > 76 && r.h > 70;
      const ico = Math.floor(Math.min(96, side * (label ? 0.4 : 0.6)));
      return (
        <button
          key={x.s.id}
          data-snapshot-keep
          className={`tm-cell ${side > 200 ? 'lg' : ''}`}
          style={{ left: r.x, top: r.y, width: r.w, height: r.h, background: bg(x.s.category) }}
          onClick={() => (onPick ? onPick() : onOpen(x.s))}
          {...tipProps(() => `${x.s.name}\n${fmt(flow(-x.v, base))}`)}
        >
          {ico >= 12 && <SubIcon sub={x.s} size={ico} />}
          {label && <b>{x.s.name}</b>}
          {label && r.h > ico + 52 && <span>{flow(-x.v, base, { compact: true })}</span>}
        </button>
      );
    });
  return (
    <div className="card copy-card" data-copy-card ref={captureRef}>
      <div className="card-h">
        <CardTitle hint={[hint, totalNote(partial)].filter(Boolean).join('\n') || undefined}>
          {copyParts(sel ? `${sel.name}\n${fmt(flow(-sel.v, base, { compact: true }))}` : t('report.comp.title'))}
        </CardTitle>
        <div className="copy-controls">
          <CopyImageButton hover />
          {sel ? (
            <button className="btn plain" onClick={() => setFocus(null)}>
              {t('report.comp.back')}
            </button>
          ) : (
            <Seg
              small
              value={dim}
              onChange={(v) => {
                setDim(v);
                setFocus(null);
              }}
              options={[
                ['cat', t('report.comp.cat')],
                ['pay', t('report.comp.pay')],
                ['ccy', t('report.comp.ccy')],
                ['cycle', t('report.comp.cycle')],
              ]}
            />
          )}
        </div>
      </div>
      <div className="treemap" ref={box} style={{ height: H }}>
        {W > 0 &&
          (sel
            ? tiles(sel.xs, { x: 0, y: 0, w: W, h: H }, catColor)
            : rects.map((r) => {
                const e = entries[r.i];
                const g = { x: (r.x / 100) * W, y: (r.y / 100) * H, w: (r.w / 100) * W, h: (r.h / 100) * H };
                // 分组：顶上一条标题，下面按订阅再分小块
                const head = g.w > 70 && g.h > 64 ? 22 : 0;
                const bg = color(e.k, r.i);
                return (
                  <div key={e.k} className="tm-group" style={{ left: g.x, top: g.y, width: g.w, height: g.h, background: bg }}>
                    {head > 0 && (
                      <button
                        className="tm-head"
                        data-snapshot-keep
                        onClick={() => setFocus(e.k)}
                        {...tipProps(() =>
                          t(pieces ? 'report.comp.groupTipAll' : 'report.comp.groupTip', { name: e.name, count: e.xs.length, amount: flow(-e.v, base) }),
                        )}
                      >
                        <b className="icon-text">
                          {dim === 'cat' && <CatIcon cat={e.k} size={11} />}
                          <span>{e.name}</span>
                        </b>
                        {g.w > 150 && (
                          <span>
                            {!partial.incomplete && (
                              <>
                                {Math.round((e.v / total) * 100)}% <span className="copy-gap" aria-hidden="true" />
                              </>
                            )}{' '}
                            {flow(-e.v, base, { compact: true })}
                          </span>
                        )}
                      </button>
                    )}
                    {tiles(e.xs, { x: 0, y: head, w: g.w, h: g.h - head }, () => bg, head ? undefined : () => setFocus(e.k))}
                  </div>
                );
              }))}
      </div>
    </div>
  );
}

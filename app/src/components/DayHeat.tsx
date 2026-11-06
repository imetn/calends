import { Fragment, type CSSProperties, useEffect, useMemo, useRef, useState } from 'react';
import type { DayCash } from '../../../shared/scope-report.ts';
import { formatTotal } from '../../../shared/fx-total.ts';
import { cnDate, monthLabel, weekdayShort } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { useSnapshotRender } from '../snapshot-render.tsx';
import { useWidth } from './inputs.tsx';
import { tipProps } from './overlays.tsx';
import './day-heat.css';

export type DayHeatMode = 'flat' | 'bars';

type Pt = [number, number];
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
// 格子之间留缝：边长的 18%
const GAP = 0.09;

/**
 * 一年逐日的净支出：平面是 GitHub 式热力格，立体是同一张格子立起来的等轴测柱。
 * 两种视图共用一套「周 × 星期」坐标，切换时投影和柱高一起过渡；颜色四档按有支出的日子分位，柱高按金额开方，
 * 让大额年付不把月付压成看不见。今天之后的预计：平面在色块上叠斜纹，立体时柱子变成半透明、斜纹换成墨色保留；净流入（退款、转让）和缺汇率的日子各有标记，不当作没花钱。
 */
export function DayHeat(props: { days: DayCash[]; base: string; today: string; weekStart: 0 | 1; mode: DayHeatMode }) {
  const { days, base, today, weekStart, mode } = props;
  const [box, width] = useWidth();
  useSnapshotRender(box, () => <DayHeat {...props} />);
  const k = useMorph(mode === 'bars' ? 1 : 0);
  const stripe = `dh-stripe-${days[0]?.date.slice(0, 4)}`;

  const { cells, cols, levelOf, max } = useMemo(() => {
    const lead = days.length ? (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 7 - weekStart) % 7 : 0;
    const cells = days.map((d, i) => ({ d, col: Math.floor((i + lead) / 7), row: (i + lead) % 7 }));
    const pos = days
      .map((d) => d.total)
      .filter((v) => v > 0.005)
      .sort((a, b) => a - b);
    const q = [0.25, 0.5, 0.75].map((p) => pos[Math.min(pos.length - 1, Math.floor(p * pos.length))] ?? 0);
    const levelOf = (v: number) => (!(v > 0.005) ? 0 : v <= q[0] ? 1 : v <= q[1] ? 2 : v <= q[2] ? 3 : 4);
    return { cells, cols: Math.ceil((days.length + lead) / 7), levelOf, max: pos[pos.length - 1] ?? 0 };
  }, [days, weekStart]);

  // 平面：左边留星期标签，上面留月份；立体：周轴微微向右下，星期轴斜向左下，柱子朝上
  const W = Math.max(width, 1);
  const labelW = 26;
  const top = 20;
  const p = (W - labelW) / cols;
  const SU = [1, 0.16] as const;
  const SV = [-0.7, 0.4] as const;
  const a = W / (cols - 7 * SV[0] + 1.4);
  const hMax = Math.min(140, a * 7);
  const flatH = top + 7 * p;
  const isoH = hMax + 4 + cols * SU[1] * a + 7 * SV[1] * a + 24;
  const H = lerp(flatH, isoH, k);
  const ex: Pt = [lerp(p, SU[0] * a, k), lerp(0, SU[1] * a, k)];
  const ey: Pt = [lerp(0, SV[0] * a, k), lerp(p, SV[1] * a, k)];
  const o: Pt = [lerp(labelW, -7 * SV[0] * a + 1.2 * a, k), lerp(top, hMax + 4, k)];
  const rise = Math.max(0, (k - 0.25) / 0.75);
  const pt = (u: number, v: number, h = 0): Pt => [o[0] + u * ex[0] + v * ey[0], o[1] + u * ex[1] + v * ey[1] - h];
  const at = (u: number, v: number, h = 0) =>
    pt(u, v, h)
      .map((n) => n.toFixed(1))
      .join(',');

  // 月份标签：平面在每月第一列上方，立体沿前边；窄屏一格不到 11px 时隔月标注，与上方柱图一致。星期标签只在平面出现
  const every = lerp(p, a, k) < 11 ? 2 : 1;
  const months = cells.filter((c) => c.d.date.endsWith('-01') && (Number(c.d.date.slice(5, 7)) - 1) % every === 0);

  return (
    <div className="dh" ref={box}>
      {width > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('report.daily.title')} style={{ '--k': k } as CSSProperties}>
          <defs>
            <pattern id={stripe} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width={1.5} height={5} className="dh-stripe" />
            </pattern>
          </defs>
          {months.map((c) => {
            const iso = pt(c.col + 0.5, 7.6);
            return (
              <text
                key={c.d.date}
                className="dh-label"
                x={lerp(labelW + c.col * p, iso[0], k)}
                y={lerp(13, iso[1] + 12, k)}
                textAnchor={k > 0.5 ? 'middle' : 'start'}
              >
                {monthLabel(c.d.date.slice(0, 7), { year: false })}
              </text>
            );
          })}
          {k < 0.99 &&
            [1, 3, 5].map((r) => (
              <text key={r} className="dh-label" x={0} y={o[1] + (r + 0.5) * p} dy="0.35em" opacity={1 - k}>
                {weekdayShort((r + weekStart) % 7)}
              </text>
            ))}
          {cells.map(({ d, col, row }) => {
            const lv = levelOf(d.total);
            const pending = lv > 0 && d.pending > 0.005;
            const inflow = d.total < -0.005;
            const missing = d.partial.total.incomplete;
            const h = lv && max > 0 ? Math.sqrt(d.total / max) * hMax * ease(rise) : 0;
            const [u0, u1, v0, v1] = [col + GAP, col + 1 - GAP, row + GAP, row + 1 - GAP];
            const sides = [`${at(u0, v1)} ${at(u1, v1)} ${at(u1, v1, h)} ${at(u0, v1, h)}`, `${at(u1, v0)} ${at(u1, v1)} ${at(u1, v1, h)} ${at(u1, v0, h)}`];
            const face = `${at(u0, v0, h)} ${at(u1, v0, h)} ${at(u1, v1, h)} ${at(u0, v1, h)}`;
            const cls = ['dh-day', `dh-l${lv}`, pending && 'pending', inflow && 'inflow', missing && 'missing', d.date === today && 'today']
              .filter(Boolean)
              .join(' ');
            return (
              <g key={d.date} className={cls} {...(lv || inflow || missing ? tipProps(() => <DayTip d={d} base={base} />) : {})}>
                {h > 0.3 &&
                  sides.map((pts, i) => (
                    <Fragment key={i}>
                      <polygon className={`dh-s${i + 1}`} points={pts} />
                      {pending && <polygon className="dh-over" points={pts} style={{ fill: `url(#${stripe})` }} />}
                    </Fragment>
                  ))}
                <polygon className="dh-top" points={face} />
                {pending && <polygon className="dh-over" points={face} style={{ fill: `url(#${stripe})` }} />}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function DayTip({ d, base }: { d: DayCash; base: string }) {
  const top = d.subs.slice(0, 3);
  const more = d.subs.length - top.length;
  return (
    <>
      <b>{cnDate(d.date, true)}</b>
      <div>{formatTotal(d.partial.total, base, { direction: -1 })}</div>
      {d.pending > 0.005 && <div className="muted">{t('calendar.projected')}</div>}
      {top.map((s) => (
        <div key={s.id} className="muted">
          {s.name}
        </div>
      ))}
      {more > 0 && <div className="muted">+{more}</div>}
    </>
  );
}

/** 0 与 1 之间的过渡进度；减少动态效果时直接到位 */
function useMorph(target: 0 | 1) {
  const [k, setK] = useState<number>(target);
  // 当前进度只在动画帧里写，切换中途再切换时从这里接着走
  const cur = useRef<number>(target);
  useEffect(() => {
    const from = cur.current;
    const set = (v: number) => {
      cur.current = v;
      setK(v);
    };
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      set(target);
      return;
    }
    const t0 = performance.now();
    const span = 700 * Math.abs(target - from);
    let raf = 0;
    const step = (now: number) => {
      const r = span ? Math.min(1, (now - t0) / span) : 1;
      set(lerp(from, target, ease(r)));
      if (r < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return k;
}

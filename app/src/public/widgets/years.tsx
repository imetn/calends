import { useMemo } from 'react';
import { cycleLabel, diffDays, durationLabel, priceAt } from '../../../../shared/billing.ts';
import { cnDate, cnDateFull, money } from '../../../../shared/format.ts';
import { ganttTicks, yearsTimeline, type YearsBar, type YearsRow } from '../../../../shared/gantt.ts';
import { intlLocale, t } from '../../../../shared/i18n.ts';
import { syncCategories } from '../../derive.ts';
import { AppIcon } from '@/public/components/app-icon';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/public/components/ui/card';
import { clean, shade, Tip, TipBody, useWidth } from './lib.tsx';
import type { WidgetProps } from './props.ts';

const ROW = 28;
const BAR = 14;
/** 并行的阶段往下错开一条 */
const LANE = 18;

export function YearsCard({ state, today }: WidgetProps) {
  const timeline = useMemo(() => yearsTimeline(state.subscriptions, today), [state.subscriptions, today]);
  if (!timeline.rows.length) return null;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.years.title')}</CardTitle>
        <CardDescription>{t('public.years.desc')}</CardDescription>
      </CardHeader>
      <CardContent>
        <Chart timeline={timeline} categories={syncCategories(state).map((c) => c.name)} today={today} />
      </CardContent>
    </Card>
  );
}

function Chart({ timeline, categories, today }: { timeline: ReturnType<typeof yearsTimeline>; categories: string[]; today: string }) {
  const { rows, start, end, ongoing } = timeline;
  const [track, width] = useWidth<HTMLDivElement>();
  const days = Math.max(1, diffDays(start, end));
  const pct = (d: string) => `${Math.min(100, Math.max(0, (diffDays(start, d) / days) * 100))}%`;
  const ticks = ganttTicks('all', start, end, width, intlLocale());
  const used = categories.filter((c) => rows.some((r) => r.s.category === c));
  const colorOf = (category: string) => shade(used.indexOf(category) < 0 ? 99 : used.indexOf(category));
  return (
    <div className="[--lw:1.75rem] @[440px]:[--lw:8rem] @[720px]:[--lw:11rem]">
      <div className="grid grid-cols-[var(--lw)_minmax(0,1fr)]">
        <div />
        <div ref={track} className="relative mx-1.5 h-6">
          {width > 0 && ticks
            .filter((tk) => tk.label)
            .map((tk) => (
              <span key={tk.d} className="absolute top-0 -translate-x-1/2 text-[length:var(--fs-1)] text-muted-foreground tnum" style={{ left: `${(tk.labelX / width) * 100}%` }}>
                {tk.label}
              </span>
            ))}
        </div>
      </div>
      {rows.map((r) => (
        <div key={r.s.id} className="grid grid-cols-[var(--lw)_minmax(0,1fr)] items-center rounded-sm transition-colors hover:bg-muted/50" style={{ height: ROW + (r.lanes - 1) * LANE }}>
          <div className="flex min-w-0 items-center gap-2 pr-2">
            <AppIcon sub={r.s} size={20} className="rounded-[5px]" />
            <span className="hidden min-w-0 truncate text-[length:var(--fs-2)] @[440px]:block">{clean(r.s.name)}</span>
          </div>
          <div className="relative mx-1.5 h-full">
            {ticks.map((tk) => (
              <i key={tk.d} className="pointer-events-none absolute inset-y-0 w-[0.5px] bg-border" style={{ left: pct(tk.d) }} />
            ))}
            {r.gaps.map((g) => (
              <Gap key={g.from} from={g.from} to={g.to} left={pct(g.from)} right={pct(g.to)} />
            ))}
            {r.bars.map((b) => (
              <Bar key={b.from} row={r} bar={b} color={colorOf(r.s.category)} left={pct(b.from)} right={pct(b.to)} />
            ))}
            {ongoing && <i className="pointer-events-none absolute inset-y-0 w-px bg-foreground/40" style={{ left: pct(today) }} />}
          </div>
        </div>
      ))}
      {used.length > 1 && (
        <ul className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[length:var(--fs-1)] text-muted-foreground">
          {used.slice(0, 5).map((c, i) => (
            <li key={c} className="flex min-w-0 items-center gap-1.5">
              <i className="size-2.5 shrink-0 rounded-md" style={{ background: shade(i) }} />
              <span className="truncate">{c}</span>
            </li>
          ))}
          {used.length > 5 && (
            <li className="flex items-center gap-1.5">
              <i className="size-2.5 shrink-0 rounded-md" style={{ background: shade(5) }} />
              {t('public.composition.other')}
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

const extent = (left: string, right: string) => `calc(${right} - ${left})`;

function Bar({ row, bar, color, left, right }: { row: YearsRow; bar: YearsBar; color: string; left: string; right: string }) {
  const name = clean(row.s.name);
  const lifetime = bar.v.cycle.unit === 'lifetime';
  const top = (ROW - BAR) / 2 + bar.lane * LANE;
  const range = `${cnDateFull(bar.from)} – ${bar.ongoing ? t('list.gantt.present') : cnDateFull(bar.to)}`;
  const span = diffDays(bar.from, bar.to);
  const price = money(priceAt(bar.v, bar.to), bar.v.currency);
  const tip = (
    <TipBody
      head={name}
      rows={[
        { key: 'range', label: lifetime && !span ? cnDateFull(bar.from) : range },
        ...(span > 0 ? [{ key: 'span', label: durationLabel(span) }] : []),
        { key: 'price', label: cycleLabel(bar.v.cycle), value: price },
      ]}
    />
  );
  const aria = `${name} ${lifetime && !span ? cnDateFull(bar.from) : range}`;
  // 点按目标撑到整行高，条本身仍是细的
  const hit = 'absolute cursor-default transition-opacity outline-none before:absolute before:-inset-y-[7px] before:inset-x-0 hover:opacity-80 focus-visible:ring-2 focus-visible:ring-(--focus-ring)';
  if (lifetime)
    return (
      <>
        {span > 0 && <i className="pointer-events-none absolute h-0.5 rounded-sm opacity-55" style={{ left, width: extent(left, right), top: top + BAR / 2 - 1, background: color }} />}
        <Tip content={tip}>
          <button type="button" aria-label={aria} className={`${hit} size-3.5 -translate-x-1/2 rounded-full`} style={{ left, top, background: color }} />
        </Tip>
      </>
    );
  return (
    <Tip content={tip}>
      <button type="button" aria-label={aria} className={`${hit} rounded-full`} style={{ left, width: extent(left, right), minWidth: 6, height: BAR, top, background: color }} />
    </Tip>
  );
}

function Gap({ from, to, left, right }: { from: string; to: string; left: string; right: string }) {
  const text = t('list.gantt.gapTitle', { span: durationLabel(diffDays(from, to)), from: cnDate(from), to: cnDate(to) });
  return (
    <Tip content={text}>
      <button type="button" aria-label={text} className="absolute flex cursor-default items-center outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)" style={{ left, width: extent(left, right), top: (ROW - BAR) / 2, height: BAR }}>
        <i className="w-full border-t-[0.5px] border-dashed border-muted-foreground" />
      </button>
    </Tip>
  );
}

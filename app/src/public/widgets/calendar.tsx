import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { addDays, addMonths, cycleLabel, diffDays, type Charge } from '../../../../shared/billing.ts';
import { heatLevel, monthGrid } from '../../../../shared/calendar.ts';
import { cnDate, flow, monthLabel, relDays, weekdayShort } from '../../../../shared/format.ts';
import { chargeBaseOrNaN, chargeValue } from '../../../../shared/fx.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState } from '../../../../shared/types.ts';
import { copyParts } from '../../components/copy.tsx';
import { allCharges, firstStart, sumBaseOrNaN } from '../../derive.ts';
import { AppIcon } from '@/public/components/app-icon';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { Tabs, TabsList, TabsTrigger } from '@/public/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/public/components/ui/tooltip';
import { cn } from '@/public/lib/utils';
import { clean, outflow, TipBody, useWidth } from './lib.tsx';
import type { WidgetProps } from './props.ts';

type Mode = 'month' | 'year';
type Shared = { state: AppState; today: string; ccy: string; byDay: Map<string, Charge[]>; dows: string[]; weekStart: 0 | 1 };

/** 表头的星期简称，按周起始日排好 */
const dowsOf = (weekStart: 0 | 1) => Array.from({ length: 7 }, (_, i) => weekdayShort((i + weekStart) % 7, true));

/** 一天的提示：逐笔列出，多笔时标题带合计 */
function dayTip(d: string, list: Charge[], state: AppState, ccy: string) {
  return (
    <TipBody
      head={cnDate(d, true)}
      total={list.length > 1 ? outflow(sumBaseOrNaN(state, list, ccy), ccy) : undefined}
      rows={list.map((c, i) => ({ key: `${c.sub.id}-${i}`, label: clean(c.sub.name), value: outflow(chargeBaseOrNaN(state, c, ccy), ccy) }))}
    />
  );
}

export function CalendarCard({ state, today, ccy }: WidgetProps) {
  const weekStart = state.settings.weekStart ?? 1;
  const [mode, setMode] = useState<Mode>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [sel, setSel] = useState<string | null>(today);
  const year = month.slice(0, 4);
  const byDay = useMemo(() => {
    const grid = monthGrid(month, weekStart);
    // 取整年与月网格的并集（网格会带出上下月的几天）
    const from = grid[0] < `${year}-01-01` ? grid[0] : `${year}-01-01`;
    const to = grid[grid.length - 1] > `${year}-12-31` ? grid[grid.length - 1] : `${year}-12-31`;
    const map = new Map<string, Charge[]>();
    for (const c of allCharges(state, from, to, today)) if (c.kind !== 'failed') map.set(c.date, [...(map.get(c.date) ?? []), c]);
    return map;
  }, [state, today, month, year, weekStart]);
  if (!state.subscriptions.length) return null;

  const shared: Shared = { state, today, ccy, byDay, dows: dowsOf(weekStart), weekStart };
  const scope = mode === 'month' ? month : year;
  const shown = [...byDay].filter(([d]) => d.startsWith(scope)).flatMap(([, list]) => list);
  const first = firstStart(state, today);
  const atStart = scope <= first.slice(0, scope.length);
  const isNow = today.startsWith(scope);
  const go = (m: string, day: string | null = null) => {
    setMonth(m);
    setSel(day);
  };
  const shift = (n: number) => go(addMonths(`${month}-01`, mode === 'year' ? n * 12 : n).slice(0, 7));

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.calendar.title')}</CardTitle>
        <CardAction>
          <Tabs value={mode} onValueChange={(v: string) => setMode(v as Mode)}>
            <TabsList>
              <TabsTrigger value="month" className="px-2.5 text-xs">
                {t('calendar.mode.month')}
              </TabsTrigger>
              <TabsTrigger value="year" className="px-2.5 text-xs">
                {t('calendar.mode.year')}
              </TabsTrigger>
            </TabsList>
          </Tabs>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div className="mb-2 flex flex-wrap items-center gap-x-1 gap-y-1">
          <button type="button" className="public-icon-btn" aria-label={t('calendar.prev')} title={t('calendar.prev')} disabled={atStart} onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </button>
          <span className="min-w-0 px-1 font-medium tnum">{mode === 'month' ? monthLabel(month, { long: true }) : t('calendar.yearTitle', { year })}</span>
          <button type="button" className="public-icon-btn" aria-label={t('calendar.next')} title={t('calendar.next')} onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </button>
          {!isNow && (
            <button type="button" className="public-filter-btn rounded-md px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground" onClick={() => go(today.slice(0, 7), today)}>
              {t('calendar.today')}
            </button>
          )}
          {shown.length > 0 && <span className="ml-auto text-[length:var(--fs-2)] text-muted-foreground tnum">{copyParts(t('calendar.summary', { count: shown.length, amount: outflow(sumBaseOrNaN(state, shown, ccy), ccy) }))}</span>}
        </div>
        {mode === 'month' ? (
          <MonthView {...shared} month={month} sel={sel} onSelect={setSel} empty={shown.length === 0} />
        ) : (
          <YearHeat
            {...shared}
            year={year}
            onPick={(m) => {
              go(m, today.startsWith(m) ? today : null);
              setMode('month');
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}

function MonthView({ state, today, ccy, byDay, dows, weekStart, month, sel, onSelect, empty }: Shared & { month: string; sel: string | null; onSelect: (d: string | null) => void; empty: boolean }) {
  // 图标只排一行：按格子实际宽度算能放几个，放不下的换成「+N」，格子高度不变
  const [gridRef, gridW] = useWidth<HTMLDivElement>();
  // 格子放得下金额时拉开列距，否则金额会贴着下一格的日期
  const gapX = gridW >= 528 ? 8 : 1;
  const cellW = (gridW - gapX * 6) / 7;
  const icon = gridW > 0 && cellW < 60 ? 16 : 20;
  const step = Math.round(icon * 0.6);
  const inner = cellW - 8;
  const MORE_W = 18;
  const allCap = gridW ? Math.max(1, Math.floor((inner - icon) / step) + 1) : 3;
  const iconCap = gridW ? Math.max(1, Math.floor((inner - icon - MORE_W) / step) + 1) : 3;
  const fits = (n: number, more: boolean) => icon * n + 2 * (n - 1) + (more ? MORE_W : 0) <= inner;
  const selList = (sel && byDay.get(sel)) || [];
  return (
    <>
      <div ref={gridRef} className="grid grid-cols-7 gap-y-px" style={{ columnGap: gapX }}>
        {dows.map((d, i) => (
          <div key={i} className="ml-1 w-[18px] pb-1 text-center text-[length:var(--fs-1)] text-muted-foreground">
            {d}
          </div>
        ))}
        {monthGrid(month, weekStart).map((d) => {
          const items = byDay.get(d) ?? [];
          const icons = items.length > allCap ? items.slice(0, iconCap) : items;
          const more = items.length - icons.length;
          const gap = fits(icons.length, more > 0) ? 2 : step - icon;
          const cell = (
            <button
              key={d}
              type="button"
              aria-pressed={d === sel}
              aria-current={d === today ? 'date' : undefined}
              aria-label={cnDate(d, true)}
              onClick={() => onSelect(d === sel ? null : d)}
              className={cn(
                'flex h-12 min-w-0 flex-col justify-between overflow-hidden rounded-md p-1 text-left transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-(--focus-ring) @[560px]:h-14',
                d === sel && 'bg-muted hover:bg-muted',
                !d.startsWith(month) && 'opacity-40',
              )}
            >
              <span className="flex min-w-0 items-center justify-between gap-1">
                <span className={cn('flex size-[18px] shrink-0 items-center justify-center rounded-full text-[length:var(--fs-1)] leading-none tnum', d === today ? 'bg-foreground font-medium text-background' : 'text-muted-foreground')}>{Number(d.slice(8))}</span>
                {items.length > 0 && <span className="hidden min-w-0 truncate text-[length:var(--fs-1)] text-muted-foreground tnum @[560px]:block">{outflow(sumBaseOrNaN(state, items, ccy), ccy)}</span>}
              </span>
              <span className="flex h-5 items-center">
                {icons.map((c, i) => (
                  <span key={`${c.sub.id}-${i}`} className="shrink-0" style={{ marginLeft: i ? gap : 0 }}>
                    <AppIcon sub={c.sub} size={icon} className="rounded-[4px] bg-card" />
                  </span>
                ))}
                {more > 0 && <span className="ml-0.5 shrink-0 text-[length:var(--fs-1)] leading-none text-muted-foreground tnum">+{more}</span>}
              </span>
            </button>
          );
          if (!items.length) return cell;
          return (
            <Tooltip key={d}>
              <TooltipTrigger asChild>{cell}</TooltipTrigger>
              <TooltipContent sideOffset={4}>{dayTip(d, items, state, ccy)}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="mt-3 border-t-[0.5px] border-border pt-3">
        {sel && selList.length > 0 ? (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h3 className="min-w-0 font-medium">{copyParts(`${cnDate(sel, true)}\n${relDays(diffDays(today, sel))}`)}</h3>
              {selList.length > 1 && <span className="shrink-0 font-medium tnum">{outflow(sumBaseOrNaN(state, selList, ccy), ccy)}</span>}
            </div>
            <ul>
              {selList.map((c, i) => (
                <li key={`${c.sub.id}-${i}`} className="flex items-center gap-3 py-1.5">
                  <AppIcon sub={c.sub} className="size-8 rounded-md" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{clean(c.sub.name)}</div>
                    <div className="truncate text-[length:var(--fs-2)] text-muted-foreground">{copyParts(`${cycleLabel(c.sub.cycle)}\n${t(c.kind === 'refund' ? 'detail.charges.kind.refund' : c.projected ? 'calendar.projected' : 'calendar.charged')}`)}</div>
                  </div>
                  <div className="shrink-0 text-right tnum">
                    <div>{outflow(chargeBaseOrNaN(state, c, ccy), ccy)}</div>
                    {c.currency !== ccy && <div className="text-[length:var(--fs-2)] text-muted-foreground">{flow(-c.amount, c.currency)}</div>}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="py-1 text-center text-[length:var(--fs-2)] text-muted-foreground">{t(empty ? 'calendar.noneMonth' : sel ? 'calendar.noneDay' : 'calendar.pickDay')}</p>
        )}
      </div>
    </>
  );
}

/** 按扣款多少分档的底色，文字随底色深浅换 */
const HEAT = { 1: 'color-mix(in srgb, var(--c1) 18%, var(--card))', 2: 'color-mix(in srgb, var(--c1) 38%, var(--card))', 3: 'color-mix(in srgb, var(--c1) 68%, var(--card))', 4: 'var(--c1)' };

function YearHeat({ state, today, ccy, byDay, dows, weekStart, year, onPick }: Shared & { year: string; onPick: (m: string) => void }) {
  // 只算几何：缺汇率的按 0 计，仍落在最浅一档，不和没扣款的日子混淆
  const net = (list: Charge[]) => Math.abs(list.reduce((a, c) => a + chargeValue(state, c, ccy), 0));
  const peak = Math.max(0, ...[...byDay].filter(([d]) => d.startsWith(year)).map(([, list]) => net(list)));
  return (
    <div className="grid grid-cols-2 gap-2 @[400px]:grid-cols-3 @[760px]:grid-cols-4">
      {Array.from({ length: 12 }, (_, i) => {
        const m = `${year}-${String(i + 1).padStart(2, '0')}`;
        // 固定 6 行，让 12 张月卡等高对齐
        const start = monthGrid(m, weekStart)[0];
        const grid = Array.from({ length: 42 }, (_, k) => addDays(start, k));
        const list = grid.filter((d) => d.startsWith(m)).flatMap((d) => byDay.get(d) ?? []);
        return (
          <button key={m} type="button" onClick={() => onPick(m)} className={cn('min-w-0 rounded-lg p-2 text-left ring-[0.5px] ring-border transition-colors outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-(--focus-ring)', today.startsWith(m) && 'ring-foreground/50')}>
            <span className="mb-1 flex min-w-0 items-baseline justify-between gap-1">
              <span className="shrink-0 text-[length:var(--fs-2)] font-medium">{monthLabel(m, { year: false })}</span>
              {list.length > 0 && <span className="min-w-0 truncate text-[length:var(--fs-1)] text-muted-foreground tnum">{outflow(sumBaseOrNaN(state, list, ccy), ccy)}</span>}
            </span>
            <span className="grid grid-cols-7 gap-px">
              {dows.map((w, k) => (
                <em key={k} className="text-center text-[length:var(--fs-1)] leading-4 text-muted-foreground not-italic">
                  {w}
                </em>
              ))}
              {grid.map((d) => {
                if (!d.startsWith(m)) return <i key={d} className="invisible aspect-square" />;
                const items = byDay.get(d);
                const base = cn('flex aspect-square items-center justify-center rounded-[3px] text-[length:var(--fs-1)] leading-none not-italic tnum', d === today && 'ring-1 ring-foreground');
                if (!items) return <i key={d} className={cn(base, 'text-muted-foreground')}>{Number(d.slice(8))}</i>;
                const level = heatLevel(net(items), peak);
                return (
                  <Tooltip key={d}>
                    <TooltipTrigger asChild>
                      {/* 预计的扣款淡一些 */}
                      <i className={cn(base, level > 2 ? 'text-white' : 'text-foreground', d > today && 'opacity-60')} style={{ background: HEAT[level] }}>
                        {Number(d.slice(8))}
                      </i>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={4}>{dayTip(d, items, state, ccy)}</TooltipContent>
                  </Tooltip>
                );
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

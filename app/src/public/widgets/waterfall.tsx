import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';
import { monthLabel, moneyTick } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { signedMoney, stepMonth, waterfallFirstMonth, waterfallMonth, type WaterfallStep } from '../../../../shared/public-changes.ts';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/public/components/ui/chart';
import { cn } from '@/public/lib/utils';
import type { WidgetProps } from './props.ts';

const isTotal = (s: WaterfallStep) => s.id === 'from' || s.id === 'to';

const fill = (s: WaterfallStep) => {
  if (s.id === 'from') return 'color-mix(in srgb, var(--color-range) 70%, var(--card))';
  if (s.id === 'to') return 'var(--color-range)';
  return s.value > 0 ? 'var(--up)' : 'var(--down)';
};

/** 月度变化：上月 → 各项增减 → 期末；增减同时有 + − 号和文字，不只靠颜色 */
export function WaterfallCard({ state, today, ccy, fmt }: WidgetProps) {
  const first = useMemo(() => waterfallFirstMonth(state, today), [state, today]);
  const cur = today.slice(0, 7);
  const [picked, setMonth] = useState(cur);
  const month = first && picked < first ? first : picked;
  const wf = useMemo(() => waterfallMonth(state, month, today, ccy), [state, month, today, ccy]);
  if (!first) return null;

  const name = (s: WaterfallStep) => t(`public.waterfall.${s.id === 'to' && month !== cur ? 'monthEnd' : s.id}`);
  const text = (s: WaterfallStep) => (isTotal(s) ? fmt(s.value) : signedMoney(s.value, ccy));
  const config = { range: { label: t('public.waterfall.title'), color: 'var(--c1)' } } satisfies ChartConfig;
  const data = wf.steps.map((s) => ({ step: s, label: name(s), value: text(s), range: [isTotal(s) ? wf.floor : s.low, s.high] }));
  // 与 PaidChart 同一断点：Recharts 的 radius 只收数字
  const radius = globalThis.matchMedia?.('(max-width: 700px)').matches ? 4 : 6;

  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.waterfall.title')}</CardTitle>
        <CardAction className="flex items-center gap-0.5">
          <button type="button" aria-label={t('public.waterfall.prev')} disabled={month <= first} onClick={() => setMonth(stepMonth(month, -1))} className="public-icon-btn disabled:pointer-events-none">
            <ChevronLeft size={16} />
          </button>
          <span className="text-[length:var(--fs-2)] whitespace-nowrap text-muted-foreground tnum">{monthLabel(month)}</span>
          <button type="button" aria-label={t('public.waterfall.next')} disabled={month >= cur} onClick={() => setMonth(stepMonth(month, 1))} className="public-icon-btn disabled:pointer-events-none">
            <ChevronRight size={16} />
          </button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {wf.complete ? (
          <ChartContainer config={config} className="aspect-auto h-44 w-full">
            <BarChart data={data} barCategoryGap="25%" margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
              <CartesianGrid strokeWidth={0.5} vertical={false} strokeDasharray="2 4" />
              <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={2} />
              <YAxis tickLine={false} axisLine={false} width={44} tickCount={4} domain={[wf.floor, 'auto']} tickFormatter={(v: number) => moneyTick(v, ccy)} />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => p?.[0]?.payload?.label} formatter={(_v, _n, item) => <span className="font-medium tnum">{item.payload.value}</span>} />} />
              <Bar dataKey="range" radius={[radius, radius, 0, 0]} maxBarSize={40} isAnimationActive={false}>
                {data.map((d) => (
                  <Cell key={d.step.id} fill={fill(d.step)} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <p className="flex h-44 items-center justify-center text-center text-[length:var(--fs-2)] text-muted-foreground">{t('public.waterfall.incomplete')}</p>
        )}
        <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[length:var(--fs-2)]">
          {wf.steps.map((s) => (
            <div key={s.id} className="flex items-baseline gap-1.5">
              <dt className="text-muted-foreground">{name(s)}</dt>
              <dd className={cn('font-medium tnum', !isTotal(s) && Number.isFinite(s.value) && (s.value > 0 ? 'text-up' : 'text-down'))}>{text(s)}</dd>
            </div>
          ))}
        </dl>
        {wf.floor > 0 && <p className="mt-1 text-[length:var(--fs-2)] text-muted-foreground tnum">{t('public.waterfall.axisFrom', { amount: moneyTick(wf.floor, ccy) })}</p>}
      </CardContent>
    </Card>
  );
}

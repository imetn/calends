import { Area, AreaChart } from 'recharts';
import { addMonths } from '../../../../shared/billing.ts';
import { t } from '../../../../shared/i18n.ts';
import type { PublicMetricCard, PublicMetricId } from '../../../../shared/public-layout.ts';
import type { MetricValue } from '../../../../shared/public-metrics.ts';
import { type ChartConfig, ChartContainer, ChartTooltip, ChartTooltipContent } from '@/public/components/ui/chart';
import { Card, CardContent } from '@/public/components/ui/card';
import { Num } from '@/public/components/number';
import { cn } from '@/public/lib/utils';

type Values = Record<PublicMetricId, MetricValue>;
type Format = { ccy: string; sym: string; fmt: (v: number) => string };

const label = (id: string) => t(`public.metric.${id}`);
const sparkConfig = { v: { color: 'var(--c1)' } } satisfies ChartConfig;

/** 缺汇率算不出来时显示占位，不显示 0 */
function Value({ m, f, className }: { m: MetricValue; f: Format; className?: string }) {
  if (!Number.isFinite(m.value)) return <span className={className}>—</span>;
  return m.kind === 'money' ? <Num value={m.value} ccy={f.ccy} prefix={f.sym} className={className} /> : <Num value={m.value} className={className} />;
}

function Spark({ data, f }: { data: { label: string; v: number }[]; f: Format }) {
  return (
    <ChartContainer config={sparkConfig} className="mt-3 aspect-auto h-10 w-full">
      <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
        <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => p?.[0]?.payload?.label} formatter={(v) => f.fmt(Number(v))} />} />
        <Area dataKey="v" type="monotone" stroke="var(--color-v)" strokeWidth={2} fill="var(--color-v)" fillOpacity={0.12} isAnimationActive={false} />
      </AreaChart>
    </ChartContainer>
  );
}

const big = 'mt-1 block text-2xl font-semibold tracking-tight tnum';

/** 指标卡：模板决定版式，数据是主人选的。卡片尺寸由画布决定，内容不换字号，只是占满 */
export function MetricCard({ card, values, f }: { card: PublicMetricCard; values: Values; f: Format }) {
  const ids = card.items as PublicMetricId[];
  const first = values[ids[0]];
  const head = <div className="truncate text-[length:var(--fs-2)] text-muted-foreground">{label(ids[0])}</div>;
  return (
    <Card className={cn('h-full justify-center')}>
      <CardContent>
        {card.template === 'number' && (
          <>
            {head}
            <Value m={first} f={f} className={big} />
          </>
        )}
        {card.template === 'trend' && (
          <>
            {head}
            <Value m={first} f={f} className={big} />
            {first.series && <Spark data={first.series} f={f} />}
          </>
        )}
        {card.template === 'compare' && (
          <>
            {head}
            <Value m={first} f={f} className={big} />
            <div className="mt-1 text-[length:var(--fs-2)] text-muted-foreground tnum">{t('public.metric.vsPrev', { amount: Number.isFinite(first.prev) ? f.fmt(first.prev ?? 0) : '—' })}</div>
          </>
        )}
        {card.template === 'share' && <Share id={ids[0]} m={first} f={f} />}
        {card.template === 'rows' && (
          <dl className="flex flex-col gap-2">
            {ids.map((id) => (
              <div key={id} className="flex items-baseline justify-between gap-3">
                <dt className="min-w-0 truncate text-[length:var(--fs-2)] text-muted-foreground">{label(id)}</dt>
                <dd className="shrink-0 font-semibold tnum">
                  <Value m={values[id]} f={f} />
                </dd>
              </div>
            ))}
          </dl>
        )}
      </CardContent>
    </Card>
  );
}

function Share({ id, m, f }: { id: string; m: MetricValue; f: Format }) {
  const pct = m.total && Number.isFinite(m.value) ? Math.min(1, Math.max(0, m.value / m.total)) : 0;
  return (
    <>
      <div className="truncate text-[length:var(--fs-2)] text-muted-foreground">{label(id)}</div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-semibold">{m.name ?? '—'}</span>
        <Value m={m} f={f} className="shrink-0 tnum" />
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${pct * 100}%`, background: 'var(--c1)' }} />
      </div>
      <div className="mt-1 text-[length:var(--fs-2)] text-muted-foreground tnum">{t('public.metric.share', { percent: `${Math.round(pct * 100)}%` })}</div>
    </>
  );
}

/** 上一年同一天：闰日落到 2 月最后一天 */
export const yearBefore = (day: string) => addMonths(day, -12);

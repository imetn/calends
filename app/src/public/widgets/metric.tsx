import { Bar, BarChart, Cell } from 'recharts';
import { addMonths } from '../../../../shared/billing.ts';
import { t } from '../../../../shared/i18n.ts';
import { signedMoney } from '../../../../shared/public-changes.ts';
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

function Value({ m, f, className }: { m: MetricValue; f: Format; className?: string }) {
  if (m.signed && Number.isFinite(m.value)) return <span className={className}>{signedMoney(m.value, f.ccy)}</span>;
  return m.kind === 'money' ? <Num value={m.value} ccy={f.ccy} prefix={f.sym} className={className} /> : <Num value={m.value} className={className} />;
}

/** 迷你柱：最后一根（当前）用实色，其余退后；只看走势，不要坐标轴 */
function Spark({ data, f }: { data: { label: string; v: number }[]; f: Format }) {
  const last = data.length - 1;
  return (
    <div className="mt-auto pt-2">
      <ChartContainer config={sparkConfig} className="aspect-auto h-8 w-full">
        <BarChart data={data} margin={{ top: 0, right: 0, bottom: 0, left: 0 }} barCategoryGap="20%">
          <ChartTooltip cursor={false} content={<ChartTooltipContent hideIndicator labelFormatter={(_, p) => p?.[0]?.payload?.label} formatter={(v) => f.fmt(Number(v))} />} />
          <Bar dataKey="v" radius={[2, 2, 0, 0]} isAnimationActive={false}>
            {data.map((p, i) => (
              <Cell key={p.label} fill="var(--color-v)" fillOpacity={i === last ? 1 : 0.28} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </div>
  );
}

/** 占比条分成小格：比一整条更容易读出大概几成 */
const SEGMENTS = 24;
function Segments({ pct }: { pct: number }) {
  const on = Math.round(pct * SEGMENTS);
  return (
    <div className="mt-auto pt-3" aria-hidden="true">
      <div className="flex h-3.5 gap-0.5">
        {Array.from({ length: SEGMENTS }, (_, i) => (
          <span key={i} className={cn('min-w-0 flex-1 rounded-[2px]', i >= on && 'bg-muted')} style={i < on ? { background: 'var(--c1)' } : undefined} />
        ))}
      </div>
    </div>
  );
}

const big = 'mt-1 block text-xl font-semibold tracking-tight tnum @[200px]:text-2xl';
const note = 'truncate text-[length:var(--fs-2)] text-muted-foreground';

/** 和上期差多少：带正负号，不靠颜色 */
function delta(m: MetricValue, f: Format) {
  if (!Number.isFinite(m.prev) || !Number.isFinite(m.value)) return '—';
  const d = m.value - (m.prev ?? 0);
  return `${d > 0 ? '+' : d < 0 ? '−' : ''}${f.fmt(Math.abs(d))}`;
}

/** 指标卡：模板决定版式，数据是主人选的。标签靠上对齐，同一排的卡片读起来是一条线 */
export function MetricCard({ card, values, f }: { card: PublicMetricCard; values: Values; f: Format }) {
  const ids = card.items as PublicMetricId[];
  const first = values[ids[0]];
  const head = <div className={note}>{label(ids[0])}</div>;
  return (
    <Card className="h-full">
      <CardContent className="flex flex-1 flex-col">
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
            {(first.value !== 0 || !!first.prev) && (
              <div className={cn(note, 'mt-auto pt-1 tnum')}>
                <span className="font-medium text-foreground">{delta(first, f)}</span> {t('public.metric.vsPrev')}
              </div>
            )}
          </>
        )}
        {card.template === 'share' && <Share id={ids[0]} m={first} f={f} />}
        {card.template === 'rows' && (
          <dl className="flex flex-col gap-1.5">
            {ids.map((id) => (
              <div key={id} className="flex items-baseline justify-between gap-3">
                <dt className={cn(note, 'min-w-0')}>{label(id)}</dt>
                <dd className="shrink-0 font-medium tnum">
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
  // 分子或分母缺汇率时占比算不出来：写占位，格子全空，不写 0%
  const known = Number.isFinite(m.value) && Number.isFinite(m.total);
  const pct = known && m.total ? Math.min(1, Math.max(0, m.value / m.total)) : 0;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className={note}>{label(id)}</span>
        <span className="shrink-0 text-[length:var(--fs-2)] text-muted-foreground tnum" title={t('public.metric.shareOf')}>
          {m.name != null && (known ? `${Math.round(pct * 100)}%` : '—')}
        </span>
      </div>
      <div className="mt-1 flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate text-base font-semibold">{m.name ?? '—'}</span>
        {m.name != null && <Value m={m} f={f} className="shrink-0 font-medium tnum" />}
      </div>
      <Segments pct={pct} />
    </>
  );
}

/** 上一年同一天：闰日落到 2 月最后一天 */
export const yearBefore = (day: string) => addMonths(day, -12);

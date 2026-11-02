import { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { monthLabel } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { signedMoney, stepMonth, waterfallFirstMonth, waterfallMonth, type WaterfallStep } from '../../../../shared/public-changes.ts';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { cn } from '@/public/lib/utils';
import type { WidgetProps } from './props.ts';

const isTotal = (s: WaterfallStep) => s.id === 'from' || s.id === 'to';

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
  // 只画增减：总额写数字，条不用截断纵轴。条按累计走势错开，一眼看出先涨后跌
  const moves = wf.steps.filter((s) => !isTotal(s));
  const lo = Math.min(...moves.map((s) => s.low));
  const peak = Math.max(...wf.steps.map((s) => Math.abs(s.value)));
  // 分母至少是总额的五分之一：只有一笔小变动时不铺满整行
  const span = Math.max(Math.max(...moves.map((s) => s.high)) - lo, peak / 5) || 1;
  const pos = (v: number) => `${((v - lo) / span) * 100}%`;

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
          <dl className="flex flex-col gap-2">
            {wf.steps.map((s) => (
              <div key={s.id} className="grid grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-3 @[420px]:grid-cols-[5rem_minmax(0,1fr)_auto]">
                <dt className="truncate text-[length:var(--fs-2)] text-muted-foreground">{name(s)}</dt>
                <div className="relative h-2">{!isTotal(s) && <i className="absolute inset-y-0 min-w-0.5 rounded-sm" style={{ left: pos(s.low), width: `calc(${pos(s.high)} - ${pos(s.low)})`, background: s.value > 0 ? 'var(--up)' : 'var(--down)' }} />}</div>
                <dd className={cn('text-right tnum', isTotal(s) ? 'font-medium' : s.value > 0 ? 'text-up' : 'text-down')}>{text(s)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="py-6 text-center text-[length:var(--fs-2)] text-muted-foreground">{t('public.waterfall.incomplete')}</p>
        )}
      </CardContent>
    </Card>
  );
}

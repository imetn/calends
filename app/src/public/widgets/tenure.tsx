import { useMemo } from 'react';
import { servedSpan } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { subscriptionTenure } from '../../../../shared/scope-report.ts';
import { Card, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { clean } from './lib.tsx';
import type { WidgetProps } from './props.ts';

const label = 'text-[length:var(--fs-2)] text-muted-foreground';

/** 订阅时长：在用订阅平均持有多久，以及用得最久的几个 */
export function TenureCard({ state, today }: WidgetProps) {
  const r = useMemo(() => subscriptionTenure(state, today), [state, today]);
  // 卡片变窄时名字截断，时长不折行
  const top = r.longest.slice(0, 8);
  if (!top.length) return null;
  const max = top[0].days || 1;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.tenure.title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <div className={label}>{t('public.tenure.avg')}</div>
          <div className="mt-1 text-2xl font-semibold tracking-tight tnum">{servedSpan(r.active.avgDays)}</div>
        </div>
        <div>
          <div className={label}>{t('public.tenure.longest')}</div>
          <ul className="mt-2 flex flex-col gap-2.5">
            {top.map((x) => (
              <li key={x.sub.id}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate">{clean(x.sub.name)}</span>
                  <span className="shrink-0 text-[length:var(--fs-2)] text-muted-foreground tnum">{servedSpan(x.days)}</span>
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full" style={{ width: `${(x.days / max) * 100}%`, background: 'var(--c1)' }} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

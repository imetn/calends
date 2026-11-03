import { useMemo, useState } from 'react';
import { cnDateAuto } from '../../../../shared/format.ts';
import { t } from '../../../../shared/i18n.ts';
import { publicChanges, signedMoney, type PublicChange } from '../../../../shared/public-changes.ts';
import { AppIcon } from '@/public/components/app-icon';
import { Card, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { cn } from '@/public/lib/utils';
import { clean } from './lib.tsx';
import type { WidgetProps } from './props.ts';

const FOLDED = 8;

function Amount({ c, ccy }: { c: PublicChange; ccy: string }) {
  if (!Number.isFinite(c.delta)) return <>—</>;
  const text = signedMoney(c.delta, ccy);
  return <>{c.kind === 'buy' ? text : t('public.perMonth', { amount: text })}</>;
}

/** 变动记录：时间倒序，只有价格变化按涨跌配色 */
export function ChangesCard({ state, today, ccy }: WidgetProps) {
  const rows = useMemo(() => publicChanges(state, today, ccy), [state, today, ccy]);
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.changes.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="-my-1.5 grid grid-cols-1 gap-x-10 @[880px]:grid-cols-2">
          {(all ? rows : rows.slice(0, FOLDED)).map((c, i) => {
            const date = cnDateAuto(c.date, today);
            return (
              <li key={`${c.sub.id}-${c.kind}-${c.date}-${i}`} className="flex items-center gap-3 py-1.5">
                <span className="hidden w-[6.5rem] shrink-0 text-[length:var(--fs-2)] whitespace-nowrap text-muted-foreground tnum @[420px]:block">{date}</span>
                <AppIcon sub={c.sub} className="size-7 rounded-md" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{clean(c.sub.name)}</div>
                  <div className="flex gap-1.5 text-[length:var(--fs-2)] text-muted-foreground tnum">
                    <span className="min-w-0 truncate">{t(`public.changes.kind.${c.kind}`)}</span>
                    <span className="shrink-0 @[420px]:hidden">{date}</span>
                  </div>
                </div>
                <span className={cn('shrink-0 text-right tnum', c.kind === 'up' && 'text-up', c.kind === 'down' && 'text-down')}>
                  <Amount c={c} ccy={ccy} />
                </span>
              </li>
            );
          })}
        </ul>
        {rows.length > FOLDED && (
          <button type="button" aria-expanded={all} onClick={() => setAll(!all)} className="mt-2 rounded-sm text-[length:var(--fs-2)] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-[0.5px] focus-visible:outline-[var(--focus-ring)]">
            {all ? t('public.changes.less') : t('public.changes.more', { n: rows.length })}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

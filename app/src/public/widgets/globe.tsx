import { useMemo } from 'react';
import { t } from '../../../../shared/i18n.ts';
import { regionSpread } from '../../../../shared/scope-report.ts';
import { Card, CardContent, CardHeader, CardTitle } from '@/public/components/ui/card';
import { cn } from '@/public/lib/utils';
import { Globe, useGlobeFocus } from '../../components/Globe.tsx';
import { base as appPath } from '../../base.ts';
import { FLAGS } from '../../display.ts';
import { regionLabel, subRegion } from '../../region.ts';
import type { AppState } from '../../../../shared/types.ts';
import type { WidgetProps } from './props.ts';

/** 地球卡片和应用的报告页同一口径：在用订阅分布在 4 个及以上地区时才有内容 */
export const globeRows = (state: AppState, today: string) =>
  regionSpread(state, today, (v) => subRegion(v, state.methods.find((m) => m.id === v.methodId)));
export const hasGlobe = (state: AppState, today: string) => globeRows(state, today).length > 3;

/** 订阅地区：点阵地球 + 地区列表；悬停或点一行，地球转到那个地区 */
export function GlobeCard({ state, today, k, fmt }: WidgetProps) {
  const rows = useMemo(() => globeRows(state, today), [state, today]);
  const { focus, list, row } = useGlobeFocus();
  const max = Math.max(0, ...rows.map((r) => (r.monthly.known ? r.monthly.value : 0)));
  const points = useMemo(() => rows.map((r) => ({ cc: r.cc, weight: max > 0 && r.monthly.known ? r.monthly.value / max : 0 })), [rows, max]);
  if (rows.length <= 3) return null;
  // k 为 0 是显示币种缺汇率；地区里有折算不了的金额也写占位，不写 0，也不只写能折算的一部分
  const amount = (r: (typeof rows)[number]) => (k > 0 && r.monthly.known && !r.monthly.incomplete ? fmt(r.monthly.value * k) : '—');
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.globe.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 items-center gap-x-8 gap-y-4 @[640px]:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <div className="mx-auto w-full max-w-80">
          <Globe points={points} focus={focus} label={t('public.globe.title')} className="block aspect-square w-full cursor-grab touch-pan-y active:cursor-grabbing" />
        </div>
        <ul className="-my-1.5" {...list}>
          {rows.map((r) => (
            <li key={r.cc}>
              <button
                type="button"
                className="flex w-full cursor-default items-center gap-3 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                {...row(r.cc)}
              >
                <span className="flex size-6 shrink-0 items-center justify-center">
                  {FLAGS.has(r.cc.toLowerCase()) && <img className="h-3.5 w-5 rounded-[2px] shadow-[0_0_0_1px_var(--border)]" src={appPath(`/flags/${r.cc.toLowerCase()}.png`)} alt="" loading="lazy" />}
                </span>
                <span className={cn('min-w-0 flex-1 truncate', focus === r.cc && 'underline underline-offset-4')}>{regionLabel(r.cc)}</span>
                <span className="text-[length:var(--fs-2)] text-muted-foreground tnum">{t('public.count', { count: r.subs.length })}</span>
                <span className="w-24 text-right tnum">{amount(r)}</span>
              </button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

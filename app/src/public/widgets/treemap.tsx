import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../../../shared/i18n.ts';
import { spendingMap, spendTiles } from '../../../../shared/treemap.ts';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/public/components/ui/card';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/public/components/ui/tooltip';
import { CategoryLegend, clean, shade } from './lib.tsx';
import type { WidgetProps } from './props.ts';

/** 够写名字、够再写金额的最小尺寸（px）；再小的方块不写字，靠悬停看 */
const NAME_W = 64;
const NAME_H = 30;
const AMOUNT_H = 48;

/** 开销方块图：每个在用订阅一块，面积是每月开销，同一分类挨在一起、同一颜色 */
export function TreemapCard({ state, today, k, fmt }: WidgetProps) {
  const map = useMemo(() => spendingMap(state, today), [state, today]);
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tip, setTip] = useState<string>();
  const empty = !map.groups.length && !map.missing;
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [empty]);
  if (empty) return null;
  // k 为 0 是显示币种缺汇率：金额写占位，不写 0
  const amount = (v: number) => (k > 0 ? fmt(v * k) : '—');
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>{t('public.treemap.title')}</CardTitle>
        {map.missing > 0 && <CardDescription>{t('public.treemap.missing', { count: map.missing })}</CardDescription>}
      </CardHeader>
      <CardContent className="flex min-h-52 flex-1 flex-col gap-3">
        <div ref={box} className="relative min-h-52 flex-1 overflow-hidden">
          {!map.groups.length && <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">—</div>}
          {spendTiles(map.groups, size.w, size.h).map(({ sub, group, x, y, w, h }) => {
            const name = clean(sub.name);
            // 缺汇率的订阅不知道多少，占比的分母不准，不写
            const share = map.missing ? '—' : `${Math.round((sub.v / map.total) * 100)}%`;
            const labelled = w >= NAME_W && h >= NAME_H;
            return (
              <Tooltip key={sub.id} open={tip === sub.id} onOpenChange={(open) => setTip((cur) => (open ? sub.id : cur === sub.id ? undefined : cur))}>
                <TooltipTrigger asChild>
                  <div
                    role="img"
                    tabIndex={0}
                    aria-label={`${name} ${amount(sub.v)} ${share}`}
                    // 手机没有悬停：点一下显示，点别处收起。preventDefault 让 Radix 不在点击时关掉
                    onClick={(e) => {
                      e.preventDefault();
                      setTip(sub.id);
                    }}
                    className="absolute flex cursor-default flex-col overflow-hidden rounded-sm bg-[color-mix(in_srgb,var(--tile)_35%,var(--card))] px-2 py-1.5 text-[length:var(--fs-2)] leading-tight text-foreground transition-colors outline-none hover:bg-[color-mix(in_srgb,var(--tile)_50%,var(--card))] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    style={{ left: x, top: y, width: w, height: h, '--tile': shade(group.rank) } as React.CSSProperties}
                  >
                    {labelled && <span className="truncate font-medium">{name}</span>}
                    {labelled && h >= AMOUNT_H && <span className="truncate tnum">{amount(sub.v)}</span>}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium break-words">{name}</span>
                    {group.name && <span className="break-words opacity-70">{group.name}</span>}
                    <span className="flex justify-between gap-3 tnum">
                      <span>{k > 0 ? t('public.perMonth', { amount: amount(sub.v) }) : '—'}</span>
                      <span>{share}</span>
                    </span>
                  </div>
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
        <CategoryLegend names={map.groups.map((g) => g.name)} />
      </CardContent>
    </Card>
  );
}

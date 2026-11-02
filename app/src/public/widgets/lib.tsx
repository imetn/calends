import { useLayoutEffect, useRef, useState } from 'react';
import { flow } from '../../../../shared/format.ts';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/public/components/ui/tooltip';

/** 公开页去掉名字里的国旗 emoji，地区另有标签（与 page.tsx 同口径） */
export const clean = (name: string) => name.replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, ' ').replace(/\s+/g, ' ').trim();

/** 分类色的固定顺序（与「构成」卡同口径）：第五个之后都是最后一档 */
export const shade = (i: number) => `var(--c${[1, 4, 5, 6, 7][i] ?? 9})`;

/** 一笔支出：缺汇率时 value 是 NaN，显示「—」；不足 10 的保留分，免得出现 ¥0 */
export const outflow = (value: number, ccy: string) => flow(-value, ccy, { decimals: Math.abs(value) < 10 ? 2 : 0 });

export function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/** 提示内容：一行标题，下面是左右两列 */
export function TipBody({ head, total, rows }: { head: string; total?: string; rows: Array<{ key: string; label: string; value?: string }> }) {
  return (
    <div className="min-w-0">
      <div className="flex justify-between gap-4 font-medium tnum">
        <span>{head}</span>
        {total && <span>{total}</span>}
      </div>
      {rows.map((r) => (
        <div key={r.key} className="mt-0.5 flex justify-between gap-4 tnum opacity-80">
          <span className="min-w-0 truncate">{r.label}</span>
          {r.value && <span className="shrink-0">{r.value}</span>}
        </div>
      ))}
    </div>
  );
}

/** 悬停出提示；点按时也打开并保持（触屏没有悬停），点别处收起 */
export function Tip({ content, children }: { content: React.ReactNode; children: React.ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        asChild
        onPointerDown={(e: React.PointerEvent) => e.preventDefault()}
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          setOpen(true);
        }}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent sideOffset={4}>{content}</TooltipContent>
    </Tooltip>
  );
}

import { useLayoutEffect, useRef } from 'react';
import { currencyDecimals } from '../../../../shared/format.ts';
import NumberFlowElement, { define } from 'number-flow';

define('number-flow', NumberFlowElement);

/**
 * 滚动数字：直接驱动 NumberFlow 的 Web Component。
 * 官方 React 封装依赖 React 的属性处理，在 preact/compat 下不生效，所以这里用 ref 设属性。
 * 缺汇率算不出来时显示占位，不显示 NaN 或 0。
 */
export function Num({ value, prefix, suffix, ccy, digits = ccy ? currencyDecimals(ccy) : 0, className }: { value: number; prefix?: string; suffix?: string; digits?: number; ccy?: string; className?: string }) {
  const ref = useRef<NumberFlowElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.animated = false;
    el.locales = 'en-US';
    el.format = { maximumFractionDigits: ccy && currencyDecimals(ccy) === 0 ? 0 : digits, minimumFractionDigits: ccy && currencyDecimals(ccy) === 0 ? 0 : digits };
    el.numberPrefix = prefix;
    el.numberSuffix = suffix;
    el.update(value);
  }, [value, prefix, suffix, digits, ccy]);
  if (!Number.isFinite(value)) return <span className={className}>—</span>;
  return <number-flow ref={ref} className={className} />;
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'number-flow': React.DetailedHTMLProps<React.HTMLAttributes<NumberFlowElement>, NumberFlowElement>;
    }
  }
}

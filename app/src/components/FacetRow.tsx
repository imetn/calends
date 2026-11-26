import type { ReactNode } from 'react';
import { dragScroll } from '../drag-scroll.ts';

/** 一行筛选：左边维度名，右边「全部」+ 各选项胶囊（数量在胶囊内；没有匹配的隐藏，已选中的保留）；再点已选中的回到「全部」，一行放不下时横向滑动 */
export function FacetRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ key: string; label: string; n: number; icon?: ReactNode }>;
}) {
  return (
    <div className="facet-row">
      <span className="facet-label">{label}</span>
      <div className="facet-opts" ref={dragScroll}>
        {options
          .filter((o) => o.key === 'all' || o.n > 0 || o.key === value)
          .map((o) => (
            <button
              key={o.key}
              className={`facet ${value === o.key ? 'on' : ''} ${o.icon ? 'has-icon' : ''}`}
              aria-pressed={value === o.key}
              onClick={() => onChange(value === o.key && o.key !== 'all' ? 'all' : o.key)}
            >
              {o.icon}
              {o.label}
              <span className="n">×{o.n}</span>
            </button>
          ))}
      </div>
    </div>
  );
}

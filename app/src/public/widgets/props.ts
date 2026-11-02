import type { AppState } from '../../../../shared/types.ts';

/** 公开页组件拿到的数据：脱敏后的账本和当前显示币种 */
export interface WidgetProps {
  state: AppState;
  today: string;
  /** 访客选的显示币种 */
  ccy: string;
  /** 账本的基准币种 */
  base: string;
  /** 基准币种换算到显示币种的当前汇率。历史扣款不要乘它，用 sumBase(state, charges, ccy) */
  k: number;
  sym: string;
  fmt: (v: number) => string;
}

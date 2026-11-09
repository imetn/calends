import { numberFormat } from '../../../shared/intl.ts';
import './ui.css';
import type { JSX, ReactNode } from 'react';
import { SelectionIndicator, Switch as AriaSwitch, ToggleButton, ToggleButtonGroup } from 'react-aria-components';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { currencyDecimals, moneyDecimals, flowSign, symbol } from '../../../shared/format.ts';
import { intlLocale, t } from '../../../shared/i18n.ts';
import { toast as notify } from 'sonner';
import { Icon } from './icons.tsx';

/** 小组件式金额：小数位缩小 */
export function Amount({ value, ccy, compact, plain, decimals }: { value: number; ccy: string; compact?: boolean; plain?: boolean; decimals?: number }) {
  if (!Number.isFinite(value)) return <span className="amt">—</span>;
  const abs = Math.abs(value);
  const digits = moneyDecimals(value, ccy, { compact, decimals });
  // 整数分组和小数点都跟随当前语言（德语 1.234,56、法语 1 234,56），小数部分缩小显示
  const parts = numberFormat(intlLocale(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).formatToParts(abs);
  const int = parts
    .filter((p) => p.type !== 'decimal' && p.type !== 'fraction')
    .map((p) => p.value)
    .join('');
  const point = parts.find((p) => p.type === 'decimal')?.value;
  const dec = parts.find((p) => p.type === 'fraction')?.value;
  return (
    <span className="amt" style={!plain && value > 0 ? { color: 'var(--gain)' } : undefined}>
      {plain ? (value < 0 ? '−' : '') : flowSign(value)}
      <span className="cur">{symbol(ccy).trim()}</span>
      {int}
      {dec && (
        <small className="amt-fraction" style={{ color: 'inherit', opacity: 0.72 }}>
          {point}
          {dec}
        </small>
      )}
    </span>
  );
}

/** 分段控件：单选、不能取消；左右方向键切换（react-aria 的 ToggleButtonGroup） */
export function Seg<T extends string>({
  value,
  options,
  onChange,
  small,
  disabledKeys,
}: {
  value: T;
  options: Array<[T, ReactNode]>;
  onChange: (v: T) => void;
  small?: boolean;
  disabledKeys?: T[];
}) {
  return (
    <ToggleButtonGroup
      className={`seg ${small ? 'sm' : ''}`}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const k = [...keys][0];
        if (k != null && k !== value) onChange(k as T);
      }}
    >
      {options.map(([k, l]) => (
        <ToggleButton key={k} id={k} isDisabled={disabledKeys?.includes(k)} className={({ isSelected }) => (isSelected ? 'on' : '')}>
          <SelectionIndicator className="seg-thumb" />
          {l}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export const toNum = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));

/**
 * 数字输入：自己保存正在输入的文字（「12.」「0.0」），只把解析出的数字往外报，小数点不会被吞。
 * 正在输入时不被外部值覆盖；没在输入时外部改了值（如切换周期重算）就显示新值，失焦时按当前值整理
 */
export function NumInput({
  value,
  onValue,
  ccy,
  ...rest
}: { value: number | undefined; onValue: (n: number | undefined) => void; ccy?: string } & Omit<JSX.IntrinsicElements['input'], 'value' | 'onChange'>) {
  const shown = (v: number | undefined) => (v == null ? '' : String(v));
  const [text, setText] = useState(shown(value));
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);
  if (!Object.is(value, seen)) {
    setSeen(value);
    if (!focused && toNum(text) !== value) setText(shown(value));
  }
  return (
    <input
      inputMode={ccy && currencyDecimals(ccy) === 0 ? 'numeric' : 'decimal'}
      step={ccy ? 10 ** -currencyDecimals(ccy) : undefined}
      {...rest}
      value={text}
      onFocus={(e) => {
        setFocused(true);
        rest.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        if (toNum(text) !== value) setText(shown(value));
        rest.onBlur?.(e);
      }}
      onChange={(e) => {
        if (ccy && !acceptCurrencyInput(e.target.value, ccy)) return;
        setText(e.target.value);
        onValue(toNum(e.target.value));
      }}
    />
  );
}

/** 新输入的零小数金额拒绝小数；已有值与汇率计算结果不在这里改写。 */
export function acceptCurrencyInput(text: string, ccy: string): boolean {
  const n = toNum(text);
  if (currencyDecimals(ccy) === 0 && n != null && !Number.isInteger(n)) {
    notify.error(t('ui.error.wholeCurrency', { currency: ccy }));
    return false;
  }
  return true;
}

/** 保留字符串草稿语义的金额输入（空值、负号等由调用方校验）。 */
export function MoneyInput({ ccy, onChange, ...props }: { ccy: string } & JSX.IntrinsicElements['input']) {
  return (
    <input
      {...props}
      inputMode={currencyDecimals(ccy) === 0 ? 'numeric' : 'decimal'}
      step={10 ** -currencyDecimals(ccy)}
      onChange={(e) => {
        if (acceptCurrencyInput(e.target.value, ccy)) onChange?.(e);
      }}
    />
  );
}

/**
 * 防重复提交：保存进行中再点（双击、回车连按）不会再执行一次。返回 [进行中, 提交]；
 * 进行中时调用方把提交按钮设为 disabled（沿用按钮自身的禁用样式）。
 */
export function useSubmit(): [boolean, (fn: () => unknown) => Promise<void>] {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const submit = async (fn: () => unknown) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return [busy, submit];
}

/** 触屏为主：弹层打开时不自动聚焦搜索框，免得软键盘一下子顶上来；用户点进搜索框再输入 */
export const touchFirst = () => matchMedia('(pointer: coarse)').matches;

/** 媒体查询订阅按查询串缓存：同一查询在每次渲染里是同一个函数，React 不必反复退订再订阅 */
export const mediaSubscribers = new Map<string, (cb: () => void) => () => void>();

/** 订阅一个媒体查询（断点由调用处给出，各自保持原值）；服务端渲染时为 false */
export function useMedia(query: string): boolean {
  let subscribe = mediaSubscribers.get(query);
  if (!subscribe) {
    subscribe = (cb) => {
      const mq = matchMedia(query);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    };
    mediaSubscribers.set(query, subscribe);
  }
  return useSyncExternalStore(
    subscribe,
    () => matchMedia(query).matches,
    () => false,
  );
}

/** 跟踪元素的实际宽度（ResizeObserver）：图表按它布局，未测量前为 0 */
export function useWidth<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  const watching = useRef<{ el: T | null; ro?: ResizeObserver }>({ el: null });
  // 被测的元素可能条件渲染（如日历年视图没有月网格）：每次渲染后对一下，元素出现才监听、换了就重挂、没了就停
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === watching.current.el) return;
    watching.current.ro?.disconnect();
    watching.current = { el };
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    watching.current.ro = ro;
  });
  useEffect(() => () => watching.current.ro?.disconnect(), []);
  return [ref, w] as const;
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <AriaSwitch className="toggle" isSelected={checked} onChange={onChange} aria-label={label}>
      <i />
    </AriaSwitch>
  );
}

/**
 * 加减器：两端减一、加一，中间可以直接输入数字，后面带单位（如「3 天」「2 期」）。
 * 提醒提前天数、收款期数共用
 */
export function Stepper({
  value,
  onChange,
  label,
  unit,
  min = 0,
  max = 3660,
}: {
  value: number;
  onChange: (n: number) => void;
  label: string;
  unit: (n: number) => string;
  min?: number;
  max?: number;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
  const commit = (raw: string) => {
    setDraft(null);
    const n = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(n)) onChange(clamp(n));
  };
  return (
    <span className="days-stepper" role="group" aria-label={label}>
      <button type="button" aria-label="−1" disabled={value <= min} onClick={() => onChange(clamp(value - 1))}>
        <Icon name="minus" size={14} />
      </button>
      <input
        inputMode="numeric"
        aria-label={label}
        // 按上限位数定宽：席位只到两位数，不留四位数的空白，数字和单位在两个按钮间居中
        style={{ width: `${String(max).length}ch` }}
        value={draft ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value.replace(/\D/g, '').slice(0, String(max).length);
          setDraft(raw);
          if (raw) onChange(clamp(Number(raw)));
        }}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            onChange(clamp(value + (e.key === 'ArrowUp' ? 1 : -1)));
            setDraft(null);
          }
        }}
      />
      {unit(value) && <span className="days-unit">{unit(value)}</span>}
      <button type="button" aria-label="+1" disabled={value >= max} onClick={() => onChange(clamp(value + 1))}>
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

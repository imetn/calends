import { shouldGroupYears } from './year-ledger.ts';
import { Fragment, useState, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';
import type { AppState } from '../../../shared/types.ts';
import { chargeMethodId, chargeSources, type Charge } from '../../../shared/billing.ts';
import { money } from '../../../shared/format.ts';
import { PayBadge } from './marks.tsx';
import '../views/detail.css';

/**
 * 按年分组的收付款表：订阅详情的扣款记录、合租的收款与付款共用这一套。
 * 四列（日期 · 第二列 · 原币金额 · 折合本位币）；给了 extraHead 时在第二列后多一列（如代付的「当时成本」，窄时收起）。
 * 每年最多一条时平铺；任意一年多条时整表按年分组且默认全部折叠；没有合计行，总数在上方的指标卡里。
 * 年份行是小计：点一下展开或折叠这一年；表头点一下全部展开或全部收起。
 * 第二列默认是支付方式，窄时收起（keepSecond 时保留，如合租收款的成员）
 */
export function YearLedger<T>({
  items,
  dateOf,
  head,
  yearCells,
  row,
  rowKey,
  onRow,
  canOpen,
  rowClass,
  rowTitle,
  keepSecond = false,
  extraHead,
}: {
  /** 新的在前 */
  items: T[];
  dateOf: (x: T) => string;
  head: [string, string, string, string];
  /** 年份行的后几格：第二列、（多出的一列）、原币合计、本位币合计（baseClass 给本位币合计那一格） */
  yearCells: (list: T[]) => { second: ReactNode; extra?: ReactNode; orig: ReactNode; base: ReactNode; baseClass?: string };
  /** 数据行的各格 */
  row: (x: T) => { date: ReactNode; second: ReactNode; extra?: ReactNode; orig: ReactNode; base: ReactNode; baseClass?: string };
  rowKey: (x: T, i: number) => string;
  onRow?: (x: T) => void;
  /** 有 onRow 时哪些行能点开；缺省都能 */
  canOpen?: (x: T) => boolean;
  rowClass?: (x: T) => string;
  rowTitle?: (x: T) => string | undefined;
  keepSecond?: boolean;
  /** 第二列后多出的一列的表头；窄时收起 */
  extraHead?: string;
}) {
  const yearsOf = [...new Set(items.map((x) => dateOf(x).slice(0, 4)))];
  const grouped = shouldGroupYears(items, dateOf);
  const years = grouped ? yearsOf : [''];
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const inYear = (y: string) => items.filter((x) => dateOf(x).startsWith(y));
  const second = keepSecond ? 'dt-ledger-keep' : 'dt-ledger-pay';
  const cells = (
    <>
      <span>{head[0]}</span>
      <span className={second}>{head[1]}</span>
      {extraHead && <span className="dt-ledger-extra">{extraHead}</span>}
      <span>{head[2]}</span>
      <span>{head[3]}</span>
    </>
  );
  const allOpen = years.every((y) => open.has(y));
  return (
    <div className={`ld-table ld-receipts ld-out dt-ledger ${grouped ? 'ld-grouped' : ''} ${extraHead ? 'dt-ledger-5' : ''}`}>
      {grouped ? (
        <button
          type="button"
          className="ld-row ld-th ld-toggle table-head"
          aria-expanded={allOpen}
          aria-label={t(allOpen ? 'family.sheet.collapseAll' : 'family.sheet.expandAll')}
          onClick={() => setOpen(new Set(allOpen ? [] : years))}
        >
          {cells}
        </button>
      ) : (
        <div className="ld-row ld-th table-head">{cells}</div>
      )}
      {years.map((y) => {
        const list = inYear(y);
        const sum = yearCells(list);
        return (
          <Fragment key={y || 'all'}>
            {grouped && (
              <button
                type="button"
                className="ld-row ld-year"
                aria-expanded={open.has(y)}
                onClick={() => {
                  const next = new Set(open);
                  if (next.has(y)) next.delete(y);
                  else next.add(y);
                  setOpen(next);
                }}
              >
                <span className="ld-year-title">
                  <b>{t('calendar.yearTitle', { year: y })}</b>
                  <small>{t('detail.stats.count', { count: list.length })}</small>
                </span>
                <span className={second}>{sum.second}</span>
                {extraHead && <span className="dt-ledger-extra">{sum.extra}</span>}
                <span>{sum.orig}</span>
                <span className={sum.baseClass}>{sum.base}</span>
              </button>
            )}
            {(!grouped || open.has(y)) &&
              list.map((x, i) => {
                const r = row(x);
                const cells = (
                  <>
                    <span className="ld-date">{r.date}</span>
                    <span className={second}>{r.second}</span>
                    {extraHead && <span className="dt-ledger-extra">{r.extra}</span>}
                    <span className="o">{r.orig}</span>
                    <span className={`c ${r.baseClass ?? ''}`}>{r.base}</span>
                  </>
                );
                const key = rowKey(x, i);
                const props = { className: `ld-row dt-row ${rowClass?.(x) ?? ''}`, title: rowTitle?.(x) };
                // 不能点的行用普通元素：禁用按钮会被画成灰色，看起来像另一种字号和颜色
                return onRow && (canOpen?.(x) ?? true) ? (
                  <button key={key} type="button" {...props} onClick={() => onRow(x)}>
                    {cells}
                  </button>
                ) : (
                  <div key={key} {...props}>
                    {cells}
                  </div>
                );
              })}
          </Fragment>
        );
      })}
    </div>
  );
}

/** 年份行的支付方式：和明细行一样用胶囊；两种以内并排，更多时写前两种再加「+N」，悬停看全部 */
/** 年小计的原币列：按币种合计（按首次出现的顺序），每种一行 */
export function currencyTotals<T>(rows: T[], amountOf: (r: T) => { currency: string; amount: number }, fmt: (sum: number, ccy: string) => string): string {
  const sums = new Map<string, number>();
  for (const r of rows) {
    const { currency, amount } = amountOf(r);
    sums.set(currency, (sums.get(currency) ?? 0) + amount);
  }
  return [...sums].map(([ccy, sum]) => fmt(sum, ccy)).join('\n');
}

export function YearMethods({ ids, state, title }: { ids: string[]; state: AppState; title?: string }) {
  const methods = ids.map((id) => state.methods.find((m) => m.id === id));
  const shown = methods.slice(0, 2);
  const more = methods.length - shown.length;
  return (
    <span className="dt-pay-list" title={title ?? (methods.length > 1 ? methods.map((m) => m?.name ?? t('ui.method.none')).join('\n') : undefined)}>
      {shown.map((m, i) => (
        <PayBadge key={m?.id ?? `none-${i}`} m={m} />
      ))}
      {more > 0 && <span className="dt-pay-more">+{more}</span>}
    </span>
  );
}

/** 一组扣款用到的支付方式（拆分付款的各来源都算），供年份行的 YearMethods */
export const chargeMethodIds = (cs: Charge[]) => [...new Set(cs.flatMap((c) => chargeSources(c).map((x) => x.methodId ?? '')))];

/** 明细行的支付方式：一个来源是胶囊；拆分付款叠放各来源，悬停看每个来源付了多少 */
export function ChargeMethods({ c, state }: { c: Charge; state: AppState }) {
  if (!c.funding?.length) return <PayBadge m={state.methods.find((m) => m.id === chargeMethodId(c))} />;
  const title = c.funding
    .map((f) => `${state.methods.find((m) => m.id === f.methodId)?.name ?? t('ui.method.none')} ${money(Math.abs(f.amount), c.currency)}`)
    .join('\n');
  // 金额最大的来源排在最后，露出完整的名字
  const ids = [...c.funding].sort((a, b) => Math.abs(a.amount) - Math.abs(b.amount)).map((f) => f.methodId);
  return <YearMethods ids={ids} state={state} title={`${t('editor.payment.split')}\n${title}`} />;
}

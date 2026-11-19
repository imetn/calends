import { amountTotal, chargesTotal, formatTotal, sumTotals } from '../../../../shared/fx-total.ts';
import { copyParts } from '../../components/copy.tsx';
import { ChargeMethods, chargeMethodIds, currencyTotals, YearLedger, YearMethods } from '../../components/YearLedger.tsx';
import { Plus } from 'lucide-react';
import { chargeDay, chargeServicePeriod, isPostpaid, isSeparate, type Charge } from '../../../../shared/billing.ts';
import { meterDecimals, meterRows, meterView } from '../../../../shared/meters.ts';
import { chargesUsage, chargeUsage, fixedQty, periodLabel, withUnit } from './ChargeTip.tsx';
import { flow, cnDate, cnDateFull, wholeCurrencies, wholeOpts } from '../../../../shared/format.ts';
import { transfersOf, transferSign, transferValue } from '../../../../shared/transfers.ts';
import { chargeBaseOrNaN } from '../../../../shared/fx.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { t } from '../../../../shared/i18n.ts';
import { Panel } from '../../components/DetailKit.tsx';

/**
 * 转让收付：二手买入付给原主的钱、卖出收到的钱，与扣款记录同一张表（日期 · 类型 · 原币 · 折合）；
 * 金额只在这里出现，顶部「净花费」只写合计。买入是支出（负），卖出是收入（正）
 */
export function Transfers({ sub, state, onRow, onAdd }: { sub: Subscription; state: AppState; onRow?: (index: number) => void; onAdd?: () => void }) {
  const base = state.settings.baseCurrency;
  const list = sub.transfers ?? [];
  if (!list.length) return null;
  const rows = transfersOf(sub)
    .map((tr) => ({ tr, index: list.indexOf(tr), v: -transferSign(tr) * transferValue(state, tr, base) }))
    .reverse();
  return (
    <Panel
      className="dt-charges dt-transfers"
      title={t('detail.transfer.title')}
      aside={
        onAdd && (
          <button className="dt-btn sm dt-add" onClick={onAdd} title={t('detail.transfer.addTitle')}>
            <Plus size={14} /> {t('detail.charges.addShort')}
          </button>
        )
      }
    >
      <YearLedger
        items={rows}
        dateOf={(r) => r.tr.date}
        keepSecond
        head={[
          t('detail.transfer.head.date'),
          t('detail.transfer.kind.label'),
          t('detail.transfer.head.amount'),
          t('detail.transfer.head.base', { ccy: base }),
        ]}
        yearCells={(ys) => {
          const total = ys.reduce((a, r) => a + r.v, 0);
          // 一年里都是同一种（通常只有一笔）时照样标出买入 / 卖出
          const kinds = new Set(ys.map((r) => r.tr.kind));
          const kind = kinds.size === 1 ? ys[0].tr.kind : undefined;
          return {
            second: kind ? <span className={`dt-kind transfer ${kind}`}>{t(`detail.transfer.kind.${kind}`)}</span> : null,
            orig: copyParts(currencyTotals(ys, (r) => ({ currency: r.tr.currency, amount: -transferSign(r.tr) * r.tr.amount }), flow)),
            base: formatTotal(sumTotals(ys.map((r) => amountTotal(-transferSign(r.tr) * r.tr.amount, r.tr.currency, r.v))), base, { direction: 1 }),
            baseClass: total > 0 ? 'dt-in' : undefined,
          };
        }}
        row={({ tr, v }) => ({
          date: <time dateTime={tr.date}>{cnDateFull(tr.date)}</time>,
          second: <span className={`dt-kind transfer ${tr.kind}`}>{t(`detail.transfer.kind.${tr.kind}`)}</span>,
          orig: flow(-transferSign(tr) * tr.amount, tr.currency, Number.isInteger(tr.amount) ? { decimals: 0 } : {}),
          base: Number.isFinite(v) ? flow(v, base) : '—',
          baseClass: v > 0 ? 'dt-in' : undefined,
        })}
        rowKey={({ index }) => `t${index}`}
        rowTitle={({ tr }) => tr.note}
        onRow={onRow && (({ index }) => onRow(index))}
      />
    </Panel>
  );
}

/** 一笔缴费结清的账单：首期 – 末期；都与缴费同年时省略年份，否则首末都写年份 */
export function settlesLabel(settles: string[], paid: string) {
  const same = settles.every((d) => d.slice(0, 4) === paid.slice(0, 4));
  const day = (d: string) => (same ? cnDate(d) : cnDateFull(d));
  return settles.length > 1 ? `${day(settles[0])} – ${day(settles[settles.length - 1])}` : day(settles[0]);
}

/** 扣款记录：按年分组（组头带合计），扣款日 · 支付方式 · 卡上实扣，第四列按币种与计费方式取当时成本、用量、缴费日或服务期；点一行改这笔 */
export function Charges({
  sub,
  state,
  today,
  history,
  onRow,
  onAdd,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  history: Charge[];
  onRow?: (c: Charge) => void;
  onAdd?: () => void;
}) {
  const base = state.settings.baseCurrency;
  // 缺汇率的一笔本位币金额为 NaN：行内与年小计显示「—」，不按 0 合计
  const rows = history.map((c) => ({ c, b: chargeBaseOrNaN(state, c, base) })).reverse();
  // 卡上实扣的原币：这张表里某个币种的金额都是整数（如奈拉、日元整价扣款）就不写 .00，省出宽度；
  // 当时成本按同一规则看本位币金额，同一行两列写法一致
  // 卡上实扣：记了卡上实际扣的币种与金额（Payment.settled、代付的实扣）就写它，否则是订阅原价
  const card = (c: Charge) => (c.settled && !c.projected ? c.settled : c);
  const whole = wholeCurrencies(history.map(card));
  const orig = (v: number, ccy: string) => flow(v, ccy, wholeOpts(v, ccy, whole));
  const wholeBase = wholeCurrencies(rows.map((r) => ({ amount: r.b, currency: base })));
  const cost = (v: number) => flow(v, base, wholeOpts(v, base, wholeBase));
  // 有用量指标时多一列：每笔扣款覆盖的服务期内记下的用量（第一个指标），失败、退款不算；窄屏收起
  const usageSub = meterView(sub, state.subscriptions);
  const meter = usageSub.meters?.[0];
  const readings = meter && sub.cycle.unit !== 'lifetime' ? meterRows(usageSub, meter, today) : undefined;
  const usageOf = (c: Charge) => chargeUsage(readings, c);
  // 分开记的实际缴费（带 settles）按缴费日列，不按所属周期
  const post = (c: Charge) => !c.kind && !c.settles && isPostpaid(c.sub);
  // 表头按行走：周期账单全是后付费时写「周期」，与预付费阶段混在一起时写「日期」
  const regular = rows.filter((r) => !r.c.kind);
  const usageFmt = meter && fixedQty(meterDecimals(usageSub, meter.id));
  const usageCell = (v: number | undefined) => (v != null ? withUnit(v, meter!.unit, usageFmt) : '—');
  // 前三列固定（日期 · 支付方式 · 卡上实扣），第四列看情况：
  // 有一笔不是本位币时写当时成本；全是本位币时成本与实扣是同一个数，换成用量、缴费日或服务期，都没有时只留三列
  const postMode = regular.length > 0 && regular.every((r) => post(r.c));
  const periodOf = (c: Charge) =>
    c.kind || c.settles || post(c) || c.sub.cycle.unit === 'lifetime' ? undefined : chargeServicePeriod(c.sub, c.date, c.serviceDate);
  const fourth: 'cost' | 'usage' | 'paid' | 'service' | undefined = rows.some((r) => card(r.c).currency !== base)
    ? 'cost'
    : readings
      ? 'usage'
      : postMode
        ? 'paid'
        : rows.some((r) => periodOf(r.c))
          ? 'service'
          : undefined;
  // 起止日各自不断开，列窄时在「–」后换行
  const rangeCell = (label: string) => {
    const [a, b] = label.split(' – ');
    return b == null ? (
      label
    ) : (
      <>
        <span className="dt-nw">{a} –</span> <span className="dt-nw">{b}</span>
      </>
    );
  };
  const yearRange = (cs: Charge[]) => {
    const ps = cs.map(periodOf).filter((p) => !!p);
    if (!ps.length) return null;
    const from = ps.reduce((a, p) => (p.from < a ? p.from : a), ps[0].from);
    const until = ps.reduce((a, p) => (p.until > a ? p.until : a), ps[0].until);
    return rangeCell(periodLabel({ from, until }, today));
  };
  return (
    <Panel
      // 还没有记录时只是一条带「记一笔」的细条，不进列表网格被拉高
      className="dt-charges"
      title={t('detail.charges.title')}
      // 记一笔放在标题右侧，不额外占一行
      aside={
        onAdd && (
          <button className="dt-btn sm dt-add" onClick={onAdd} title={t('detail.charges.add')}>
            <Plus size={14} /> {t('detail.charges.addShort')}
          </button>
        )
      }
    >
      {sub.estimateFrom && !history.length && <p className="muted dt-import-note">{t('settings.import.history')}</p>}
      {/* 与合租的收款、付款表同一套表格（YearLedger）：表头、按年分组带小计、日期写全 */}
      {history.length > 0 && (
        <YearLedger
          items={rows}
          // 后付费的周期账单按所属周期分年（12 月电费次年 1 月交，仍归当年）
          dateOf={(r) => chargeDay(r.c)}
          head={[
            t(regular.length && regular.every((r) => post(r.c)) ? 'detail.chart.period' : 'proxy.table.date'),
            t('detail.field.method'),
            t('proxy.table.charged'),
            fourth === 'cost'
              ? t('proxy.table.cost')
              : fourth === 'usage'
                ? meter!.name
                : fourth === 'paid'
                  ? t('detail.charges.head.paid')
                  : fourth === 'service'
                    ? t('detail.charges.head.service')
                    : undefined,
          ]}
          extraHead={fourth === 'cost' && readings ? meter!.name : undefined}
          textLast={fourth === 'paid' || fourth === 'service'}
          yearCells={(ys) => {
            const total = ys.reduce((a, r) => a + r.b, 0);
            return {
              // 这一年用过的支付方式：一种时与下面的行一样写胶囊，几种时把卡的图标叠在一起
              second: <YearMethods ids={chargeMethodIds(ys.map((r) => r.c))} state={state} />,
              extra:
                readings &&
                usageCell(
                  chargesUsage(
                    readings,
                    ys.map((r) => r.c),
                  ),
                ),
              // 卡上实扣按原币合计；一年里有几种币种时逐个列出，不留空
              orig: copyParts(
                currencyTotals(
                  ys,
                  (r) => card(r.c),
                  (sum, ccy) => orig(-sum, ccy),
                ),
              ),
              base:
                fourth === 'cost'
                  ? formatTotal(
                      chargesTotal(
                        state,
                        ys.map((r) => r.c),
                      ),
                      base,
                      { direction: -1, ...(wholeBase.has(base) ? { decimals: 0 } : {}) },
                    )
                  : fourth === 'usage'
                    ? usageCell(
                        chargesUsage(
                          readings,
                          ys.map((r) => r.c),
                        ),
                      )
                    : fourth === 'service'
                      ? yearRange(ys.map((r) => r.c))
                      : null,
              // 净退款记绿色：有当时成本时标在成本上，没有时标在卡上实扣上
              origClass: fourth !== 'cost' && total < 0 ? 'dt-in' : undefined,
              baseClass: fourth === 'cost' && total < 0 ? 'dt-in' : undefined,
            };
          }}
          row={({ c, b }) => ({
            // 日期写全，不再加「几天前」；后付费的周期账单写所属周期，扣款日放进悬停提示，不加第二行撑高行
            date: post(c) ? (
              <time dateTime={chargeDay(c)}>{periodLabel(chargeServicePeriod(c.sub, c.date, c.serviceDate), today)}</time>
            ) : (
              <time dateTime={c.date}>{cnDateFull(c.date)}</time>
            ),
            second: <ChargeMethods c={c} state={state} />,
            extra: readings && usageCell(usageOf(c)),
            orig: (
              <>
                {orig(-card(c).amount, card(c).currency)}
                {c.kind && <em className={`dt-kind ${c.kind}`}>{t(`detail.charges.kind.${c.kind}`)}</em>}
                {/* 账单与缴费分开记：这笔缴的是哪几期账单（首期 – 末期），固定在金额下一行；逐期写在悬停提示里 */}
                {!!c.settles?.length && <small className="dt-settles">{settlesLabel(c.settles, c.date)}</small>}
              </>
            ),
            base:
              fourth === 'cost' ? (
                Number.isFinite(b) ? (
                  cost(-b)
                ) : (
                  '—'
                )
              ) : fourth === 'usage' ? (
                usageCell(usageOf(c))
              ) : fourth === 'paid' ? (
                post(c) && !c.settles ? (
                  <time dateTime={c.date}>{cnDateFull(c.date)}</time>
                ) : null
              ) : fourth === 'service' ? (
                (() => {
                  const p = periodOf(c);
                  return p ? rangeCell(periodLabel(p, today)) : null;
                })()
              ) : null,
            origClass: fourth !== 'cost' && b < 0 ? 'dt-in' : undefined,
            baseClass: fourth === 'cost' && b < 0 ? 'dt-in' : undefined,
          })}
          rowKey={({ c }, i) => `${c.date}-${c.sub.start}-${i}`}
          rowClass={({ c }) => c.kind ?? ''}
          rowTitle={({ c }) =>
            post(c) && !c.settles && fourth !== 'paid'
              ? [t('detail.charges.paidOn', { date: cnDateFull(c.date) }), c.note].filter(Boolean).join('\n')
              : c.settles?.length
                ? [c.settles.map((d) => cnDateFull(d)).join('\n'), c.note].filter(Boolean).join('\n')
                : c.note
          }
          onRow={onRow && (({ c }) => onRow(c))}
          // 分开记时推算期视为已缴的那几行不是真实缴费，没有可改的记录
          canOpen={({ c }) => !isSeparate(c.sub) || !!c.kind || !!c.paidOn}
        />
      )}
    </Panel>
  );
}

import { durationLabel } from '../../../shared/billing.ts';
import { addDays, coveredUntil, cycleLabel, diffDays, isGap, isPostpaid, phaseLanes, phaseSubs } from '../../../shared/billing.ts';
import { cnDateFull, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { pricePoints } from '../../../shared/phases.ts';
import { DatePicker } from './DatePicker.tsx';
import { PayBadge } from './marks.tsx';

/**
 * 订阅历程：阶段（地区/币种/价格/支付方式）、阶段内调价、断更空档。
 * 时间上重叠的阶段（换区后旧区域还没到期）画在第二条轨道上，并标出并行了多少天；
 * 编辑页用 onStart / onEnd 修改边界；只读页仍显示日期文本
 */
export function History({
  sub,
  state,
  today,
  onEnd,
  onStart,
  onPrice,
  priceEditor,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  onStart?: (start: string, next: string) => void;
  onEnd?: (start: string, end: string | undefined) => void;
  onPrice?: (start: string, from: string) => void;
  priceEditor?: { start: string; from: string; content: React.ReactNode };
}) {
  const vs = phaseSubs(sub);
  const hasStory = vs.length > 1 || (vs[0].priceHistory?.length ?? 0) > 1;
  if (!hasStory && !onStart) return null;
  const method = (id?: string) => state.methods.find((m) => m.id === id);
  const lanes = phaseLanes(vs);
  const laned = lanes.some((l) => l > 0);
  const editable = !!onStart || (!!onEnd && !!sub.phases?.length);
  const items: React.JSX.Element[] = [];
  vs.forEach((v, i) => {
    // 断更看前面各段最晚跑到哪天：并行的旧段还没到期就不算断
    const until = coveredUntil(vs, i);
    if (i > 0 && isGap(until, v.start)) {
      items.push(
        <li key={`gap${i}`} className="h-gap">
          <span>{durationLabel(diffDays(until!, v.start), 'gap')}</span>
        </li>,
      );
    }
    const parallel = i > 0 && until && until > v.start ? diffDays(v.start, v.end && v.end < until ? v.end : until) : 0;
    const live = !v.end || v.end > today;
    const hist = pricePoints(v);
    const showPrices = hist.length > 1 || !!onPrice;
    const raw = sub.phases?.find((p) => p.start === v.start);
    const isLast = i === vs.length - 1;
    items.push(
      <li
        key={`p${i}`}
        style={{ '--h-lane': lanes[i] } as React.CSSProperties}
        className={`h-phase ${live && v.start <= today ? 'now' : ''} ${lanes[i] > 0 ? 'lane' : ''} ${editable ? 'edit' : ''}`}
      >
        {editable ? (
          <div className="h-range h-edit">
            {onStart ? (
              <DatePicker compact value={v.start} ariaLabel={t('editor.field.start')} onChange={(d) => d && onStart(v.start, d)} />
            ) : (
              <span>{cnDateFull(v.start)}</span>
            )}
            <span aria-hidden="true">→</span>
            {!v.stop && onEnd ? (
              <DatePicker
                compact
                ariaLabel={t('editor.field.end')}
                value={raw?.end ?? (!sub.phases?.length ? sub.end : undefined)}
                clearable
                min={addDays(v.start, 1)}
                placeholder={isLast ? t('editor.history.now') : t('editor.overlap.endAuto')}
                onChange={(d) => onEnd(v.start, d)}
              />
            ) : (
              <span>{v.end ? cnDateFull(v.end) : t('editor.history.now')}</span>
            )}
            {v.planned && <span className="badge">{t('editor.overlap.planned')}</span>}
          </div>
        ) : (
          <div className="h-range">
            {v.start > today
              ? v.end
                ? t('editor.history.plannedRange', { start: cnDateFull(v.start), end: cnDateFull(v.end) })
                : t('editor.history.plannedFrom', { start: cnDateFull(v.start) })
              : t('editor.history.range', { start: cnDateFull(v.start), end: v.end ? cnDateFull(v.end) : t('editor.history.now') })}
          </div>
        )}
        <div className="h-plan">
          {v.region && <span className="badge">{v.region}</span>}
          {!showPrices && <b>{money(v.price, v.currency)}</b>} {cycleLabel(v.cycle)}
          {isPostpaid(v) && <span className="badge">{t('detail.billing.postpaid')}</span>}
          {method(v.methodId) && <PayBadge m={method(v.methodId)} />}
          {parallel > 0 && <span className="badge blue h-par">{t('editor.overlap.parallel', { count: parallel })}</span>}
        </div>
        {showPrices && (
          <ul className="h-prices">
            {hist
              .map((p, k) => {
                const label = k === 0 ? t('editor.history.initial') : cnDateFull(p.from);
                const content = (
                  <>
                    <span className="h-price-date">{label}</span>
                    <b>{money(p.amount, v.currency)}</b>
                    {k > 0 && hist[k - 1].amount > 0 && p.amount !== hist[k - 1].amount && (
                      <em className={p.amount > hist[k - 1].amount ? 'up' : 'down'}>
                        {p.amount > hist[k - 1].amount ? '+' : ''}
                        {Math.round(((p.amount - hist[k - 1].amount) / hist[k - 1].amount) * 100)}%
                      </em>
                    )}
                  </>
                );
                return (
                  <li key={priceEditor?.start === v.start && priceEditor.from === p.from ? 'editing' : p.from}>
                    {onPrice ? (
                      <button
                        className="h-price-row"
                        onClick={() => onPrice(v.start, p.from)}
                        aria-label={t('editor.history.editPrice', { date: p.from })}
                        aria-expanded={priceEditor?.start === v.start && priceEditor.from === p.from}
                      >
                        {content}
                      </button>
                    ) : (
                      <div className="h-price-row">{content}</div>
                    )}
                    {priceEditor?.start === v.start && priceEditor.from === p.from && priceEditor.content}
                  </li>
                );
              })
              .reverse()}
          </ul>
        )}
      </li>,
    );
  });
  return (
    <ol style={{ '--h-padding': `${34 + Math.max(...lanes) * 14}px` } as React.CSSProperties} className={`history ${laned ? 'laned' : ''}`}>
      {items.reverse()}
    </ol>
  );
}

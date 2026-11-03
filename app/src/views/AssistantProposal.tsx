import { copyParts } from '../components/copy.tsx';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { CircleX, Check, CircleAlert, Loader2, Pencil, ReceiptText } from 'lucide-react';
import { cycleLabel, collectCurrencyOf } from '../../../shared/billing.ts';
import { flow, billLabel, cnDate, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { PayBadge, SubIcon } from '../components/marks.tsx';
import { catColor } from '../derive.ts';
import { isDateField, proposalDay } from './assistant-fields.ts';
import './assistant.css';
import type { Part } from './assistant-chat.ts';

/** 草稿卡片：新增订阅时显示图标、名称、价格与接下来的扣款；其他写操作显示要改的内容 */
/** 各写操作的草稿内容：用人话把参数列出来（标签与取值都本地化） */
export function summaryRows(
  tool: string,
  a: Record<string, unknown>,
  state: AppState,
  subCcy?: string,
  preview?: Record<string, unknown>,
): Array<[string, ReactNode]> {
  const rows: Array<[string, ReactNode]> = [];
  const add = (label: string, v: ReactNode | undefined | null | false) => {
    if (v !== undefined && v !== null && v !== false && v !== '') rows.push([label, v]);
  };
  const day = proposalDay;
  const collect = collectCurrencyOf(state.settings);
  const method = (v: unknown) => state.methods.find((m) => m.id === v || m.name === v);
  switch (tool) {
    case 'record_receivable': {
      // 预览里带着写入后的那一笔：抵扣哪几期、金额（没写金额时按应收算出来的）
      const r = preview?.after as { periods?: string[]; amount?: number; currency?: string; date?: string } | null | undefined;
      const action = String(a.action ?? 'record');
      add(t('receivable.action'), t(`receivable.actions.${action}`));
      add(t('assistant.f.member'), a.member ? String(a.member) : a.person ? String(a.person) : undefined);
      if (action === 'charged') {
        add(t('proxy.table.date'), day(a.charge));
        add(
          t('proxy.table.charged'),
          a.charged_amount != null ? money(Number(a.charged_amount), String(a.charged_currency ?? subCcy ?? collect)) : t('receivable.chargedClear'),
        );
        break;
      }
      const keys = r?.periods ?? (Array.isArray(a.periods) ? (a.periods as string[]) : undefined);
      add(
        t('receivable.periods'),
        keys ? keys.map((k) => cnDate(k)).join('\n') : a.count ? t('receivable.periodsCount', { count: Number(a.count) }) : undefined,
      );
      if (action !== 'delete' && action !== 'waive') {
        const amount = r?.amount ?? (a.amount != null ? Number(a.amount) : undefined);
        add(t('assistant.f.amount'), amount != null ? <span className="green">{flow(amount, String(r?.currency ?? a.currency ?? collect))}</span> : undefined);
      }
      if (action !== 'delete') add(t('assistant.f.date'), day(r?.date ?? a.date) ?? t('assistant.card.today'));
      add(t('receivable.note'), a.note ? String(a.note) : undefined);
      break;
    }
    case 'save_share_member':
      add(t('assistant.f.member'), String(a.name ?? a.member ?? ''));
      add(
        t('assistant.f.fee'),
        a.exempt
          ? t('assistant.v.exempt')
          : a.fee != null
            ? `${money(Number(a.fee), String(a.fee_currency ?? collect))}\n${billLabel(Number(a.bill_every ?? 1))}`
            : undefined,
      );
      add(t('assistant.f.paidUntil'), day(a.paid_until));
      add(t('family.member.firstPeriod'), a.first_period ? t(`family.member.firstMode.${String(a.first_period)}`) : undefined);
      add(t('family.member.firstAmount'), a.first_amount != null ? money(Number(a.first_amount), String(a.fee_currency ?? collect)) : undefined);
      add(t('assistant.f.joined'), day(a.joined));
      add(t('assistant.f.left'), a.left === null ? t('family.member.notSet') : day(a.left));
      if ('leave_refund' in a || a.left === null) {
        const r = a.leave_refund as { amount: number; currency?: string; date?: string; note?: string } | null;
        const actual = (preview?.member as { leave_refund?: { currency: string; date: string } } | undefined)?.leave_refund;
        const suggested = preview?.suggested_refund as { currency?: string } | undefined;
        add(t('family.refund.title'), r ? flow(-r.amount, r.currency ?? actual?.currency ?? suggested?.currency ?? collect) : t('family.refund.none'));
        if (r) {
          add(t('family.refund.date'), day(r.date ?? actual?.date ?? a.left));
          add(t('family.member.note'), r.note);
        }
      }
      add(t('assistant.f.contact'), [a.contact_via, a.contact].filter(Boolean).join(' ') || undefined);
      break;
    case 'remove_share_member':
      add(t('assistant.f.member'), String(a.member ?? ''));
      break;
    case 'set_share':
      add(t('assistant.f.role'), t(`assistant.v.${a.role === 'member' ? 'member' : a.role === 'none' ? 'unshare' : 'owner'}`));
      add(t('assistant.f.seats'), a.seats != null ? String(a.seats) : undefined);
      add(t('assistant.f.ownerName'), a.owner_name ? String(a.owner_name) : undefined);
      add(t('assistant.f.since'), day(a.since));
      add(t('family.member.collectionAnchor'), day(a.collect_from));
      break;
    case 'change_price':
      add(t('assistant.f.newPrice'), a.amount != null ? money(Number(a.amount), subCcy ?? state.settings.baseCurrency) : undefined);
      add(t('assistant.f.from'), day(a.from) ?? t('assistant.card.today'));
      break;
    case 'set_status':
      add(t('assistant.f.action'), t(`assistant.v.${String(a.action)}`));
      add(t('assistant.f.date'), a.at === null ? t('assistant.v.dateUnknown') : day(a.at));
      break;
    case 'save_subscription': {
      const rec = (a.subscription ?? {}) as Partial<Subscription>;
      const computed = (preview?.computed as { after?: { next_charge?: string | null; spent_total?: { amount: number | null; currency: string } } } | undefined)
        ?.after;
      const pays = [...(rec.payments ?? []), ...(rec.phases ?? []).flatMap((p) => p.payments ?? [])];
      if (rec.status === 'cancelled' || rec.status === 'terminated')
        add(t(`assistant.v.${rec.status === 'terminated' ? 'terminate' : 'cancel'}`), day(rec.stop?.date ?? rec.end) ?? t('assistant.v.dateUnknown'));
      add(t('assistant.f.phases'), rec.phases?.length ? String(rec.phases.length) : undefined);
      add(t('assistant.f.payments'), pays.length ? String(pays.length) : undefined);
      add(t('assistant.f.spent'), computed?.spent_total?.amount != null ? money(computed.spent_total.amount, computed.spent_total.currency) : undefined);
      add(t('assistant.f.next_due'), day(computed?.next_charge));
      add(t('assistant.f.changes'), Array.isArray(preview?.changes) ? String(preview.changes.length) : undefined);
      break;
    }
    case 'record_payment':
      add(t('assistant.f.kind'), a.kind && a.kind !== 'charge' ? t(`detail.charges.kind.${String(a.kind)}`) : t('assistant.v.charge'));
      add(
        t('assistant.f.amount'),
        a.amount != null ? (
          <span className={a.kind === 'refund' ? 'green' : undefined}>
            {flow(a.kind === 'refund' ? Math.abs(Number(a.amount)) : -Number(a.amount), subCcy ?? state.settings.baseCurrency)}
          </span>
        ) : undefined,
      );
      add(t('assistant.f.date'), day(a.date) ?? t('assistant.card.today'));
      if (Array.isArray(a.funding))
        add(
          t('assistant.f.funding'),
          (a.funding as Array<{ method: string; amount: number }>)
            .map((f) => `${method(f.method)?.name ?? f.method} ${money(Number(f.amount), subCcy ?? state.settings.baseCurrency)}`)
            .join('\n'),
        );
      break;
    case 'record_transfer': {
      const del = a.delete as { date?: string } | undefined;
      if (del) {
        add(t('assistant.f.effect'), t('detail.transfer.deleted'));
        add(t('assistant.f.date'), day(del.date));
        break;
      }
      add(t('assistant.f.kind'), a.kind === 'sell' ? t('detail.transfer.kind.sell') : t('detail.transfer.kind.buy'));
      add(
        t('assistant.f.amount'),
        a.amount != null ? (
          <span className={a.kind === 'sell' ? 'green' : undefined}>
            {flow(
              a.kind === 'sell' ? Math.abs(Number(a.amount)) : -Math.abs(Number(a.amount)),
              String(a.currency ?? subCcy ?? state.settings.baseCurrency).toUpperCase(),
            )}
          </span>
        ) : undefined,
      );
      add(t('assistant.f.date'), day(a.date) ?? t('assistant.card.today'));
      break;
    }
    case 'set_meters': {
      const list = (a.meters as Array<{ name?: string; unit?: string; link?: { subscription?: string; meter?: string } }> | undefined) ?? [];
      const remove = (a.remove as string[] | undefined) ?? [];
      const meterLine = (m: (typeof list)[number]) => {
        if (m.link) {
          const owner = state.subscriptions.find((s) => s.id === m.link!.subscription || s.name === m.link!.subscription);
          const source = owner?.meters?.find((x) => x.id === m.link!.meter)?.name ?? m.link.meter ?? '';
          return `${source} (${t('detail.meters.linkFrom', { name: owner?.name ?? m.link.subscription ?? '' })})`;
        }
        return m.unit ? `${m.name ?? ''} (${m.unit})` : (m.name ?? '');
      };
      if (list.length) add(t('detail.meters.manageTitle'), list.map(meterLine).join('\n'));
      if (remove.length) add(t('assistant.f.effect'), t('detail.meters.removeMeters'));
      break;
    }
    case 'add_readings': {
      const list = (a.readings as Array<{ date?: string }> | undefined) ?? [];
      const del = (a.delete as string[] | undefined) ?? [];
      if (list.length) {
        add(t('detail.meters.title'), t('detail.meters.readingsCount', { n: list.length }));
        const days = list.map((r) => String(r.date ?? '')).sort();
        add(t('assistant.f.date'), days.length > 1 ? `${day(days[0])} – ${day(days.at(-1))}` : day(days[0]));
      }
      if (del.length) add(t('assistant.f.effect'), t('detail.meters.deleteReadings', { n: del.length }));
      break;
    }
    case 'delete_subscription':
      add(t('assistant.f.effect'), t('assistant.v.deleteAll'));
      break;
    default: {
      // update_subscription / change_plan 等：逐项列出要改的字段
      const set = (a.set && typeof a.set === 'object' ? a.set : a.plan && typeof a.plan === 'object' ? a.plan : a) as Record<string, unknown>;
      for (const [k, v] of Object.entries(set)) {
        if (['subscription', 'id', 'force', 'dry_run', 'set', 'plan'].includes(k)) continue;
        const label = t(`assistant.f.${k}`) === `assistant.f.${k}` ? k : t(`assistant.f.${k}`);
        const val =
          k === 'method'
            ? (method(v)?.name ?? String(v))
            : isDateField(k)
              ? day(v)
              : Array.isArray(v)
                ? v.join('、')
                : typeof v === 'object'
                  ? JSON.stringify(v)
                  : String(v);
        add(label, val);
      }
      if (tool === 'change_plan') add(t('assistant.f.from'), day(a.at));
    }
  }
  return rows;
}

export function Proposal(props: {
  disabled: boolean;
  siblings: Array<{ tool: string; args: Record<string, unknown> }>;
  part: Extract<Part, { kind: 'proposal' }>;
  state: AppState;
  onApply: () => void;
  onEdit: () => void;
  onDismiss: () => void;
  onOpen: (id: string) => void;
}) {
  const { part, state } = props;
  const a = part.args;
  const create = part.tool === 'create_subscription';
  const sub = part.preview.subscription;
  const name = String(
    a.name ?? sub?.name ?? (a.set as { name?: string } | undefined)?.name ?? a.method ?? a.person ?? a.category ?? t(`mcp.tool.${part.tool}`),
  );
  const sib = props.siblings.find((x) => x.tool === 'create_subscription' && x.args.id && x.args.id === sub?.id)?.args;
  const sibling = sib ? { icon: sib.icon ? String(sib.icon) : undefined, url: sib.url ? String(sib.url) : undefined } : undefined;
  const icon: Pick<Subscription, 'name' | 'icon' | 'url' | 'category'> = {
    name,
    // 同一轮先建的订阅还没保存时，从那张新建草稿里取图标和链接
    icon: a.icon ? String(a.icon) : (state.subscriptions.find((s) => s.id === sub?.id)?.icon ?? sibling?.icon),
    url: a.url ? String(a.url) : (state.subscriptions.find((s) => s.id === sub?.id)?.url ?? sibling?.url),
    category: String(a.category ?? sub?.category ?? ''),
  };
  const cyc = a.cycle as { unit: Subscription['cycle']['unit']; every?: number } | undefined;
  const history = create && Array.isArray(a.payments) ? (a.payments as Array<{ amount: number }>) : [];
  // method=null 明确不绑定支付方式，卡片上不显示默认卡
  const method =
    state.methods.find((m) => m.id === a.method || m.name === a.method) ??
    (create && a.method !== null ? state.methods.find((m) => m.id === state.settings.defaultMethodId) : undefined);
  const done = part.state === 'applied';
  const destructive =
    part.tool === 'delete_subscription' ||
    part.tool === 'delete_payment' ||
    (part.tool === 'record_transfer' && !!a.delete) ||
    (part.tool === 'set_meters' && Array.isArray(a.remove) && a.remove.length > 0) ||
    (part.tool === 'add_readings' && Array.isArray(a.delete) && a.delete.length > 0) ||
    part.tool === 'remove_share_member' ||
    a.action === 'delete' ||
    a.action === 'remove' ||
    a.top_up_action === 'delete' ||
    (part.tool === 'set_share' && a.role === 'none');
  // 没识别出来、用了默认值的字段：提醒用户核对
  const missing = create
    ? [!a.start && t('assistant.card.start'), a.method === undefined && t('detail.field.method'), !a.category && t('detail.field.category')].filter(
        (x): x is string => !!x,
      )
    : [];
  const gone = part.state === 'dismissed';
  const rows: Array<[string, ReactNode]> = create
    ? [
        [t('assistant.card.start'), proposalDay(a.start) ?? t('assistant.card.today')],
        ...(a.region ? [[t('detail.field.region'), String(a.region).toUpperCase()] as [string, ReactNode]] : []),
        ...(a.status === 'trial' && a.trial_end ? [[t('detail.field.trialEnd'), proposalDay(a.trial_end)] as [string, ReactNode]] : []),
        [t('detail.field.method'), <PayBadge key="m" m={method} />],
        ...(history.length
          ? [
              [
                t('assistant.card.history'),
                `${t('assistant.card.historyCount', { count: history.length })}\n${flow(-history.reduce((x, p) => x + p.amount, 0), String(a.currency))}`,
              ] as [string, ReactNode],
            ]
          : []),
      ]
    : summaryRows(part.tool, a, state, sub?.currency, part.preview as Record<string, unknown>);
  return (
    <div className={`as-card ${part.state}`} style={{ '--tint': catColor(icon.category) } as Record<string, string>}>
      <div className="as-card-tag">
        <ReceiptText size={12} /> {create ? t('assistant.card.draft') : t(`mcp.tool.${part.tool}`)}
      </div>
      <div className="as-card-head row">
        <SubIcon sub={icon} size={44} />
        <div className="as-card-id">
          <b className="text-ellipsis">{name}</b>
          {create && cyc ? (
            <span>
              {money(Number(a.price), String(a.currency))} {cycleLabel({ unit: cyc.unit, every: Number(cyc.every ?? 1) })}
              {copyParts(a.category ? `\n${String(a.category)}` : '')}
            </span>
          ) : (
            sub && <span>{copyParts([sub.price != null && sub.currency ? money(sub.price, sub.currency) : '', sub.cycle].filter(Boolean).join('\n'))}</span>
          )}
        </div>
      </div>
      <dl className="as-card-rows">
        {rows.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{k}</dt>
            <dd>{copyParts(v)}</dd>
          </Fragment>
        ))}
      </dl>
      {part.preview.created_category && <div className="as-card-next">{t('mcp.label.createCategory', { name: part.preview.created_category.name })}</div>}
      {part.preview.created_person && <div className="as-card-next">{t('mcp.label.createPerson', { name: part.preview.created_person.name })}</div>}
      {!create && part.preview.before !== undefined && (
        <details className="as-tool-detail">
          <summary>{t('assistant.card.changes')}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 260, overflow: 'auto', fontSize: 'var(--fs-1)' }}>
            {JSON.stringify({ before: part.preview.before, after: part.preview.after, references: part.preview.references }, null, 2)}
          </pre>
        </details>
      )}
      {create && part.preview.next_charges && part.preview.next_charges.length > 0 && (
        <div className="as-card-next">
          <small>{t('assistant.card.next')}</small>
          <div>
            {part.preview.next_charges.map((c) => (
              <span key={c.date}>
                {c.date.slice(5).replace('-', '/')} <span className="copy-gap" aria-hidden="true" /> {flow(-c.amount, c.currency)}
              </span>
            ))}
          </div>
        </div>
      )}
      {create && part.state === 'pending' && (missing.length > 0 || part.filled?.length) ? (
        <div className="as-card-note">
          {missing.length > 0 && (
            <span className="warn">
              <CircleAlert size={13} /> {t('assistant.card.missing', { fields: missing.join(t('assistant.card.sep')) })}
            </span>
          )}
          {part.filled?.length ? <span>{t('assistant.card.filled')}</span> : null}
        </div>
      ) : null}
      {(part.state === 'error' || part.state === 'unverified') && part.error && (
        <div className="as-card-err icon-text">
          <CircleAlert size={14} /> {part.error}
        </div>
      )}
      <div className="as-card-foot">
        {done || part.state === 'unverified' ? (
          <>
            <span className={`${done ? 'as-ok' : 'as-muted'} icon-text`}>
              {done ? <Check size={15} /> : <CircleAlert size={15} />}{' '}
              {done ? (create ? t('assistant.card.added') : t('assistant.card.done')) : t('assistant.card.unverified')}
            </span>
            {part.subId && (
              <button className="btn" onClick={() => props.onOpen(part.subId!)}>
                {t('assistant.card.view')}
              </button>
            )}
          </>
        ) : gone ? (
          <span className="as-muted icon-text">
            <CircleX size={15} /> {t('assistant.card.dismissed')}
          </span>
        ) : (
          <>
            <button className="btn plain" onClick={props.onDismiss} disabled={props.disabled || part.state === 'applying'}>
              {t('assistant.card.dismiss')}
            </button>
            {create && (
              <button className="btn" onClick={props.onEdit} disabled={props.disabled || part.state === 'applying'}>
                <Pencil size={14} /> {t('assistant.card.edit')}
              </button>
            )}
            <button
              className={`btn ${destructive ? 'danger-solid' : 'primary'}`}
              onClick={props.onApply}
              disabled={props.disabled || part.state === 'applying'}
            >
              {part.state === 'applying' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
              {create ? t('assistant.card.add') : t('assistant.card.confirm')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

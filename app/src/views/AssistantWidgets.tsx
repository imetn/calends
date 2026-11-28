// 助手对话内的富交互组件：直接复用文件缩略图（FileThumb）、文件详情（FileSheet）、图片缩放（ImageZoom）、MetricCards 与 SubIcon，
// 让只读工具结果（文件列表、账单概览/统计、订阅卡片、合租明细）在聊天气泡里可直接浏览、点开预览，而不是只看原始 JSON。
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { FILE_EXT, type FileMeta } from '../../../shared/files.ts';
import { money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState } from '../../../shared/types.ts';
import { copyParts } from '../components/copy.tsx';
import { FileBadges, FileThumb, fileLabel } from '../components/FileSheet.tsx';
import { ImageZoom } from '../components/ImageZoom.tsx';
import { SubIcon } from '../components/marks.tsx';
import { Sheet } from '../components/overlays.tsx';
import { Metric, MetricCards } from '../components/ui.tsx';
import { ArrowUpRight, ChevronDown, Eye } from '../components/ui-icons.tsx';
import { sizeLabel } from '../files.ts';
import type { Part } from './assistant-chat.ts';

type ToolPart = Extract<Part, { kind: 'tool' }>;

interface FileResultRow {
  id: string;
  title?: string;
  name?: string;
  subscription?: { id: string; name: string } | null;
  kind?: string | null;
  date?: string | null;
  deleted_source?: string | null;
  type?: string;
  mime?: string;
  size?: number;
}

interface SubResultRow {
  id: string;
  name: string;
  status?: string;
  category?: string;
  cycle?: string;
  next_charge?: string | null;
  service_expires?: string | null;
  account?: string | null;
  region?: string | null;
  method_name?: string | null;
  price?: { amount: number | null; currency: string };
}

interface BarRow {
  label: string;
  amount: number | null;
  sharePct?: number | null;
}

const fmtAmount = (amount: unknown, ccy: unknown): string => {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const code = String(ccy ?? '').toUpperCase();
  return code ? money(Number(amount), code) : Number(amount).toFixed(2);
};

const statusTone = (s?: string) => {
  if (s === 'active' || s === 'lifetime') return 'ok';
  if (s === 'trial' || s === 'ending' || s === 'paused') return 'warn';
  if (s === 'cancelled' || s === 'terminated' || s === 'ended') return 'bad';
  return '';
};

/** 聊天图片点击放大预览（复用文件中心的 ImageZoom 缩放/拖拽/捏合） */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return createPortal(
    <Sheet bare label={t('assistant.widget.previewImage')} onClose={onClose}>
      <div className="as-lightbox">
        <ImageZoom src={src} alt={t('assistant.widget.previewImage')} />
      </div>
    </Sheet>,
    document.body,
  );
}

/** 根据工具结果返回对应的高可读富组件；无结构化数据时返回 null */
export function ToolResultWidget({
  part,
  state,
  onOpenSub,
  onOpenFile,
}: {
  part: ToolPart;
  state: AppState;
  onOpenSub: (id: string) => void;
  onOpenFile: (id: string, list: FileMeta[]) => void;
}) {
  if (part.status !== 'done' || !part.result || typeof part.result !== 'object') return null;
  const data = part.result as Record<string, unknown>;
  switch (part.name) {
    case 'list_files':
      return <FilesResultWidget data={data} state={state} onOpenFile={onOpenFile} />;
    case 'get_overview':
    case 'spending_stats':
    case 'get_insights':
      return <SpendingResultWidget data={data} />;
    case 'list_subscriptions':
      return <SubListResultWidget data={data} state={state} onOpenSub={onOpenSub} />;
    case 'get_subscription':
      return <SubDetailResultWidget data={data} state={state} onOpenSub={onOpenSub} onOpenFile={onOpenFile} />;
    case 'get_carpool':
      return <CarpoolResultWidget data={data} state={state} onOpenSub={onOpenSub} />;
    default:
      return null;
  }
}

function FilesResultWidget({
  data,
  state,
  onOpenFile,
}: {
  data: Record<string, unknown>;
  state: AppState;
  onOpenFile: (id: string, list: FileMeta[]) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  if (data.storage === false) return null;
  const rows = Array.isArray(data.files) ? (data.files as FileResultRow[]) : [];
  if (!rows.length) return null;

  const allFiles = state.files ?? [];
  const resolvedMetas = rows.map((r) => allFiles.find((f) => f.id === r.id)).filter((f): f is FileMeta => !!f);
  const visible = expanded ? rows : rows.slice(0, 6);

  return (
    <div className="as-widget">
      <div className="as-widget-head">
        <b>{t('files.card')}</b>
        <span className="as-widget-pill">{t('files.count', { count: Number(data.total ?? rows.length) })}</span>
      </div>
      <div className="as-file-grid">
        {visible.map((r) => {
          const meta = allFiles.find((f) => f.id === r.id);
          const lbl = meta ? fileLabel(meta, allFiles, state.subscriptions) : { head: r.title ?? r.name ?? r.id, item: undefined };
          const ext = (meta ? FILE_EXT[meta.mime] : (r.type ?? 'file')).toUpperCase();
          const subParts = [lbl.item, ext, r.size ? sizeLabel(r.size) : ''].filter(Boolean).join('\n');
          const pages = meta?.mime === 'application/pdf' && meta.pages ? Math.min(3, meta.pages) : 1;
          return (
            <button
              key={r.id}
              type="button"
              className="as-file-item"
              disabled={!meta}
              onClick={() => meta && onOpenFile(meta.id, resolvedMetas.length ? resolvedMetas : [meta])}
            >
              <span className={`as-file-thumb${pages >= 2 ? ` stack-${pages}` : ''}`}>
                {meta ? <FileThumb f={meta} /> : <span className="as-file-ext">{ext}</span>}
              </span>
              <span className="as-file-info">
                <b className="text-ellipsis">{lbl.head}</b>
                {meta && <FileBadges f={meta} subs={state.subscriptions} compact />}
                <small className="text-ellipsis">{copyParts(subParts || r.name || '')}</small>
              </span>
              {meta && <Eye size={14} className="as-file-open" />}
            </button>
          );
        })}
      </div>
      {rows.length > 6 && (
        <button type="button" className="as-widget-more" onClick={() => setExpanded((v) => !v)}>
          <span>{expanded ? t('assistant.widget.collapse') : t('assistant.widget.showAll', { count: rows.length })}</span>
          <ChevronDown size={14} className={expanded ? 'rot' : ''} />
        </button>
      )}
    </div>
  );
}

function SpendingResultWidget({ data }: { data: Record<string, unknown> }) {
  const ccy = String(data.currency_out ?? data.currency ?? data.base_currency ?? '');
  const incomplete = !!data.incomplete || (Array.isArray(data.fx_missing) && data.fx_missing.length > 0);
  const kpis: Array<{ label: string; value: string }> = [];
  let bars: BarRow[] = [];
  let titleParts: string[] = [t('assistant.widget.spending')];

  if (data.mrr !== undefined && data.active_count !== undefined) {
    titleParts = [t('assistant.widget.overview')];
    kpis.push({ label: t('assistant.widget.mrr'), value: fmtAmount(data.mrr, ccy) });
    kpis.push({ label: t('assistant.widget.yearly'), value: fmtAmount(data.yearly, ccy) });
    kpis.push({ label: t('assistant.widget.active'), value: String(data.active_count) });
  } else if (Array.isArray(data.blocks)) {
    const blocks = data.blocks as Array<Record<string, unknown>>;
    const hl = blocks.find((b) => b.type === 'headline');
    const comp = blocks.find((b) => b.type === 'composition');
    if (hl) {
      titleParts = hl.month ? [t('assistant.widget.monthReport'), String(hl.month)] : [t('assistant.widget.scopeReport')];
      if (hl.total !== undefined) kpis.push({ label: t('assistant.widget.total'), value: fmtAmount(hl.total, ccy) });
      if (hl.paid !== undefined) kpis.push({ label: t('assistant.widget.paid'), value: fmtAmount(hl.paid, ccy) });
      if (hl.upcoming !== undefined) kpis.push({ label: t('assistant.widget.upcoming'), value: fmtAmount(hl.upcoming, ccy) });
      if (hl.mrr !== undefined) kpis.push({ label: t('assistant.widget.mrr'), value: fmtAmount(hl.mrr, ccy) });
      if (hl.annual !== undefined) kpis.push({ label: t('assistant.widget.yearly'), value: fmtAmount(hl.annual, ccy) });
      if (hl.active_count !== undefined) kpis.push({ label: t('assistant.widget.active'), value: String(hl.active_count) });
    }
    const rawBars = (Array.isArray(comp?.categories) && comp.categories.length ? comp.categories : comp?.methods) as Array<Record<string, unknown>> | undefined;
    if (rawBars?.length) {
      bars = rawBars.slice(0, 8).map((r) => ({
        label: String(r.label ?? r.key ?? t('assistant.widget.other')),
        amount: r.amount == null ? null : Number(r.amount),
        sharePct: r.share_pct == null ? null : Number(r.share_pct),
      }));
    }
  } else {
    if (data.from && data.to) titleParts = [t('assistant.widget.spending'), `${String(data.from)} – ${String(data.to)}`];
    if (data.total !== undefined) kpis.push({ label: t('assistant.widget.total'), value: fmtAmount(data.total, ccy) });
    if (data.total === null && data.known_total !== undefined) {
      kpis.push({ label: t('assistant.widget.knownTotal'), value: fmtAmount(data.known_total, ccy) });
    }
    if (data.count !== undefined) kpis.push({ label: t('assistant.widget.charges'), value: String(data.count) });
    if (Array.isArray(data.groups)) {
      bars = (data.groups as Array<Record<string, unknown>>).slice(0, 8).map((g) => ({
        label: String(g.label ?? g.key ?? t('assistant.widget.other')),
        amount: g.total != null ? Number(g.total) : g.amount != null ? Number(g.amount) : null,
        sharePct: g.share_pct == null ? null : Number(g.share_pct),
      }));
    }
  }

  if (!kpis.length && !bars.length) return null;
  const maxBar = Math.max(0.01, ...bars.map((b) => (b.amount != null && Number.isFinite(b.amount) ? Math.abs(b.amount) : 0)));

  return (
    <div className="as-widget">
      <div className="as-widget-head">
        <b>{copyParts(titleParts.join('\n'))}</b>
        {incomplete ? <span className="as-widget-pill warn">{t('assistant.widget.incompleteFx')}</span> : ccy && <span className="as-widget-pill">{ccy}</span>}
      </div>
      {kpis.length > 0 && (
        <MetricCards>
          {kpis.slice(0, 4).map((k) => (
            <Metric key={k.label} label={k.label} value={k.value} />
          ))}
        </MetricCards>
      )}
      {bars.length > 0 && (
        <div className="as-widget-bars">
          {bars.map((b) => {
            const pct = b.amount != null && Number.isFinite(b.amount) ? Math.max(3, Math.round((Math.abs(b.amount) / maxBar) * 100)) : 0;
            return (
              <div key={b.label} className="as-widget-bar">
                <span className="text-ellipsis">{b.label}</span>
                <span className="as-widget-track">
                  <i style={{ width: `${pct}%` }} />
                </span>
                <b>
                  {fmtAmount(b.amount, ccy)}
                  {b.sharePct != null ? ` (${b.sharePct}%)` : ''}
                </b>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SubListResultWidget({ data, state, onOpenSub }: { data: Record<string, unknown>; state: AppState; onOpenSub: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const rows = Array.isArray(data.subscriptions) ? (data.subscriptions as SubResultRow[]) : [];
  if (!rows.length) return null;
  const visible = expanded ? rows : rows.slice(0, 5);

  return (
    <div className="as-widget">
      <div className="as-widget-head">
        <b>{t('assistant.widget.subscriptions')}</b>
        <span className="as-widget-pill">{rows.length}</span>
      </div>
      <div className="as-widget-list">
        {visible.map((r) => {
          const live = state.subscriptions.find((s) => s.id === r.id);
          const icon = live ?? { name: r.name, category: r.category ?? '' };
          const meta = [r.category, r.cycle, r.next_charge ? `${t('assistant.widget.nextCharge')} ${r.next_charge}` : ''].filter(Boolean).join('\n');
          return (
            <button key={r.id} type="button" className="as-widget-row" disabled={!live} onClick={() => live && onOpenSub(live.id)}>
              <SubIcon sub={icon} size={30} />
              <span className="as-widget-main">
                <b className="text-ellipsis">{r.name}</b>
                <small className="text-ellipsis">{copyParts(meta)}</small>
              </span>
              <span className="as-widget-right">
                <b>{r.price ? fmtAmount(r.price.amount, r.price.currency) : '—'}</b>
                {r.status && <span className={`as-widget-pill ${statusTone(r.status)}`}>{r.status}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {rows.length > 5 && (
        <button type="button" className="as-widget-more" onClick={() => setExpanded((v) => !v)}>
          <span>{expanded ? t('assistant.widget.collapse') : t('assistant.widget.showAll', { count: rows.length })}</span>
          <ChevronDown size={14} className={expanded ? 'rot' : ''} />
        </button>
      )}
    </div>
  );
}

function SubDetailResultWidget({
  data,
  state,
  onOpenSub,
  onOpenFile,
}: {
  data: Record<string, unknown>;
  state: AppState;
  onOpenSub: (id: string) => void;
  onOpenFile: (id: string, list: FileMeta[]) => void;
}) {
  const s = (data.subscription ?? data) as SubResultRow | undefined;
  if (!s?.id || !s?.name) return null;
  const live = state.subscriptions.find((x) => x.id === s.id);
  const icon = live ?? { name: s.name, category: s.category ?? '' };
  const spent = (data.spent_total ?? data.spent) as { amount?: number | null; currency?: string } | undefined;
  const rawFiles = Array.isArray(data.files) ? (data.files as FileResultRow[]) : [];
  const allFiles = state.files ?? [];
  const fileMetas = rawFiles.map((f) => allFiles.find((x) => x.id === f.id)).filter((x): x is FileMeta => !!x);

  return (
    <div className="as-widget">
      <div className="as-widget-head">
        <span className="as-widget-subhead">
          <SubIcon sub={icon} size={32} />
          <span className="as-widget-main">
            <b className="text-ellipsis">{s.name}</b>
            <small className="text-ellipsis">{copyParts([s.category, s.region, s.method_name, s.account].filter(Boolean).join('\n'))}</small>
          </span>
        </span>
        {live && (
          <button type="button" className="btn plain as-widget-btn" onClick={() => onOpenSub(live.id)}>
            {t('assistant.card.view')} <ArrowUpRight size={13} />
          </button>
        )}
      </div>
      <MetricCards>
        <Metric label={t('assistant.widget.plan')} value={s.price ? `${fmtAmount(s.price.amount, s.price.currency)}${s.cycle ? ` / ${s.cycle}` : ''}` : '—'} />
        <Metric label={t('assistant.widget.nextCharge')} value={s.next_charge ?? '—'} />
        {spent && <Metric label={t('assistant.f.spent')} value={fmtAmount(spent.amount, spent.currency)} />}
      </MetricCards>
      {fileMetas.length > 0 && (
        <div className="as-file-chips">
          {fileMetas.slice(0, 4).map((f) => {
            const lbl = fileLabel(f, allFiles, state.subscriptions);
            return (
              <button key={f.id} type="button" className="as-file-chip" onClick={() => onOpenFile(f.id, fileMetas)}>
                <span className="as-file-chip-thumb">
                  <FileThumb f={f} />
                </span>
                <span className="text-ellipsis">{lbl.item ?? lbl.head}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

interface MoneyBox {
  amount?: number | null;
  currency?: string;
  converted?: number | null;
}

interface CarpoolMemberRow {
  name: string;
  exempt?: boolean;
  fee?: number | { amount?: number | null; currency?: string } | null;
  fee_currency?: string;
  paid_until?: string | null;
  paid_through?: string | null;
  next_collection_date?: string | null;
  pending_amount?: number | MoneyBox | null;
  owed?: MoneyBox | null;
  left?: string | null;
}

const memberOwed = (m: CarpoolMemberRow, converted: boolean): number | null => {
  const box = m.owed ?? (m.pending_amount && typeof m.pending_amount === 'object' ? m.pending_amount : null);
  if (box) return converted ? (box.converted ?? null) : (box.amount ?? 0);
  return typeof m.pending_amount === 'number' ? m.pending_amount : 0;
};

interface CarpoolPlanRow {
  id?: string;
  name?: string;
  role?: string;
  seats?: number | { total: number; taken: number; free: number };
  collect_from?: string | null;
  year?: { i_pay?: number | null; i_earn?: number | null };
  members?: CarpoolMemberRow[];
}

function CarpoolResultWidget({ data, state, onOpenSub }: { data: Record<string, unknown>; state: AppState; onOpenSub: (id: string) => void }) {
  const baseCcy = String(data.currency ?? data.collect_currency ?? state.settings.baseCurrency);
  const plans = Array.isArray(data.plans) ? (data.plans as CarpoolPlanRow[]) : [data as unknown as CarpoolPlanRow];
  const valid = plans.filter((p) => p && (p.name || (Array.isArray(p.members) && p.members.length > 0)));
  if (!valid.length) return null;

  return (
    <div className="as-widget">
      {valid.slice(0, 3).map((p, idx) => {
        const members = Array.isArray(p.members) ? p.members : [];
        const live = p.id ? state.subscriptions.find((s) => s.id === p.id) : undefined;
        const seats = p.seats && typeof p.seats === 'object' ? `${p.seats.taken} / ${p.seats.total}` : String(p.seats ?? members.length);
        let owedTotal: number | null = 0;
        for (const m of members) {
          const v = memberOwed(m, true);
          if (v == null || !Number.isFinite(v)) {
            owedTotal = null;
            break;
          }
          owedTotal += v;
        }
        return (
          <div key={p.id ?? idx} className="as-widget-plan">
            <div className="as-widget-head">
              <b>{p.name ?? t('assistant.widget.carpool')}</b>
              {live && (
                <button type="button" className="btn plain as-widget-btn" onClick={() => onOpenSub(live.id)}>
                  {t('assistant.card.view')} <ArrowUpRight size={13} />
                </button>
              )}
            </div>
            <MetricCards>
              <Metric label={t('assistant.f.seats')} value={seats} />
              <Metric label={t('assistant.widget.pendingDues')} value={fmtAmount(owedTotal, baseCcy)} />
              <Metric label={t('assistant.widget.yearly')} value={fmtAmount(p.year?.i_pay ?? null, baseCcy)} />
            </MetricCards>
            {members.length > 0 && (
              <div className="as-widget-list">
                {members.slice(0, 8).map((m) => {
                  const feeAmt = m.fee && typeof m.fee === 'object' ? m.fee.amount : m.fee;
                  const feeCcy = (m.fee && typeof m.fee === 'object' ? m.fee.currency : m.fee_currency) ?? baseCcy;
                  const owed = memberOwed(m, false) ?? 0;
                  const owedCcy =
                    m.owed?.currency ?? (m.pending_amount && typeof m.pending_amount === 'object' ? m.pending_amount.currency : undefined) ?? feeCcy;
                  const tone = m.left ? '' : owed > 0 ? 'warn' : 'ok';
                  const badge = m.left ? `${t('assistant.f.left')} ${m.left}` : owed > 0 ? fmtAmount(owed, owedCcy) : t('assistant.widget.settled');
                  const detail = [m.exempt ? t('assistant.v.exempt') : feeAmt != null ? fmtAmount(feeAmt, feeCcy) : '', m.paid_until ?? m.paid_through]
                    .filter(Boolean)
                    .join('\n');
                  return (
                    <div key={m.name} className="as-widget-row static">
                      <span className="as-widget-main">
                        <b className="text-ellipsis">{m.name}</b>
                        <small className="text-ellipsis">{copyParts(detail)}</small>
                      </span>
                      <span className={`as-widget-pill ${tone}`}>{badge}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// 文件详情：预览（图片可缩放平移，PDF 在应用内逐页阅读，读不出时退回首页缩略图并在新标签页打开）、来源、属性，以及下载、改关联、删除。文件页与订阅详情共用。
import '../files.css';
import { lazy, Suspense, useEffect, useState } from 'react';
import {
  anchorChoices,
  FILE_EXT,
  fileBadgeKind,
  fileTitle,
  fileTitleParts,
  findReceiptOwner,
  type FileKind,
  type FileMeta,
  type FileReceiptScope,
} from '../../../shared/files.ts';
import type { Subscription } from '../../../shared/types.ts';
import { cnDateFull, flow, money } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState } from '../../../shared/types.ts';
import { deleteFiles, downloadHref, ensurePdfPages, ensureThumb, fileUrl, isImage, relinkFile, savePdfPages, sizeLabel, thumbUrl } from '../files.ts';
import { toast } from '../toast.ts';
import { ConfirmButton } from './ConfirmButton.tsx';
import { Icon } from './icons.tsx';
import { ImageZoom } from './ImageZoom.tsx';
import { SubIcon } from './marks.tsx';
import { Sheet } from './overlays.tsx';
import { PersonAvatar, personFor } from './PersonAvatar.tsx';
import { Picker } from './Picker.tsx';
import { Cell, Group, IconButton } from './ui.tsx';

// PDF 阅读器（react-pdf + pdf.js）单独成块，打开 PDF 时才加载
const PdfView = lazy(() => import('./PdfView.tsx'));

/**
 * 显示名拆成两行：订阅名（或已删除订阅的原名）与挂的那一项；未关联只有原始文件名。
 * 文件页卡片与详情标题都用它，不在界面里拼「·」
 */
export function fileLabel(f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]): { head: string; item?: string; gone: boolean } {
  const parts = fileTitleParts(f, files, subs);
  if (f.subId) return { head: parts[0], item: parts[1], gone: false };
  if (f.orphan) return { head: parts[1], item: parts[2], gone: true };
  return { head: parts[0], gone: false };
}

/** 醒目的收款类型标签（合租收款 / 代付收款）与重复凭证提示标签；compact 用于卡片与列表标题行末尾，只保留极简短词 */
export function ReceiptScopeTag({ scope, compact }: { scope: FileReceiptScope | 'receipt'; compact?: boolean }) {
  const icon = scope === 'carpool' ? 'users' : scope === 'proxy' ? 'coins' : 'receipt';
  const fullLabel = scope === 'carpool' ? t('files.badge.carpool') : scope === 'proxy' ? t('files.badge.proxy') : t('files.kind.receipt');
  const label = compact
    ? scope === 'carpool'
      ? t('files.badge.carpoolShort')
      : scope === 'proxy'
        ? t('files.badge.proxyShort')
        : t('files.badge.receiptShort')
    : fullLabel;
  return (
    <span className={`file-tag ${scope}${compact ? ' compact' : ''}`} title={compact ? fullLabel : undefined}>
      {!compact && <Icon name={icon} size={11} />}
      <span>{label}</span>
    </span>
  );
}

/** 界面里已经用胶囊标出「合租收款 / 代付收款」时，去掉紧跟文字里的重复类型词，只留日期、付款人与序号 */
export function compactReceiptItem(item: string | undefined, scope: FileReceiptScope | 'receipt' | undefined): string | undefined {
  if (!item || !scope) return item;
  const tag = scope === 'carpool' ? t('core.file.carpoolReceipt') : scope === 'proxy' ? t('core.file.proxyReceipt') : t('core.file.receipt');
  return item.replace(` ${tag}`, '').trim() || item;
}

export function FileBadges({
  f,
  subs,
  compact,
  className,
}: {
  f: Pick<FileMeta, 'subId' | 'kind' | 'receiptId' | 'orphan' | 'dupReceipt'>;
  subs: readonly Pick<Subscription, 'id' | 'share' | 'proxy'>[];
  compact?: boolean;
  className?: string;
}) {
  const scope = fileBadgeKind(f, subs);
  if (!scope && !f.dupReceipt) return null;
  return (
    <span className={`file-tags${className ? ` ${className}` : ''}`}>
      {scope && <ReceiptScopeTag scope={scope} compact={compact} />}
      {f.dupReceipt && (
        <span className={`file-tag dup${compact ? ' compact' : ''}`} title={t('files.dupHint')}>
          {!compact && <Icon name="info" size={11} />}
          <span>{compact ? t('files.badge.dupShort') : t('files.badge.dup')}</span>
        </span>
      )}
    </span>
  );
}

/** 卡片与预览里的文件图：有缩略图用缩略图，没有时补生成并先显示类型图标 */
export function FileThumb({ f, onRatio }: { f: FileMeta; onRatio?: (ratio: number) => void }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    ensureThumb(f);
    ensurePdfPages(f);
  }, [f.id, f.thumb, f.pages, f.mime]);
  if (!f.thumb || broken)
    return (
      <span className="file-ph">
        <Icon name="file" size={28} />
        <b>{FILE_EXT[f.mime].toUpperCase()}</b>
      </span>
    );
  return (
    <img
      src={thumbUrl(f)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onLoad={(e) => e.currentTarget.naturalHeight && onRatio?.(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)}
      onError={() => setBroken(true)}
    />
  );
}

/** 文件详情弹窗；list 为同一视图里的文件，可左右切换 */
export function FileSheet({
  id,
  list,
  state,
  today,
  onClose,
  onOpenSub,
}: {
  id: string;
  list: readonly FileMeta[];
  state: AppState;
  today: string;
  onClose: () => void;
  onOpenSub?: (subId: string) => void;
}) {
  const files = state.files ?? [];
  const [cur, setCur] = useState(id);
  const [relink, setRelink] = useState(false);
  const f = files.find((x) => x.id === cur);
  const at = list.findIndex((x) => x.id === cur);
  const step = (d: number) => {
    const next = list[at + d];
    if (next) setCur(next.id);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (relink || (e.target instanceof HTMLElement && e.target.closest('input, textarea, [role="listbox"]'))) return;
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // 文件被删掉（包括在别处删）时关闭
  useEffect(() => {
    if (!f) onClose();
  }, [f]);
  if (!f) return null;
  const ro = !!state.readonly;
  const sub = f.subId ? state.subscriptions.find((s) => s.id === f.subId) : undefined;
  const owner = f.kind === 'receipt' ? findReceiptOwner(sub, f.receiptId) : undefined;
  const label = fileLabel(f, files, state.subscriptions);
  // 来源一行已写订阅名，标题只写挂的那一项；未关联时是原始文件名
  const title = label.item ?? label.head;
  const linked = !!(f.subId || f.orphan);
  // PDF 加载时先摆首页缩略图；读不出来时退回缩略图 + 在新标签页打开
  const pdfPlaceholder = (
    <div className="fp-page">
      <FileThumb f={f} />
    </div>
  );
  const pdfFallback = (
    <a className="file-view pdf" href={fileUrl(f)} target="_blank" rel="noopener" aria-label={t('files.open')}>
      <FileThumb f={f} />
      <span className="file-open icon-text">
        <Icon name="external" size={15} />
        {t('files.open')}
      </span>
    </a>
  );
  const remove = async () => {
    try {
      await deleteFiles([f.id]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  return (
    <>
      <Sheet
        title={title}
        onClose={onClose}
        actions={
          list.length > 1 && (
            <span className="file-steps">
              <IconButton disabled={at <= 0} onClick={() => step(-1)} aria-label={t('files.prev')}>
                <Icon name="left" />
              </IconButton>
              <IconButton disabled={at < 0 || at >= list.length - 1} onClick={() => step(1)} aria-label={t('files.next')}>
                <Icon name="right" />
              </IconButton>
            </span>
          )
        }
        foot={
          <>
            {!ro && (
              <ConfirmButton onConfirm={remove}>
                <Icon name="trash" size={16} />
                {t('common.delete')}
              </ConfirmButton>
            )}
            {!ro && (
              <button className="btn" onClick={() => setRelink(true)}>
                <Icon name="link" size={16} />
                {t('files.relink')}
              </button>
            )}
            <a className="btn primary" href={downloadHref(f)} download>
              <Icon name="download" size={16} />
              {t('files.download')}
            </a>
          </>
        }
      >
        <div className="stack">
          {(sub || f.orphan) && (
            <div className="file-source">
              {sub ? (
                <button type="button" className="file-source-sub" onClick={() => onOpenSub?.(sub.id)} disabled={!onOpenSub}>
                  <SubIcon sub={sub} size={22} />
                  <span>{sub.name}</span>
                  {onOpenSub && <Icon name="right" size={14} />}
                </button>
              ) : (
                <span className="file-source-sub gone">
                  <span className="badge">{t('files.deleted')}</span>
                  <span>{f.orphan!.name}</span>
                </span>
              )}
              <FileBadges f={f} subs={state.subscriptions} />
            </div>
          )}
          {f.dupReceipt && (
            <div className="file-dup-warn" role="status">
              <Icon name="info" size={15} />
              <span>{t('files.dupHint')}</span>
            </div>
          )}
          {isImage(f) ? (
            <ImageZoom key={f.id} src={fileUrl(f)} alt={fileTitle(f, files, state.subscriptions)} />
          ) : (
            <Suspense key={f.id} fallback={<div className="fp-pdf">{pdfPlaceholder}</div>}>
              <PdfView
                url={fileUrl(f)}
                placeholder={pdfPlaceholder}
                fallback={pdfFallback}
                onPages={(n) => f.pages == null && !ro && void savePdfPages(f, n).catch(() => {})}
              />
            </Suspense>
          )}
          <Group>
            {owner && (
              <>
                <Cell label={t(owner.scope === 'carpool' ? 'files.props.member' : 'files.props.payer')}>
                  <span className="row">
                    <PersonAvatar p={personFor(state, owner.scope === 'carpool' ? owner.member.personId : owner.proxy.personId, owner.person)} size={20} />
                    <span>{owner.person}</span>
                  </span>
                </Cell>
                <Cell label={t('files.props.amount')}>
                  <span className="num green">{flow(owner.receipt.amount, owner.receipt.currency)}</span>
                </Cell>
                <Cell label={t('files.props.receiptDate')}>{cnDateFull(owner.receipt.date)}</Cell>
              </>
            )}
            {!owner && f.orphan?.kind === 'receipt' && f.orphan.person && <Cell label={t('files.props.payer')}>{f.orphan.person}</Cell>}
            {linked && <Cell label={t('files.props.name')}>{f.name}</Cell>}
            <Cell label={t('files.props.type')}>{FILE_EXT[f.mime].toUpperCase()}</Cell>
            <Cell label={t('files.props.size')}>{sizeLabel(f.size)}</Cell>
            <Cell label={t('files.props.uploaded')}>{cnDateFull(f.createdAt.slice(0, 10))}</Cell>
          </Group>
        </div>
      </Sheet>
      {relink && <RelinkSheet f={f} state={state} today={today} onClose={() => setRelink(false)} />}
    </>
  );
}

const NONE = '';

/** 改关联：选订阅、挂法和那一项；选「不关联」放回待关联 */
export function RelinkSheet({ f, state, today, onClose }: { f: FileMeta; state: AppState; today: string; onClose: () => void }) {
  const subs = state.subscriptions;
  const [subId, setSubId] = useState(f.subId && subs.some((s) => s.id === f.subId) ? f.subId : NONE);
  const sub = subs.find((s) => s.id === subId);
  const base = sub ? anchorChoices(sub, today) : { charges: [], contracts: [], receipts: [] };
  // 原来挂的那一项不在可选项里（如付款弹窗里传到了未来日期）时也列出来：只打开再保存不会挪走文件
  const own = sub && f.subId === sub.id && f.date ? f.date : undefined;
  const choices = {
    charges: own && f.kind === 'charge' && !base.charges.some((c) => c.date === own) ? [{ date: own, label: '' }, ...base.charges] : base.charges,
    contracts: base.contracts,
    receipts: base.receipts,
  };
  const kinds: FileKind[] = ['charge', 'receipt', 'contract', 'sub'];
  const pick = (k: FileKind | undefined, val: string | undefined): [FileKind, string] => {
    const items =
      k === 'charge'
        ? choices.charges.map((c) => c.date)
        : k === 'contract'
          ? choices.contracts.map((c) => c.from)
          : k === 'receipt'
            ? choices.receipts.map((c) => c.id)
            : [];
    if (k === 'sub') return ['sub', NONE];
    if (k && items.length) return [k, val && items.includes(val) ? val : items[0]];
    if (choices.receipts.length && (sub?.proxy || sub?.share)) return ['receipt', choices.receipts[0].id];
    return choices.charges.length ? ['charge', choices.charges[0].date] : ['sub', NONE];
  };
  const [[kind, value], setAnchor] = useState<[FileKind, string]>(() =>
    pick(f.subId === subId ? f.kind : undefined, f.kind === 'receipt' ? f.receiptId : f.date),
  );
  const [busy, setBusy] = useState(false);
  const chooseSub = (id: string) => {
    setSubId(id);
    const next = subs.find((s) => s.id === id);
    const c = next ? anchorChoices(next, today) : { charges: [], contracts: [], receipts: [] };
    if (c.receipts.length && (next?.proxy || next?.share)) setAnchor(['receipt', c.receipts[0].id]);
    else setAnchor(c.charges.length ? ['charge', c.charges[0].date] : ['sub', NONE]);
  };
  const items =
    kind === 'charge'
      ? choices.charges.map((c) => ({ value: c.date, label: c.date, hint: c.label || undefined }))
      : kind === 'contract'
        ? choices.contracts.map((c) => ({ value: c.from, label: t('core.file.contractTerm', { from: c.from, until: c.until }) }))
        : kind === 'receipt'
          ? choices.receipts.map((c) => ({
              value: c.id,
              label: `${c.date} ${c.person}`,
              hint: `${t(c.scope === 'carpool' ? 'files.badge.carpool' : 'files.badge.proxy')} ${money(c.amount, c.currency)}`,
            }))
          : [];
  const kindLabel = (k: FileKind) => {
    if (k !== 'receipt') return t(`files.kind.${k}`);
    if (sub?.proxy) return t('files.badge.proxy');
    if (sub?.share) return t('files.badge.carpool');
    return t('files.kind.receipt');
  };
  const save = async () => {
    setBusy(true);
    try {
      if (!sub) {
        await relinkFile(f, { subId: null, kind: null, date: null, receiptId: null });
      } else if (kind === 'receipt') {
        const pickedReceipt = choices.receipts.find((c) => c.id === value);
        if (!pickedReceipt) return;
        await relinkFile(f, { subId: sub.id, kind: 'receipt', date: pickedReceipt.date, receiptId: pickedReceipt.id });
      } else {
        await relinkFile(f, { subId: sub.id, kind, date: kind === 'sub' ? null : value, receiptId: null });
      }
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      narrow
      title={t('files.link.title')}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || (kind !== 'sub' && !!sub && !value)} onClick={save}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <Group>
        <Cell label={t('files.link.sub')}>
          <Picker
            value={subId}
            onChange={chooseSub}
            ariaLabel={t('files.link.sub')}
            options={[{ value: NONE, label: t('files.link.none') }, ...subs.map((s) => ({ value: s.id, label: s.name, icon: <SubIcon sub={s} size={18} /> }))]}
          />
        </Cell>
        {sub && (
          <Cell label={t('files.link.kind')}>
            <Picker
              value={kind}
              onChange={(k) => setAnchor(pick(k, value))}
              ariaLabel={t('files.link.kind')}
              options={kinds
                .filter((k) =>
                  k === 'sub'
                    ? true
                    : k === 'charge'
                      ? choices.charges.length > 0
                      : k === 'contract'
                        ? choices.contracts.length > 0
                        : choices.receipts.length > 0,
                )
                .map((k) => ({ value: k, label: kindLabel(k) }))}
            />
          </Cell>
        )}
        {sub && kind !== 'sub' && (
          <Cell label={t('files.link.item')}>
            {items.length ? (
              <Picker value={value} onChange={(v) => setAnchor([kind, v])} ariaLabel={t('files.link.item')} options={items} />
            ) : (
              t('files.link.noItems')
            )}
          </Cell>
        )}
      </Group>
    </Sheet>
  );
}

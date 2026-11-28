// 订阅详情的「文件」卡：有文件时才出现。单份用横条，多份用单排缩略图卡片平铺（超出一排时末尾叠成 +N）；可拖文件进详情上传为资料。
import { createPortal } from 'react-dom';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { FILE_EXT, fileBadgeKind, fileReceiptPerson, filesForReceipt, filesOf, type FileMeta } from '../../../../shared/files.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { FileDrop } from '../../components/FileDrop.tsx';
import { FileBadges, fileLabel, FileSheet, FileThumb } from '../../components/FileSheet.tsx';
import { checkFile, relinkFile, sizeLabel, uploadFiles } from '../../files.ts';
import { useFilePicker, useUpload } from '../../components/FileUpload.tsx';
import { Icon } from '../../components/icons.tsx';
import { Cell, Group, IconButton } from '../../components/ui.tsx';
import { useStore } from '../../store.ts';
import { toast } from '../../toast.ts';

const TILE_MIN = 96;
const MIN_COLS = 3;
const MAX_COLS = 6;

/** 单排可平铺的卡片列数：桌面 680px 排 6 张，手机 338px 排 3 张，保证始终只占一行 */
export function fileStripCols(width: number): number {
  if (width <= 0) return MAX_COLS;
  const gap = width <= 520 ? 10 : 12;
  return Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor((width + gap) / (TILE_MIN + gap))));
}

/** 详情卡里的文件顺序，与文件页默认「不分组」一致：有日期按日期倒序，资料按上传时间倒序 */
const when = (f: FileMeta) => f.date ?? f.createdAt.slice(0, 10);
export const orderDetailFiles = (files: readonly FileMeta[]): FileMeta[] =>
  [...files].sort((a, b) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));

/** 一批文件覆盖的时间：同月写年月，同年省略后一年，跨年写年份范围以免窄卡截断 */
export function fileDateSpan(g: readonly FileMeta[], full = false): string {
  const months = g
    .map((f) => (f.date ?? '').slice(0, 7))
    .filter(Boolean)
    .sort();
  const [a, b] = [months[0], months.at(-1)];
  if (!a || !b) return '';
  if (a === b) return a;
  if (full) return `${a} – ${b}`;
  return a.slice(0, 4) === b.slice(0, 4) ? `${a} – ${b.slice(5)}` : `${a.slice(0, 4)} – ${b.slice(0, 4)}`;
}

type StripEntry = { type: 'pending'; key: string; name: string } | { type: 'file'; f: FileMeta };

/** 按单排列数切分：装得下就全部平铺，超出时留出最后一格放 +N */
export function sliceFileStrip(entries: readonly StripEntry[], cols: number): { shown: StripEntry[]; rest: StripEntry[] } {
  const cap = Math.max(MIN_COLS, cols);
  if (entries.length <= cap) return { shown: [...entries], rest: [] };
  return { shown: entries.slice(0, cap - 1), rest: entries.slice(cap - 1) };
}

function useStripCols(): [(el: HTMLDivElement | null) => void, number] {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [cols, setCols] = useState(MAX_COLS);
  useLayoutEffect(() => {
    if (!el) return;
    const sync = (w: number) =>
      setCols((prev) => {
        const next = fileStripCols(w);
        return prev === next ? prev : next;
      });
    sync(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => sync(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, cols];
}

function tileCaption(f: FileMeta, files: readonly FileMeta[], subs: readonly Subscription[]) {
  const label = fileLabel(f, files, subs);
  const full = label.item ?? label.head;
  if (f.kind === 'charge' && f.date) {
    const kind = full.startsWith(`${f.date} `) ? full.slice(f.date.length + 1) : t('files.kind.charge');
    return { title: f.date, sub: kind, tip: full };
  }
  if (f.kind === 'receipt' && f.date) {
    const person = fileReceiptPerson(f, subs);
    const scope = fileBadgeKind(f, subs);
    const scopeText = scope === 'carpool' ? t('files.badge.carpool') : scope === 'proxy' ? t('files.badge.proxy') : t('files.kind.receipt');
    return { title: person ? `${person} ${f.date.slice(5)}` : f.date, sub: scopeText, tip: full };
  }
  if (f.kind === 'contract' && f.date) return { title: f.date, sub: t('files.kind.contract'), tip: full };
  return { title: full, ext: FILE_EXT[f.mime].toUpperCase(), size: sizeLabel(f.size), tip: full };
}

/** 采样缩略图中心区域亮度，让叠在真实收据上的 +N 数字自动切黑/白字 */
function sampleTone(img: HTMLImageElement): 'dark' | 'light' {
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) return 'dark';
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const ctx = canvas.getContext('2d');
    if (!ctx) return 'dark';
    // 缩略图用 object-fit: cover + top center 裁剪，中心区落在顶部 4:3 画面正中
    const cropH = Math.min(h, Math.round((w * 3) / 4));
    ctx.drawImage(img, w * 0.25, cropH * 0.25, w * 0.5, cropH * 0.5, 0, 0, 8, 8);
    const data = ctx.getImageData(0, 0, 8, 8).data;
    let lum = 0;
    for (let i = 0; i < data.length; i += 4) lum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    return lum / (data.length / 4) < 135 ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 叠卡封面：正常展示余下最新文件，不盖整张暗蒙层，只按画面明暗自适应 +N 数字颜色 */
function MoreCover({ file, count }: { file?: FileMeta; count: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [tone, setTone] = useState<'auto' | 'dark' | 'light'>(() => (file?.thumb ? 'dark' : 'auto'));
  const measure = (img: HTMLImageElement | null) => {
    if (img && img.complete && img.naturalWidth > 0) setTone(sampleTone(img));
  };
  useEffect(() => {
    measure(ref.current?.querySelector('img') ?? null);
  }, [file?.id, file?.thumb]);
  return (
    <span
      ref={ref}
      className={`dt-more-layer l1 tone-${tone}`}
      onLoadCapture={(e) => {
        if (e.target instanceof HTMLImageElement) setTone(sampleTone(e.target));
      }}
    >
      {file && <FileThumb f={file} />}
      <span className="dt-more-num">+{count}</span>
    </span>
  );
}
export const canAttach = (state: AppState) => !state.readonly && state.filesEnabled !== false;

export function FilesCard({
  sub,
  state,
  today,
  pending,
  onFiles,
  onOpen,
  onFilesPage,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  pending: Array<{ key: string; name: string }>;
  onFiles: (files: File[]) => void;
  onOpen?: (s: Subscription) => void;
  /** 到文件页只看这个订阅 */
  onFilesPage?: () => void;
}) {
  const all = state.files ?? [];
  const ordered = orderDetailFiles(filesOf(all, sub.id));
  const [open, setOpen] = useState<string>();
  const [stripRef, cols] = useStripCols();
  const can = canAttach(state);
  const entries: StripEntry[] = [
    ...pending.map((p): StripEntry => ({ type: 'pending', key: p.key, name: p.name })),
    ...ordered.map((f): StripEntry => ({ type: 'file', f })),
  ];
  const single = entries.length === 1 ? entries[0] : undefined;
  const { shown, rest } = sliceFileStrip(entries, cols);
  const restFiles = rest.filter((x): x is { type: 'file'; f: FileMeta } => x.type === 'file').map((x) => x.f);
  const restSpan = fileDateSpan(restFiles);
  const restTip = fileDateSpan(restFiles, true);
  return (
    <>
      {entries.length > 0 && (
        <Panel
          className="dt-files"
          title={t('files.card')}
          aside={
            onFilesPage &&
            ordered.length > 0 && (
              <button type="button" className="dt-btn sm dt-add" onClick={onFilesPage}>
                {t('files.count', { count: ordered.length })}
                <Icon name="right" size={14} />
              </button>
            )
          }
        >
          {single ? (
            <div className="dt-file-list">
              {single.type === 'pending' ? (
                <div className="dt-file loading" aria-busy="true">
                  <span className="dt-file-thumb" />
                  <span className="dt-file-text">
                    <b>{single.name}</b>
                  </span>
                </div>
              ) : (
                (() => {
                  const f = single.f;
                  const label = fileLabel(f, all, state.subscriptions);
                  return (
                    <button type="button" className="dt-file" onClick={() => setOpen(f.id)}>
                      <span className="dt-file-thumb">
                        <FileThumb f={f} />
                      </span>
                      <span className="dt-file-text">
                        <b>{label.item ?? label.head}</b>
                        <span className="file-meta">
                          <FileBadges f={f} subs={state.subscriptions} compact />
                          <span>{FILE_EXT[f.mime].toUpperCase()}</span>
                          <span>{sizeLabel(f.size)}</span>
                        </span>
                      </span>
                    </button>
                  );
                })()
              )}
            </div>
          ) : (
            <div ref={stripRef} className="dt-file-strip" style={{ '--cols': cols } as CSSProperties}>
              {shown.map((entry) => {
                if (entry.type === 'pending')
                  return (
                    <div key={entry.key} className="dt-file-tile loading" aria-busy="true">
                      <span className="dt-tile-thumb" />
                      <span className="dt-tile-text">
                        <b>{entry.name}</b>
                      </span>
                    </div>
                  );
                const f = entry.f;
                const cap = tileCaption(f, all, state.subscriptions);
                return (
                  <button key={f.id} type="button" className="dt-file-tile" title={cap.tip} onClick={() => setOpen(f.id)}>
                    <span className="dt-tile-thumb">
                      <FileThumb f={f} />
                      <FileBadges f={f} subs={state.subscriptions} compact className="dt-tile-tags" />
                    </span>
                    <span className="dt-tile-text">
                      <b>{cap.title}</b>
                      <span className="file-meta">
                        {'sub' in cap ? (
                          <span>{cap.sub}</span>
                        ) : (
                          <>
                            <span>{cap.ext}</span>
                            <span>{cap.size}</span>
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
              {rest.length > 0 && (
                <button
                  type="button"
                  className="dt-file-tile dt-file-more"
                  title={restTip || t('files.count', { count: ordered.length })}
                  onClick={() => (onFilesPage ? onFilesPage() : restFiles[0] && setOpen(restFiles[0].id))}
                >
                  <span className="dt-more-pile">
                    {rest.length >= 3 && (
                      <span className="dt-more-layer l3" aria-hidden="true">
                        {restFiles[2] && <FileThumb f={restFiles[2]} />}
                      </span>
                    )}
                    <span className="dt-more-layer l2" aria-hidden="true">
                      {restFiles[1] && <FileThumb f={restFiles[1]} />}
                    </span>
                    <MoreCover key={restFiles[0]?.id ?? 'none'} file={restFiles[0]} count={rest.length} />
                  </span>
                  <span className="dt-tile-text">
                    <b>{onFilesPage ? t('files.tab.all') : t('files.count', { count: rest.length })}</b>
                    <span className="file-meta">
                      <span>{restSpan || t('files.count', { count: ordered.length })}</span>
                    </span>
                  </span>
                </button>
              )}
            </div>
          )}
        </Panel>
      )}
      <FileDrop enabled={can && !open} onFiles={onFiles} />
      {open &&
        createPortal(
          <FileSheet
            id={open}
            list={ordered}
            state={state}
            today={today}
            onClose={() => setOpen(undefined)}
            onOpenSub={(id) => {
              setOpen(undefined);
              const s = state.subscriptions.find((x) => x.id === id);
              if (s && s.id !== sub.id) onOpen?.(s);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * 记一笔 / 改一笔扣款时的「文件」分组：传上去即挂在这笔扣款（订阅 + 日期）上，取消弹窗也保留；
 * 保存时日期改了，由调用方用 moveTo 把这里列出的文件一起挪到新日期
 */
export function useChargeFiles(sub: Subscription, today: string, date: string, originalDate?: string) {
  const { state } = useStore();
  const all = state?.files ?? [];
  const [mine, setMine] = useState<string[]>([]);
  const up = useUpload({ subId: sub.id, kind: 'charge', date });
  const add = (files: File[]) => void up.uploadAsync(files).then((done) => setMine((m) => [...m, ...done.map((f) => f.id)]));
  const [picker, pick] = useFilePicker(add);
  const list = all.filter((f) => mine.includes(f.id) || (!!originalDate && f.subId === sub.id && f.kind === 'charge' && f.date === originalDate));
  const [open, setOpen] = useState<string>();
  const can = !!state && canAttach(state);
  const moveTo = async (day: string) => {
    for (const f of list) if (f.subId === sub.id && f.kind === 'charge' && f.date !== day) await relinkFile(f, { subId: sub.id, kind: 'charge', date: day });
  };
  const group =
    state && (can || list.length > 0) ? (
      <Group title={t('files.card')}>
        {list.map((f) => (
          <Cell key={f.id} label={f.name} sub={`${FILE_EXT[f.mime].toUpperCase()}\n${sizeLabel(f.size)}`} onClick={() => setOpen(f.id)} />
        ))}
        {up.pending.map((p) => (
          <Cell key={p.key} label={p.name} />
        ))}
        {can && (
          <button type="button" className="cell tap pay-split-add" onClick={pick}>
            <Icon name="upload" />
            {t('files.add')}
          </button>
        )}
        {picker}
        <FileDrop enabled={can && !open} onFiles={add} />
        {open && createPortal(<FileSheet id={open} list={list} state={state} today={today} onClose={() => setOpen(undefined)} />, document.body)}
      </Group>
    ) : null;
  // 还在传的文件保存时挪不过去：传完才能保存
  return { group, moveTo, uploading: up.pending.length > 0 };
}

/**
 * 合租成员收款 / 代付收款表单里的「收款凭证」分组：
 * - 修改已有收款（带 receiptId）时，选好文件即直接上传并挂到这笔收款；日期改动时保存后同步挪过去。
 * - 新记一笔收款（还没有 receiptId）时，先在本地暂存已校验的文件，等收款保存成功拿到 id 后再上传，取消不会留下无主凭证。
 */
export function useReceiptFiles(sub: Subscription | undefined, today: string, date: string, receiptId?: string) {
  const { state } = useStore();
  const all = state?.files ?? [];
  const [queued, setQueued] = useState<Array<{ key: string; file: File }>>([]);
  const [open, setOpen] = useState<string>();
  const up = useUpload(sub && receiptId ? { subId: sub.id, kind: 'receipt', date, receiptId } : {});
  const list = sub && receiptId ? filesForReceipt(all, sub.id, receiptId) : [];
  const can = !!sub && !!state && canAttach(state);
  const add = (files: File[]) => {
    if (!sub) return;
    if (receiptId) {
      void up.uploadAsync(files);
      return;
    }
    void (async () => {
      const ok: Array<{ key: string; file: File }> = [];
      const bad: string[] = [];
      for (const file of files) {
        const res = await checkFile(file);
        if ('error' in res) bad.push(`${file.name}: ${res.error}`);
        else ok.push({ key: `${file.name}-${file.size}-${Date.now()}-${Math.random()}`, file });
      }
      if (ok.length) setQueued((q) => [...q, ...ok]);
      if (bad.length) toast(t('files.failed', { count: bad.length }), { kind: 'error', description: bad.join('\n') });
    })();
  };
  const [picker, pick] = useFilePicker(add);
  const syncAfterSave = async (savedReceiptId: string, savedDate: string) => {
    if (!sub) return;
    if (receiptId) {
      for (const f of list) {
        if (f.date !== savedDate) await relinkFile(f, { subId: sub.id, kind: 'receipt', date: savedDate, receiptId: savedReceiptId });
      }
      return;
    }
    if (!queued.length) return;
    const { failed } = await uploadFiles(
      queued.map((x) => x.file),
      { subId: sub.id, kind: 'receipt', date: savedDate, receiptId: savedReceiptId },
    );
    setQueued([]);
    if (failed.length)
      toast(t('files.failed', { count: failed.length }), { kind: 'error', description: failed.map((x) => `${x.name}: ${x.error}`).join('\n') });
  };
  const title = sub?.proxy ? t('files.badge.proxy') : sub?.share ? t('files.badge.carpool') : t('files.card');
  const group =
    sub && state && (can || list.length > 0 || queued.length > 0) ? (
      <Group title={title}>
        {list.map((f) => (
          <Cell key={f.id} label={f.name} sub={`${FILE_EXT[f.mime].toUpperCase()}\n${sizeLabel(f.size)}`} onClick={() => setOpen(f.id)}>
            {f.dupReceipt ? <FileBadges f={f} subs={state.subscriptions} compact /> : undefined}
          </Cell>
        ))}
        {queued.map((q) => (
          <Cell key={q.key} label={q.file.name} sub={sizeLabel(q.file.size)}>
            <IconButton type="button" onClick={() => setQueued((xs) => xs.filter((x) => x.key !== q.key))} aria-label={t('common.delete')}>
              <Icon name="x" size={14} />
            </IconButton>
          </Cell>
        ))}
        {up.pending.map((p) => (
          <Cell key={p.key} label={p.name} />
        ))}
        {can && (
          <button type="button" className="cell tap pay-split-add" onClick={pick}>
            <Icon name="upload" />
            {t('files.addReceipt')}
          </button>
        )}
        {picker}
        <FileDrop enabled={can && !open} onFiles={add} />
        {open && createPortal(<FileSheet id={open} list={list} state={state} today={today} onClose={() => setOpen(undefined)} />, document.body)}
      </Group>
    ) : null;
  return { group, syncAfterSave, uploading: up.pending.length > 0 };
}

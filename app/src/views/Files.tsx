// 文件页：按订阅或按月份分组，订阅组里按期列出凭证，没传的那一期留一张虚线占位、点开或拖进去就挂到那一笔；
// 筛选沿用订阅页（状态、分类、支付方式、搜索）另加订阅与年份；拖文件进窗口即上传，勾选后打包下载或删除。
import { useEffect, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
import { FILE_EXT, fileCoverage, fileMethod, fileTitle, fileYear, slotLabel, type FileCoverage, type FileMeta, type FileSlot } from '../../../shared/files.ts';
import { monthLabel } from '../../../shared/format.ts';
import { t } from '../../../shared/i18n.ts';
import { listHaystack, listStatus, listWords } from '../../../shared/list-scope.ts';
import { bundleView } from '../../../shared/bundle.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { FacetRow } from '../components/FacetRow.tsx';
import { FileDrop } from '../components/FileDrop.tsx';
import { useFilePicker, useUpload } from '../components/FileUpload.tsx';
import { fileLabel, FileSheet, FileThumb } from '../components/FileSheet.tsx';
import { Icon } from '../components/icons.tsx';
import { Seg } from '../components/inputs.tsx';
import { CatIcon, MethodMark, SubIcon } from '../components/marks.tsx';
import { ask } from '../components/overlays.tsx';
import { Picker } from '../components/Picker.tsx';
import { IconButton, Toolbar } from '../components/ui.tsx';
import { categories } from '../derive.ts';
import { knownRatio, layoutMasonry, rememberRatio, type Placed } from '../file-masonry.ts';
import { deleteFiles, sizeLabel, SUB_PARAM, uploadFiles, zipUrl } from '../files.ts';
import { onRoute } from '../router.ts';
import { toast } from '../toast.ts';
import { usePref } from '../prefs.ts';
import { useTextSearch } from '../use-search.ts';

type Tab = 'all' | 'pending' | 'missing';
/** 拼贴：按比例的瀑布流、略歪着摊开；卡片：整齐的等大网格；列表：一行一个 */
type View = 'loose' | 'grid' | 'list';
const isView = (v: string): v is View => v === 'loose' || v === 'grid' || v === 'list';
/** 按订阅：一个订阅一组，按期列出凭证与缺的那几期；按月份：按文件日期分组 */
type Group = 'sub' | 'month' | 'year' | 'cat';
const isGroup = (v: string): v is Group => v === 'sub' || v === 'month' || v === 'year' || v === 'cat';
type Facet = 'sub' | 'status' | 'cat' | 'pay' | 'year';
const ALL: Record<Facet, string> = { sub: 'all', status: 'all', cat: 'all', pay: 'all', year: 'all' };

const STATUSES = (): Array<[string, string]> => [
  ['all', t('list.all')],
  ['live', t('list.status.active')],
  ['upcoming', t('list.status.upcoming')],
  ['trial', t('list.status.trialShort')],
  ['paused', t('list.status.paused')],
  ['lifetime', t('list.status.lifetime')],
  ['ended', t('list.status.ended')],
  ['terminated', t('list.status.terminated')],
];

/** 文件排序：有日期的按日期，资料与未关联按上传时间，新的在前 */
const when = (f: FileMeta) => f.date ?? f.orphan?.date ?? f.createdAt.slice(0, 10);
const newest = (a: FileMeta, b: FileMeta) => when(b).localeCompare(when(a)) || b.createdAt.localeCompare(a.createdAt);

/** 每张纸按 id 固定一个小角度和偏移，像随手摊在桌上；刷新后位置不变 */
function lay(id: string): CSSProperties {
  let h = 0;
  for (const c of id) h = (Math.imul(h, 31) + c.charCodeAt(0)) | 0;
  const r = (shift: number) => (((h >>> shift) & 255) / 255 - 0.5) * 2;
  return { '--tilt': `${(r(0) * 1.6).toFixed(2)}deg`, '--dx': `${(r(8) * 3).toFixed(1)}px`, '--dy': `${(r(16) * 3).toFixed(1)}px` } as CSSProperties;
}

/** 容器的内容宽度；元素换了（空状态与网格切换）会重新观察 */
function useWidth(): [(el: HTMLElement | null) => void, number] {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width];
}

const box = (p: Placed | undefined): CSSProperties | undefined => p && { position: 'absolute', left: p.left, top: p.top, width: p.width, height: p.height };

/** 一组里的一项：文件、缺凭证的那一期、正在上传的占位 */
type Item = { type: 'file'; f: FileMeta } | { type: 'slot'; sub: Subscription; slot: FileSlot } | { type: 'pending'; key: string; name: string };
const itemKey = (x: Item) => (x.type === 'file' ? x.f.id : x.type === 'slot' ? `slot:${x.sub.id}:${x.slot.kind}:${x.slot.date}` : x.key);
const itemDate = (x: Item) => (x.type === 'file' ? when(x.f) : x.type === 'slot' ? x.slot.date : '9999');

interface Section {
  key: string;
  /** 订阅组：卡片上不再重复订阅名，只写挂的那一项 */
  sub?: Subscription;
  head: ReactNode;
  items: Item[];
}

export function Files({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const ro = !!state.readonly;
  const enabled = state.filesEnabled !== false;
  const all = state.files ?? [];
  const subs = state.subscriptions;
  const subOf = new Map(subs.map((s) => [s.id, s]));
  const [tab, setTab] = useState<Tab>('all');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Record<Facet, string>>(ALL);
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState<string>();
  const { pending, upload } = useUpload();
  const [uploadInput, pickUpload] = useFilePicker(upload);
  const [busy, setBusy] = useState<string[]>([]);
  const [view, setView] = usePref<View>('files-view', 'loose', isView);
  const [group, setGroup] = usePref<Group>('files-group', 'sub', isGroup);
  const [wrapRef, width] = useWidth();
  const [, setRatioRev] = useState(0);
  const onRatio = (id: string) => (r: number) => rememberRatio(id, r) && setRatioRev((n) => n + 1);
  const canUpload = enabled && !ro;
  // 从订阅详情跳来（files?sub=）：只看这个订阅，查询串用完即去掉，清除筛选后刷新不会再套上
  useEffect(() => {
    const apply = () => {
      const id = new URLSearchParams(location.search).get(SUB_PARAM);
      if (!id) return;
      history.replaceState(history.state, '', location.pathname);
      setTab('all');
      setQ('');
      setSel({ ...ALL, sub: id });
    };
    apply();
    return onRoute(apply);
  }, []);

  const title = (f: FileMeta) => fileTitle(f, all, subs);
  const viewOf = (s: Subscription) => bundleView(s, subs);
  const subHay = new Map<string, string>();
  const hayOf = (s: Subscription) => {
    let h = subHay.get(s.id);
    if (h == null) subHay.set(s.id, (h = listHaystack(state, s, today).toLowerCase()));
    return h;
  };
  const hay = all.map((f) => {
    const s = f.subId ? subOf.get(f.subId) : undefined;
    return [title(f), f.name, s ? hayOf(s) : ''].join(' ').toLowerCase();
  });
  const matches = useTextSearch(hay);
  const words = listWords(q);
  const subFacet = sel.sub !== 'all' || sel.status !== 'all' || sel.cat !== 'all' || sel.pay !== 'all';
  /** 订阅类筛选：选了任何一项时，未关联与已删除订阅的文件不出现 */
  const subOk = (s: Subscription | undefined, anchor: Pick<FileMeta, 'kind' | 'date'>, skip?: Facet) => {
    // 选定了订阅时只剩订阅与年份两行，藏起来的状态、分类、付款方式不参与筛选（数「全部」时照算，与点回全部后一致）
    const keys = sel.sub !== 'all' && skip !== 'sub' ? (['sub'] as const) : (['sub', 'status', 'cat', 'pay'] as const);
    const facets = keys.filter((k) => k !== skip && sel[k] !== 'all');
    if (!facets.length) return true;
    if (!s) return false;
    if (facets.includes('sub') && s.id !== sel.sub) return false;
    if (facets.includes('status') && listStatus(viewOf(s), today) !== sel.status) return false;
    if (facets.includes('cat') && s.category !== sel.cat) return false;
    if (facets.includes('pay') && fileMethod(anchor, s, today) !== sel.pay) return false;
    return true;
  };
  /** skip 用于计算某一维度各选项的数量：其他维度的条件照算 */
  const hit = (f: FileMeta, i: number, skip?: Facet) => {
    if (tab === 'pending' && f.subId) return false;
    if (tab === 'missing') return false;
    if (words.length && !words.every((w) => matches(w, hay[i]))) return false;
    if (skip !== 'year' && sel.year !== 'all' && fileYear(f) !== sel.year) return false;
    return subOk(f.subId ? subOf.get(f.subId) : undefined, f, skip);
  };

  // 凭证覆盖：只算有文件的订阅（一份都没传过的不追踪）
  const coverage = new Map<string, FileCoverage>();
  for (const s of subs) if (all.some((f) => f.subId === s.id)) coverage.set(s.id, fileCoverage(s, all, today));
  const holes = [...coverage].flatMap(([id, c]) => c.slots.filter((x) => !x.files.length).map((slot) => ({ sub: subOf.get(id)!, slot })));
  const holeOk = (h: { sub: Subscription; slot: FileSlot }, skip?: Facet) => {
    if (tab === 'pending') return false;
    if (words.length && !words.every((w) => hayOf(h.sub).includes(w.toLowerCase()))) return false;
    if (skip !== 'year' && sel.year !== 'all' && h.slot.date.slice(0, 4) !== sel.year) return false;
    return subOk(h.sub, { kind: h.slot.kind, date: h.slot.date }, skip);
  };

  const count = (skip: Facet, key: (s: Subscription | undefined, anchor: Pick<FileMeta, 'kind' | 'date'>) => string | undefined) => {
    const n = new Map<string, number>();
    let total = 0;
    const add = (k: string | undefined) => {
      total++;
      if (k != null) n.set(k, (n.get(k) ?? 0) + 1);
    };
    all.forEach((f, i) => hit(f, i, skip) && add(key(f.subId ? subOf.get(f.subId) : undefined, f)));
    if (tab === 'missing') for (const h of holes) if (holeOk(h, skip)) add(key(h.sub, h.slot));
    n.set('all', total);
    return n;
  };
  const subN = count('sub', (s) => s?.id);
  const statusN = count('status', (s) => s && listStatus(viewOf(s), today));
  const catN = count('cat', (s) => s?.category);
  const payN = count('pay', (s, a) => s && fileMethod(a, s, today));
  const yearN = count('year', (_, a) => (a.date ?? '').slice(0, 4) || undefined);
  // 年份选项：文件按 fileYear，缺凭证按那一期的年份
  const years = [...new Set([...all.map(fileYear), ...(tab === 'missing' ? holes.map((h) => h.slot.date.slice(0, 4)) : [])])].sort().reverse();
  const yearCount = (y: string) => (tab === 'missing' ? (yearN.get(y) ?? 0) : all.filter((f, i) => fileYear(f) === y && hit(f, i, 'year')).length);
  const cats = categories()
    .map((c) => c.name)
    .filter((c) => all.some((f) => f.subId && subOf.get(f.subId)?.category === c));
  const filed = subs.filter((s) => coverage.has(s.id));
  const pickedSub = sel.sub === 'all' ? undefined : subOf.get(sel.sub);
  // 订阅行在点回「全部」后仍保留刚才那个订阅，可以再点回去，不会整行消失
  const [lastSub, setLastSub] = useState<string>();
  useEffect(() => {
    if (sel.sub !== 'all') setLastSub(sel.sub);
  }, [sel.sub]);
  const rowSub = pickedSub ?? (lastSub ? subOf.get(lastSub) : undefined);
  // 只看一个订阅时年份只列它有的；都在同一年就不显示年份这一行
  const yearOpts = pickedSub ? years.filter((y) => y === sel.year || yearCount(y) > 0) : years;

  const rows = all.filter((f, i) => hit(f, i)).sort(newest);
  // 凭证不是必传项：缺的期只在「缺凭证」里出现，默认视图不催
  const shownHoles = tab === 'missing' ? holes.filter((h) => holeOk(h)) : [];
  const pendingN = all.filter((f) => !f.subId).length;
  const dirty = subFacet || sel.year !== 'all' || !!q;
  const totalSize = all.reduce((a, f) => a + f.size, 0);
  // 只对当前看得到的生效：筛掉的已选文件不会被一起删掉或打包
  const pickedRows = picked.filter((id) => rows.some((f) => f.id === id));

  // 待关联的文件没有订阅可分：只按月 / 按年，其余分法在这里按月显示，不改动保存的偏好
  const g: Group = tab === 'pending' && (group === 'sub' || group === 'cat') ? 'month' : group;
  const sections = buildSections();
  const order = sections.flatMap((s) => s.items.flatMap((x) => (x.type === 'file' ? [x.f] : [])));

  function buildSections(): Section[] {
    const ups: Item[] = pending.map((p) => ({ type: 'pending', ...p }));
    const fileItems = (fs: FileMeta[]): Item[] => fs.map((f) => ({ type: 'file', f }));
    const visible = new Set(rows.map((f) => f.id));
    const holeItems = new Map<string, Item[]>();
    for (const h of shownHoles) holeItems.set(h.sub.id, [...(holeItems.get(h.sub.id) ?? []), { type: 'slot', ...h }]);
    const withUps = (out: Section[]) => (ups.length ? [{ key: 'up', head: null, items: ups }, ...out] : out);
    const slotItems: Item[] = shownHoles.map((h) => ({ type: 'slot', ...h }));
    if (g === 'month' || g === 'year') {
      // 按月 / 按年：文件与缺的期按日期排，新的在前
      const len = g === 'month' ? 7 : 4;
      const spans = new Map<string, Item[]>();
      for (const x of [...fileItems(rows), ...slotItems].sort((a, b) => itemDate(b).localeCompare(itemDate(a)))) {
        const k = itemDate(x).slice(0, len);
        spans.set(k, [...(spans.get(k) ?? []), x]);
      }
      return withUps(
        [...spans].map(([k, items]) => ({
          key: k,
          head: <span className="file-sec-name">{g === 'month' ? monthLabel(k, { long: true }) : k}</span>,
          items,
        })),
      );
    }
    if (g === 'cat') {
      // 按分类：取所挂订阅的分类，与筛选里的分类同序；没分类的、没挂订阅的放最后
      const byCat = new Map<string, Item[]>();
      const loose: FileMeta[] = [];
      for (const x of [...fileItems(rows), ...slotItems].sort((a, b) => itemDate(b).localeCompare(itemDate(a)))) {
        const s = x.type === 'file' ? (x.f.subId ? subOf.get(x.f.subId) : undefined) : x.type === 'slot' ? x.sub : undefined;
        if (!s) {
          if (x.type === 'file') loose.push(x.f);
        } else byCat.set(s.category ?? '', [...(byCat.get(s.category ?? '') ?? []), x]);
      }
      const keys = [...cats.filter((c) => byCat.has(c)), ...[...byCat.keys()].filter((c) => !cats.includes(c))];
      const out: Section[] = keys.map((c) => ({
        key: `cat:${c}`,
        head: c ? (
          <>
            <CatIcon cat={c} size={16} />
            <span className="file-sec-name">{c}</span>
          </>
        ) : (
          <span className="file-sec-name">{t('scope.uncategorized')}</span>
        ),
        items: byCat.get(c)!,
      }));
      if (loose.length) out.push({ key: 'loose', head: <span className="file-sec-name">{t('files.unlinked')}</span>, items: fileItems(loose) });
      return withUps(out);
    }
    // 按订阅（缺凭证一栏也按订阅分组）：订阅按最近一项的日期排，新的在前
    const out: Array<Section & { at: string }> = [];
    for (const s of filed) {
      const c = coverage.get(s.id)!;
      const items: Item[] = [];
      for (const slot of c.slots) {
        const fs = slot.files.filter((f) => visible.has(f.id));
        if (fs.length) items.push(...fileItems(fs));
        else if (!slot.files.length) items.push(...(holeItems.get(s.id) ?? []).filter((x) => x.type === 'slot' && x.slot === slot));
      }
      items.push(...fileItems(c.rest.filter((f) => visible.has(f.id))));
      if (!items.length) continue;
      out.push({
        key: s.id,
        sub: s,
        items,
        // 按订阅自身最近的一期排，不随筛选和补传跳动
        at: [...c.slots.map((x) => x.date), ...c.rest.map(when)].reduce((a, d) => (d > a ? d : a), ''),
        head: (
          <>
            <button
              type="button"
              className="file-sec-sub"
              onClick={() => setSel((x) => ({ ...x, sub: x.sub === s.id ? 'all' : s.id }))}
              aria-pressed={sel.sub === s.id}
            >
              <SubIcon sub={s} size={22} />
              <span className="file-sec-name">{s.name}</span>
            </button>
            {tab === 'missing' && c.slots.length > 0 && (
              <span className="file-sec-cov">{t('files.coverage', { covered: c.covered, total: c.slots.length })}</span>
            )}
            <IconButton className="file-sec-open" onClick={() => onOpen(s)} aria-label={s.name} title={s.name}>
              <Icon name="right" size={16} />
            </IconButton>
          </>
        ),
      });
    }
    out.sort((a, b) => b.at.localeCompare(a.at));
    // 已删除订阅的文件按原订阅名分组；未关联的放最后
    const gone = new Map<string, FileMeta[]>();
    const loose: FileMeta[] = [];
    for (const f of rows) {
      if (f.subId) continue;
      if (f.orphan) gone.set(f.orphan.name, [...(gone.get(f.orphan.name) ?? []), f]);
      else loose.push(f);
    }
    const tail: Section[] = [...gone].map(([name, fs]) => ({
      key: `gone:${name}`,
      head: (
        <>
          <span className="badge">{t('files.deleted')}</span>
          <span className="file-sec-name">{name}</span>
        </>
      ),
      items: fileItems(fs),
    }));
    if (loose.length) tail.push({ key: 'loose', head: <span className="file-sec-name">{t('files.unlinked')}</span>, items: fileItems(loose) });
    return [...(ups.length ? [{ key: 'up', head: null, items: ups }] : []), ...out, ...tail];
  }

  const setFacet = (k: Facet) => (v: string) => setSel((x) => ({ ...x, [k]: v }));
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const removePicked = async () => {
    if (!(await ask(t('files.deleteN', { count: pickedRows.length }), { ok: t('common.delete') }))) return;
    try {
      await deleteFiles(pickedRows);
      setPicked([]);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    }
  };
  /** 传到缺的那一期：直接挂到那一笔扣款或那一期合同 */
  const fillSlot = async (sub: Subscription, slot: FileSlot, files: File[]) => {
    const key = `slot:${sub.id}:${slot.kind}:${slot.date}`;
    setBusy((b) => [...b, key]);
    try {
      const { done, failed } = await uploadFiles(files, { subId: sub.id, kind: slot.kind, date: slot.date });
      if (failed.length)
        toast(t('files.failed', { count: failed.length }), { kind: 'error', description: failed.map((x) => `${x.name}: ${x.error}`).join('\n') });
      else if (done.length) toast(t('files.uploaded', { count: done.length }));
    } finally {
      setBusy((b) => b.filter((x) => x !== key));
    }
  };

  const empty = all.length === 0 && pending.length === 0;
  const nothing = sections.every((s) => !s.items.length);

  return (
    <>
      {/* 与钱包「添加」同款：桌面是文字按钮，手机走页面的添加入口 */}
      {uploadInput}
      <Toolbar
        title={t('files.title')}
        sub={all.length ? t('files.summary', { count: all.length, size: sizeLabel(totalSize) }) : undefined}
        onAdd={canUpload ? pickUpload : undefined}
        addLabel={t('files.upload')}
      >
        {all.length > 0 && (
          <label className="tb-search">
            <Icon name="search" />
            <input
              type="search"
              value={q}
              placeholder={t('files.search')}
              aria-label={t('files.search')}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), setQ(''))}
            />
            {q && (
              <IconButton type="button" className="tb-search-x" onClick={() => setQ('')} aria-label={t('common.clear')}>
                <Icon name="x" size={15} />
              </IconButton>
            )}
          </label>
        )}
        {/* 全部 / 待关联 / 缺凭证 三选一，后两项不常用，收进下拉，顶栏只留一个按钮 */}
        {all.length > 0 && (
          <Picker
            variant="btn"
            value={tab}
            onChange={(v) => (setTab(v), setPicked([]))}
            ariaLabel={t('files.title')}
            options={[
              { value: 'all', label: t('files.tab.all') },
              { value: 'pending', label: pendingN ? `${t('files.tab.pending')} ${pendingN}` : t('files.tab.pending') },
              { value: 'missing', label: t('files.tab.missing') },
            ]}
          />
        )}
        {all.length > 0 && (
          <Picker
            variant="btn"
            value={g}
            onChange={setGroup}
            ariaLabel={t('files.group.label')}
            options={[
              ...(tab === 'pending' ? [] : [{ value: 'sub' as const, label: t('files.group.sub') }]),
              { value: 'month' as const, label: t('files.group.month') },
              { value: 'year' as const, label: t('files.group.year') },
              ...(tab === 'pending' ? [] : [{ value: 'cat' as const, label: t('files.group.cat') }]),
            ]}
          />
        )}
        {/* 视图切换之后是上传，上传固定在最右 */}
        {all.length > 0 && (
          <Seg
            small
            value={view}
            onChange={setView}
            options={[
              ['loose', t('files.view.loose')],
              ['grid', t('list.view.grid')],
              ['list', t('list.view.list')],
            ]}
          />
        )}
        {canUpload && (
          <button className="btn primary d-only" onClick={pickUpload}>
            <Icon name="upload" /> {t('files.upload')}
          </button>
        )}
      </Toolbar>
      <div className="page fade-in files-page">
        {all.length > 0 && tab !== 'pending' && (
          <div className="facets">
            {dirty && (
              <button
                className="facet-clear"
                onClick={() => {
                  setSel(ALL);
                  setQ('');
                }}
              >
                <Icon name="x" size={12} />
                {t('list.clear')}
              </button>
            )}
            {/* 订阅可能有几百个，不列成筛选项：点分组头或搜索名称进入，这里只显示当前选中的那个，点「全部」退出 */}
            {rowSub && (
              <FacetRow
                label={t('files.link.sub')}
                value={sel.sub}
                onChange={setFacet('sub')}
                options={[
                  { key: 'all', label: t('list.all'), n: subN.get('all') ?? 0 },
                  { key: rowSub.id, label: rowSub.name, icon: <SubIcon sub={rowSub} size={16} />, n: subN.get(rowSub.id) ?? 0 },
                ]}
              />
            )}
            {!pickedSub && (
              <>
                <FacetRow
                  label={t('list.facet.status')}
                  value={sel.status}
                  onChange={setFacet('status')}
                  options={STATUSES().map(([k, l]) => ({ key: k, label: l, n: statusN.get(k) ?? 0 }))}
                />
                <FacetRow
                  label={t('list.facet.category')}
                  value={sel.cat}
                  onChange={setFacet('cat')}
                  options={[
                    { key: 'all', label: t('list.all'), n: catN.get('all') ?? 0 },
                    ...cats.map((c) => ({ key: c, label: c, icon: <CatIcon cat={c} size={13} />, n: catN.get(c) ?? 0 })),
                  ]}
                />
                <FacetRow
                  label={t('list.facet.pay')}
                  value={sel.pay}
                  onChange={setFacet('pay')}
                  options={[
                    { key: 'all', label: t('list.all'), n: payN.get('all') ?? 0 },
                    ...state.methods.map((m) => ({ key: m.id, label: m.name, icon: <MethodMark m={m} size={16} />, n: payN.get(m.id) ?? 0 })),
                    { key: 'none', label: t('list.unassigned'), n: payN.get('none') ?? 0 },
                  ]}
                />
              </>
            )}
            {(!pickedSub || yearOpts.length > 1) && (
              <FacetRow
                label={t('files.year')}
                value={sel.year}
                onChange={setFacet('year')}
                options={[{ key: 'all', label: t('list.all'), n: yearN.get('all') ?? 0 }, ...yearOpts.map((y) => ({ key: y, label: y, n: yearCount(y) }))]}
              />
            )}
          </div>
        )}
        {empty ? (
          <FilesEmpty text={enabled ? t('files.empty') : t('core.file.noStorage')} />
        ) : nothing ? (
          <div className="empty">{t('files.noMatch')}</div>
        ) : (
          <div ref={wrapRef} className={`file-sections ${pickedRows.length ? 'picking' : ''}`}>
            {sections.map((sec) =>
              sec.items.length ? (
                <section key={sec.key} className="file-sec">
                  {sec.head && <header className="file-sec-head">{sec.head}</header>}
                  <SectionBody sec={sec} view={view} width={width} render={(x, style) => renderItem(x, sec, style)} renderRow={(x) => renderRow(x, sec)} />
                </section>
              ) : null,
            )}
          </div>
        )}
      </div>
      {pickedRows.length > 0 && (
        <div className="file-bar" role="toolbar">
          <span>{t('files.selected', { count: pickedRows.length })}</span>
          <button className="btn" onClick={() => setPicked([])}>
            {t('common.cancel')}
          </button>
          {!ro && (
            <button className="btn" onClick={removePicked}>
              <Icon name="trash" size={16} />
              {t('common.delete')}
            </button>
          )}
          <a className="btn primary" href={zipUrl(pickedRows)} download>
            <Icon name="download" size={16} />
            {t('files.downloadN', { count: pickedRows.length })}
          </a>
        </div>
      )}
      <FileDrop enabled={canUpload && !open} onFiles={upload} />
      {open && (
        <FileSheet
          id={open}
          list={order}
          state={state}
          today={today}
          onClose={() => setOpen(undefined)}
          onOpenSub={(id) => {
            const s = subOf.get(id);
            setOpen(undefined);
            if (s) onOpen(s);
          }}
        />
      )}
    </>
  );

  function slotProps(x: Extract<Item, { type: 'slot' }>) {
    return { loading: busy.includes(itemKey(x)), canUpload, onFiles: (files: File[]) => void fillSlot(x.sub, x.slot, files) };
  }

  /** 卡片底部信息条：订阅组里只写挂的那一项；其余写订阅名（带图标）与那一项 */
  function labelOf(f: FileMeta, sec: Section): { icon?: ReactNode; head: string; item?: ReactNode } {
    const label = fileLabel(f, all, subs);
    const s = f.subId ? subOf.get(f.subId) : undefined;
    if (sec.sub) return { head: label.item ?? label.head };
    if (s) return { icon: <SubIcon sub={s} size={14} />, head: label.head, item: label.item };
    if (label.gone)
      return {
        head: label.head,
        item: (
          <>
            <span className="badge">{t('files.deleted')}</span>
            {label.item}
          </>
        ),
      };
    return { head: label.head, item: sec.key === 'loose' ? undefined : <span className="badge">{t('files.unlinked')}</span> };
  }

  function renderItem(x: Item, sec: Section, style: CSSProperties | undefined): ReactNode {
    if (x.type === 'pending')
      return (
        <div key={x.key} className="file-card loading" aria-busy="true" style={style}>
          <div className="file-thumb" />
          <div className="file-body">
            <b>{x.name}</b>
          </div>
        </div>
      );
    if (x.type === 'slot') return <SlotCard key={itemKey(x)} x={x} sec={sec} style={style} {...slotProps(x)} />;
    const f = x.f;
    const on = pickedRows.includes(f.id);
    const label = labelOf(f, sec);
    return (
      <div key={f.id} className={`file-card ${on ? 'on' : ''}`} style={{ ...lay(f.id), ...style }}>
        <button type="button" className="file-hit" onClick={() => (pickedRows.length ? toggle(f.id) : setOpen(f.id))} aria-label={title(f)} />
        <div className="file-thumb">
          <FileThumb f={f} onRatio={onRatio(f.id)} />
        </div>
        <div className="file-body">
          <b title={label.head}>
            {label.icon}
            <span>{label.head}</span>
          </b>
          <span className="file-meta">
            {label.item && <span className="file-item">{label.item}</span>}
            <span>{FILE_EXT[f.mime].toUpperCase()}</span>
            <span>{sizeLabel(f.size)}</span>
          </span>
        </div>
        <button type="button" role="checkbox" aria-checked={on} className="file-check" onClick={() => toggle(f.id)} aria-label={t('files.select')}>
          <Icon name="check" size={12} />
        </button>
      </div>
    );
  }

  /** 列表里的支付列：这份文件那一项用的支付方式（与筛选同一口径） */
  function payOf(f: FileMeta): ReactNode {
    const s = f.subId ? subOf.get(f.subId) : undefined;
    const m = s && state.methods.find((x) => x.id === fileMethod(f, s, today));
    return m ? (
      <>
        <MethodMark m={m} size={14} />
        <span>{m.name}</span>
      </>
    ) : null;
  }

  function renderRow(x: Item, sec: Section): ReactNode {
    if (x.type === 'pending')
      return (
        <div key={x.key} className="file-row loading" aria-busy="true">
          <span className="file-row-thumb" />
          <span className="file-row-text">
            <b>{x.name}</b>
          </span>
        </div>
      );
    if (x.type === 'slot') return <SlotCard key={itemKey(x)} x={x} sec={sec} row {...slotProps(x)} />;
    const f = x.f;
    const on = pickedRows.includes(f.id);
    const label = labelOf(f, sec);
    return (
      <div key={f.id} className={`file-row ${on ? 'on' : ''}`}>
        <button type="button" className="file-hit" onClick={() => (pickedRows.length ? toggle(f.id) : setOpen(f.id))} aria-label={title(f)} />
        <span className="file-row-thumb">
          <FileThumb f={f} />
        </span>
        <span className="file-row-text">
          <b title={label.head}>
            {label.icon}
            <span>{label.head}</span>
          </b>
          {label.item && (
            <span className="file-meta">
              <span className="file-item">{label.item}</span>
            </span>
          )}
        </span>
        <span className="file-row-pay">{payOf(f)}</span>
        <span className="file-row-name" title={f.name}>
          {f.name}
        </span>
        <span className="file-row-up">{f.createdAt.slice(0, 10)}</span>
        <span className="file-row-type">{FILE_EXT[f.mime].toUpperCase()}</span>
        <span className="file-row-size">{sizeLabel(f.size)}</span>
        <button type="button" role="checkbox" aria-checked={on} className="file-check" onClick={() => toggle(f.id)} aria-label={t('files.select')}>
          <Icon name="check" size={12} />
        </button>
      </div>
    );
  }
}

/** 一组的内容：拼贴在桌面宽度用瀑布流，其余为整齐网格或列表 */
function SectionBody({
  sec,
  view,
  width,
  render,
  renderRow,
}: {
  sec: Section;
  view: View;
  width: number;
  render: (x: Item, style: CSSProperties | undefined) => ReactNode;
  renderRow: (x: Item) => ReactNode;
}) {
  if (view === 'list')
    return (
      <div className="file-rows">
        <div className="file-row file-row-head" aria-hidden="true">
          <span />
          <span>{t('files.card')}</span>
          <span className="file-row-pay">{t('list.facet.pay')}</span>
          <span className="file-row-name">{t('files.props.name')}</span>
          <span className="file-row-up">{t('files.props.uploaded')}</span>
          <span className="file-row-type">{t('files.props.type')}</span>
          <span className="file-row-size">{t('files.props.size')}</span>
          <span />
        </div>
        {sec.items.map(renderRow)}
      </div>
    );
  const masonry =
    view === 'loose'
      ? layoutMasonry(
          sec.items.map((x) => ({ key: itemKey(x), ratio: x.type === 'file' && x.f.thumb ? knownRatio(x.f.id) : undefined })),
          width,
        )
      : null;
  const placed = new Map(masonry?.items.map((p) => [p.key, p]));
  return (
    <div className={`file-grid ${masonry ? 'masonry' : ''} ${view === 'grid' ? 'compact' : ''}`} style={masonry ? { height: masonry.height } : undefined}>
      {sec.items.map((x) => render(x, box(placed.get(itemKey(x)))))}
    </div>
  );
}

/** 缺凭证的那一期：虚线占位，点开选文件或把文件拖进来，直接挂到这一笔 */
function SlotCard({
  x,
  sec,
  style,
  row,
  loading,
  canUpload,
  onFiles,
}: {
  x: Extract<Item, { type: 'slot' }>;
  sec: Section;
  style?: CSSProperties;
  row?: boolean;
  loading: boolean;
  canUpload: boolean;
  onFiles: (files: File[]) => void;
}) {
  const [over, setOver] = useState(false);
  const [input, pick] = useFilePicker(onFiles);
  const name = slotLabel(x.sub, x.slot);
  const can = canUpload && !loading;
  const drop = can
    ? {
        'data-drop': '',
        onDragOver: (e: DragEvent) => {
          if (![...e.dataTransfer.types].includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          e.dataTransfer.dropEffect = 'copy';
          setOver(true);
        },
        onDragLeave: () => setOver(false),
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          e.stopPropagation();
          setOver(false);
          const files = [...e.dataTransfer.files];
          if (files.length) onFiles(files);
        },
      }
    : {};
  const text = (
    <>
      {!sec.sub && <SubIcon sub={x.sub} size={14} />}
      <span>{sec.sub ? name : x.sub.name}</span>
    </>
  );
  const cls = `file-slot ${row ? 'file-row' : 'file-card'} ${over ? 'over' : ''} ${loading ? 'loading' : ''}`;
  return (
    <div className={cls} style={style} {...drop} aria-busy={loading || undefined}>
      <button type="button" className="file-hit" disabled={!can} onClick={pick} aria-label={t('files.uploadTo', { item: `${x.sub.name} ${name}` })} />
      {row ? (
        <>
          <span className="file-row-thumb file-slot-ico">
            <Icon name="upload" size={16} />
          </span>
          <span className="file-row-text">
            <b>{text}</b>
            {!sec.sub && (
              <span className="file-meta">
                <span className="file-item">{name}</span>
              </span>
            )}
          </span>
        </>
      ) : (
        <>
          <div className="file-thumb file-slot-ico">
            <Icon name="upload" size={28} />
          </div>
          <div className="file-body">
            <b>{text}</b>
            {!sec.sub && (
              <span className="file-meta">
                <span className="file-item">{name}</span>
              </span>
            )}
          </div>
        </>
      )}
      {input}
    </div>
  );
}

/** 空状态插图：一叠单据落进文件夹，线条用正文与分隔线的颜色，深浅色主题都成立 */
function FilesEmpty({ text }: { text: string }) {
  return (
    <div className="files-empty">
      <svg viewBox="0 0 220 160" width="220" height="160" aria-hidden="true" fill="none" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="110" cy="146" rx="78" ry="7" className="fe-shadow" />
        <g className="fe-doc back">
          <rect x="62" y="20" width="76" height="96" rx="8" />
          <path d="M76 42h40M76 54h48M76 66h30" />
        </g>
        <g className="fe-doc front">
          <rect x="86" y="10" width="76" height="96" rx="8" />
          <path d="M100 32h30M100 44h48M100 56h40M100 82h20M134 82h14" />
          <path d="M100 70h48" className="fe-dash" />
        </g>
        <path className="fe-folder" d="M40 70a8 8 0 0 1 8-8h34l10 10h80a8 8 0 0 1 8 8v54a8 8 0 0 1-8 8H48a8 8 0 0 1-8-8z" />
        <path className="fe-lip" d="M40 88h140" />
      </svg>
      <b>{text}</b>
    </div>
  );
}

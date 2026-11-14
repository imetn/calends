import type { AppState, PaymentMethod, Person, Settings, Subscription } from '../../shared/types.ts';
import { mergePeople, syncPerson } from '../../shared/people.ts';
import { resyncShares } from '../../shared/carpool.ts';
import { deleteMethodData, deleteSubscriptionSettings } from '../../shared/ledger-edit.ts';
import { renameInSubs, type Category } from '../../shared/categories.ts';
import { t } from '../../shared/i18n.ts';
import { writePref } from './prefs.ts';

export function createLedgerWrites(
  core: Pick<typeof import('./store.ts'), 'api' | 'getState' | 'syncFx' | 'write' | 'patchState' | 'replaceSyncedState' | 'isLedger' | 'upsertById'>,
) {
  const { api, getState, syncFx, write, patchState, replaceSyncedState, isLedger, upsertById } = core;
  /** 换上服务端改过的订阅（同步人的资料、合并、改分类名时一次改好几条）；没出现的保持不变 */
  const withSubs = (s: AppState, subs: Subscription[]): AppState => {
    const by = new Map(subs.map((x) => [x.id, x]));
    return { ...s, subscriptions: s.subscriptions.map((x) => by.get(x.id) ?? x) };
  };

  function saveSub(next: Subscription) {
    // 改了开始日期或周期后，新的扣款日需要补汇率
    setTimeout(() => void syncFx(), 500);
    const st = getState();
    const sub = resyncShares(
      st,
      st.subscriptions.find((x) => x.id === next.id),
      next,
    );
    return write(
      (s) => ({ ...s, subscriptions: upsertById(s.subscriptions, sub) }),
      () => api<Subscription>(`/api/subscriptions/${sub.id}`, { method: 'PUT', body: JSON.stringify(sub) }),
      // 服务端会规范化（补字段、时间戳）：本地换成它返回的那条，和下次同步拿到的一致；期间本地又改过这一条（更晚的写入）就不覆盖
      (s, saved) =>
        saved?.id === sub.id && s.subscriptions.find((x) => x.id === sub.id) === sub ? { ...s, subscriptions: upsertById(s.subscriptions, saved) } : s,
    );
  }

  function deleteSub(id: string) {
    // 服务端在同一事务里把它从公开页隐藏列表去掉（与 MCP delete_subscription 相同），本地同步
    return write(
      (s) => ({ ...s, subscriptions: s.subscriptions.filter((x) => x.id !== id), settings: deleteSubscriptionSettings(s.settings, id) }),
      () => api(`/api/subscriptions/${id}`, { method: 'DELETE' }),
    );
  }

  /** 钱包卡片换顺序：按新顺序重写每张卡的 order */
  function reorderMethods(ids: string[]) {
    const prev = getState().methods;
    const next = ids.map((id, i) => ({ ...prev.find((m) => m.id === id)!, order: i }));
    // 全部重写，避免本地数据过期时出现重复的序号；部分失败时整体回滚并强制同步，以服务端为准
    return write(
      (s) => ({ ...s, methods: next }),
      () => Promise.all(next.map((m) => api(`/api/methods/${m.id}`, { method: 'PUT', body: JSON.stringify(m) }))),
    );
  }

  function saveMethod(m: PaymentMethod) {
    return write(
      (s) => ({ ...s, methods: upsertById(s.methods, m) }),
      () => api<PaymentMethod>(`/api/methods/${m.id}`, { method: 'PUT', body: JSON.stringify(m) }),
      (s, saved) => (saved?.id === m.id && s.methods.find((x) => x.id === m.id) === m ? { ...s, methods: upsertById(s.methods, saved) } : s),
    );
  }

  /**
   * 删除支付方式：订阅、阶段、单笔扣款、拆分来源与默认支付方式里的引用由服务端在同一事务里处理（与 MCP 删卡同一套 deleteMethodData）。
   * into 为另一张卡的 id 时迁过去，null 清空引用；有引用时必须二选一，否则服务端拒绝。
   */
  async function deleteMethod(id: string, into?: string | null) {
    const query = into ? `?into=${encodeURIComponent(into)}` : into === null ? '?clear=1' : '';
    await write(
      (s) => {
        const d = deleteMethodData(s, id, into);
        return withSubs({ ...s, methods: s.methods.filter((x) => x.id !== id), settings: d.settings }, d.subscriptions);
      },
      () => api<{ subscriptions: Subscription[] }>(`/api/methods/${id}${query}`, { method: 'DELETE' }),
      (s, r) => withSubs(s, r.subscriptions),
    );
  }

  /** 保存一个人：称呼、联系方式同步到所有引用他的成员、代付上（本地先同步，服务端再同步一遍并返回结果） */
  async function savePerson(p: Person) {
    const r = await write(
      (s) => withSubs({ ...s, people: upsertById(s.people ?? [], p) }, syncPerson(s.subscriptions, p)),
      () => api<{ person: Person; subscriptions: Subscription[] }>(`/api/people/${p.id}`, { method: 'PUT', body: JSON.stringify(p) }),
      (s, r) => withSubs({ ...s, people: upsertById(s.people ?? [], r.person) }, r.subscriptions),
    );
    return r.person;
  }

  /** 删除一个人：只能删没有被任何合租、代付引用的（服务端会再检查一次） */
  function deletePerson(id: string) {
    return write(
      (s) => ({ ...s, people: (s.people ?? []).filter((x) => x.id !== id) }),
      () => api(`/api/people/${id}`, { method: 'DELETE' }),
    );
  }

  /** 把 from 合并到 into：引用全部改指向 into，from 从名册里去掉 */
  async function mergePerson(from: string, into: string) {
    await write(
      (s) => {
        const m = mergePeople(s.people ?? [], s.subscriptions, from, into);
        return withSubs({ ...s, people: m.people }, m.subs);
      },
      () => api<{ people: Person[]; subscriptions: Subscription[] }>(`/api/people/${from}/merge`, { method: 'POST', body: JSON.stringify({ into }) }),
      (s, r) => withSubs({ ...s, people: r.people }, r.subscriptions),
    );
  }

  function saveSettings(patch: Partial<Settings>) {
    return write(
      (s) => ({ ...s, settings: { ...s.settings, ...patch } }),
      // 清空的字段（undefined）以 null 传给服务端，否则 JSON 会丢掉这个键，旧值留在库里
      () =>
        api<Settings>('/api/settings', {
          method: 'PUT',
          body: JSON.stringify(Object.fromEntries(Object.entries({ ...getState().settings, ...patch }).map(([k, v]) => [k, v === undefined ? null : v]))),
        }),
      (s, settings) => ({ ...s, settings }),
    );
  }

  /**
   * 保存分类表（顺序即显示顺序）。renames 是旧名 → 新名：改名、删除分类时把订阅移过去，服务端一次改写所有相关订阅。
   * 返回改动了几个订阅。
   */
  async function saveCategories(categories: Category[], renames: Record<string, string> = {}) {
    const r = await write(
      (s) => withSubs({ ...s, settings: { ...s.settings, categories } }, renameInSubs(s.subscriptions, renames)),
      () => api<{ settings: Settings; subscriptions: Subscription[] }>('/api/categories', { method: 'PUT', body: JSON.stringify({ categories, renames }) }),
      (s, r) => withSubs({ ...s, settings: r.settings }, r.subscriptions),
    );
    // 订阅页存的分类筛选跟着改名走，不因改名退回「全部」
    const saved = getState().prefs?.['list-cat'];
    if (saved && Object.hasOwn(renames, saved) && renames[saved] !== saved) writePref('list-cat', renames[saved]);
    return r.subscriptions.length;
  }

  async function rotateIcs() {
    const settings = await api<Settings>('/api/ics/rotate', { method: 'POST' });
    patchState((s) => ({ ...s, settings }));
  }

  async function importData(body: { subscriptions: Subscription[]; methods: PaymentMethod[]; mode: 'merge' | 'replace' }) {
    const state = await api<unknown>('/api/import', { method: 'POST', body: JSON.stringify(body) });
    if (!isLedger(state)) throw new Error(t('ui.error.requestFailed', { status: 200 }));
    replaceSyncedState(state);
  }

  async function refreshFx() {
    const fx = await api<AppState['fx']>('/api/fx/refresh', { method: 'POST' });
    patchState((s) => ({ ...s, fx }));
  }

  return {
    saveSub,
    deleteSub,
    reorderMethods,
    saveMethod,
    deleteMethod,
    savePerson,
    deletePerson,
    mergePerson,
    saveSettings,
    saveCategories,
    rotateIcs,
    importData,
    refreshFx,
  };
}

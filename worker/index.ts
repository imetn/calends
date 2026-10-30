import { prepareSubWrite, validSub } from '../shared/sub-write.ts';
import { validateAvatar, validatePeopleAvatars } from '../shared/avatar.ts';
import { normalizeBasePath, stripBase, siteUrl, withBase } from '../shared/base.ts';
import { addDays, todayIn } from '../shared/billing.ts';
import {
  DEFAULT_SETTINGS,
  type AppState,
  type Channel,
  type FxTable,
  type PaymentMethod,
  type Person,
  type Settings,
  type Subscription,
} from '../shared/types.ts';
import { mergePeople, personColor, refsFor, syncPerson } from '../shared/people.ts';
import { checkSettings, deleteMethodData, deleteSubscriptionSettings, methodReferences, pruneSettingsRefs, validateMethod } from '../shared/ledger-edit.ts';
import {
  DEFAULT_MAX_SESSIONS,
  authStatus,
  changePassword,
  constantEqual,
  deletePasskey,
  isAuthed,
  listPasskeys,
  listSessions,
  login,
  logout,
  logoutOthers,
  passkeyLoginOptions,
  passkeyLoginVerify,
  passkeyRegisterOptions,
  passkeyRegisterVerify,
  pruneSessions,
  randomToken,
  revokeSession,
  sameOrigin,
  setup,
} from './auth.ts';
import { maskForPublic } from '../shared/mask.ts';
import type { Env } from './env.ts';
import { backfill, fxStatus, refreshFx } from './fx.ts';
import { buildIcs } from './ics.ts';
import { buildDaily, buildMonthly, runScheduled, sendDigest, type Digest } from './notify.ts';
import { renderEmail } from './email.ts';
import {
  getFx,
  getKv,
  getPeople,
  getRev,
  getSettings,
  loadState,
  loadMethods,
  loadSubs,
  putKv,
  replaceAll,
  saveLedgerEdit,
  saveSettingsWithSubs,
  upsert,
  writePeople,
} from './store.ts';
import type { Revision } from './store.ts';
import { mergePrefs, type Prefs } from '../shared/prefs.ts';
import { cleanCategories, renameInSubs } from '../shared/categories.ts';
import { createToken, listTokens, mcp, revokeToken } from './ai/mcp.ts';
import { searchLogos } from './ai/logo-search.ts';
import { fetchPublic } from './url-guard.ts';
import { TOOLS, toolTitle } from './ai/mcp-tools.ts';
import { appStorePlans, searchAppStore } from './appstore.ts';
import { exportAll, parseBackup, restoreAll } from './backup.ts';
import { apply, chat, clearChats, listChats, saveChat, saveConfig, testConfig, viewConfig } from './ai/assistant.ts';
import { requestLocale, settingsLocale, applyLocale, withLocaleScope } from './i18n.ts';
import { t } from '../shared/i18n.ts';
import { ensureMigrated } from './migrate.ts';
import { HttpError, readJson } from './http.ts';

const json = (data: unknown, status = 200, rev?: number | Revision) =>
  Response.json(data, {
    status,
    headers: {
      'cache-control': 'no-store',
      ...(rev === undefined ? {} : { 'x-calends-rev': String(typeof rev === 'number' ? rev : rev.rev) }),
      ...(typeof rev === 'object' ? { 'x-calends-rev-from': String(rev.from) } : {}),
    },
  });
const bad = (msg: string, status = 400) => json({ error: msg }, status);

/** 批量导入时第一条不合格的订阅 */
function invalidIn(subs: Subscription[]): string | undefined {
  for (const s of subs) {
    const err = validSub(s);
    if (err) return t('server.invalidItem', { name: s?.name ?? '?', error: err });
  }
  return undefined;
}

/** 名册里的一个人：只收认识的字段，去掉多余空白 */
function cleanPerson(raw: Partial<Person>, id: string): Person | undefined {
  const name = typeof raw?.name === 'string' ? raw.name.trim() : '';
  if (!name) return undefined;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const contact = s(raw.contact);
  return {
    id,
    name,
    contactVia: contact ? s(raw.contactVia) : undefined,
    contact,
    note: s(raw.note),
    avatar: validateAvatar(raw.avatar),
    color: personColor(raw.color),
    createdAt: s(raw.createdAt) ?? new Date().toISOString(),
  };
}

/**
 * 写入一张支付方式前的校验：与 MCP update_payment_method 同一个 validateMethod（名称、币种要有汇率）。
 * 只拦本次新引入的币种：已存记录的原币种即使汇率表里没有了也放行，免得旧卡改个备注都存不了。
 */
function methodError(fx: FxTable, previous: PaymentMethod | undefined, pm: PaymentMethod): string | undefined {
  if (!pm || typeof pm !== 'object' || typeof pm.id !== 'string' || !pm.id) return t('server.invalidMethod');
  try {
    validateMethod({ fx: previous && previous.currency === pm.currency ? { ...fx, rates: { ...fx.rates, [pm.currency]: 1 } } : fx }, pm);
  } catch (e) {
    return e instanceof Error ? e.message : t('server.invalidMethod');
  }
  return undefined;
}

async function api(req: Request, env: Env, path: string): Promise<Response> {
  const method = req.method;
  if (path === '/api/login' && method === 'POST') return login(req, env);
  if (path === '/api/logout' && method === 'POST') return logout(req, env);
  // 登录前可用：状态、首次设置、Passkey 登录
  if (path === '/api/auth/status' && method === 'GET') return authStatus(env);
  // 本地开发免登录：DEV_BYPASS_AUTH 只写在 .dev.vars（不随部署上传）。
  // wrangler dev 会把请求 URL 改写成线上路由域名，所以这里无法按 localhost 判断。
  const dev = env.DEV_BYPASS_AUTH === '1';
  if (method === 'POST' && path.startsWith('/api/auth/') && !dev && !sameOrigin(req)) return bad('forbidden', 403);
  if (path === '/api/auth/setup' && method === 'POST') return setup(req, env);
  if (path === '/api/auth/passkey/login/options' && method === 'POST') return passkeyLoginOptions(req, env);
  if (path === '/api/auth/passkey/login' && method === 'POST') return passkeyLoginVerify(req, env);

  const authed = dev || (await isAuthed(req, env));
  if (path === '/api/public' && method === 'GET') {
    // 先看是否公开；公开时也只读加载（旧数据的转换只在内存里做），未登录访客的请求从不写库
    if (!(await getSettings(env)).publicView && !dev) return bad(t('server.notPublic'), 404);
    return json(maskForPublic(await loadState(env, false)));
  }
  if (!authed) return bad('unauthorized', 401);
  if (path === '/api/rev' && method === 'GET') return json({ rev: await getRev(env) });
  if (path === '/api/state' && method === 'GET') return json(await loadState(env));
  if (method !== 'GET' && !dev && !sameOrigin(req)) return bad('forbidden', 403);

  // 图片中转：分享图要把订阅图标画进 canvas，跨域图片会污染画布，所以经同源转一道。只转 https 的图片，限 1MB。
  // 「网上搜 Logo」会把这个接口当图床用（选中后把外链图转存本地），所以必须先挡住内网地址，否则能被用来探测内网。
  if (path === '/api/img' && method === 'GET') {
    // 只转公网地址，跳转的每一跳也检查：不能被拿来探测服务器所在的内网
    const res = await fetchPublic(new URL(req.url).searchParams.get('u') ?? '', { cf: { cacheTtl: 86400, cacheEverything: true } });
    if (!res) return bad('bad url', 400);
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.startsWith('image/')) return bad('not an image', 502);
    const body = await res.arrayBuffer();
    if (body.byteLength > 1_000_000) return bad('too large', 413);
    return new Response(body, { headers: { 'content-type': type, 'cache-control': 'private, max-age=86400' } });
  }
  // 网上搜 Logo：四路来源（官网 / selfh.st / Dashboard Icons / 图片搜索），只返回候选，不改任何数据
  if (path === '/api/logos/search' && method === 'GET') {
    const q = new URL(req.url).searchParams.get('q') ?? '';
    return json({ results: await searchLogos(env, q) });
  }
  // 已登录：账号安全
  if (path === '/api/auth/security' && method === 'GET') return json({ passkeys: await listPasskeys(env), sessions: await listSessions(req, env) });
  const sess = path.match(/^\/api\/auth\/sessions\/(\w+)$/);
  if (sess && method === 'DELETE') return revokeSession(req, env, sess[1]);
  if (path === '/api/auth/password' && method === 'POST') return changePassword(req, env);
  if (path === '/api/auth/logout-others' && method === 'POST') return logoutOthers(req, env);
  if (path === '/api/auth/passkey/register/options' && method === 'POST') return passkeyRegisterOptions(req, env);
  if (path === '/api/auth/passkey/register' && method === 'POST') return passkeyRegisterVerify(req, env);
  const pk = path.match(/^\/api\/auth\/passkey\/([\w-]+)$/);
  if (pk && method === 'DELETE') {
    await deletePasskey(env, pk[1]);
    return json({ ok: true });
  }
  // MCP 令牌管理（后台「AI」页）：明文只在新建时返回一次
  if (path === '/api/mcp/tools' && method === 'GET')
    return json(TOOLS.map((x) => ({ name: x.name, title: toolTitle(x.name), description: x.description, write: !!x.write })));
  if (path === '/api/mcp/tokens' && method === 'GET') return json((await listTokens(env)).map(({ hash: _h, ...rest }) => rest));
  if (path === '/api/mcp/tokens' && method === 'POST') {
    const b = (await readJson(req)) as { name?: string; scope?: string };
    const { token, item } = await createToken(env, b.name ?? '', b.scope === 'read' ? 'read' : 'write');
    const { hash: _h, ...rest } = item;
    return json({ token, item: rest });
  }
  const tm = path.match(/^\/api\/mcp\/tokens\/([\w-]+)$/);
  if (tm && method === 'DELETE') {
    await revokeToken(env, tm[1]);
    return json({ ok: true });
  }
  let m = path.match(/^\/api\/subscriptions\/([\w-]+)$/);
  if (m) {
    if (method === 'PUT') {
      let sub = (await readJson(req)) as Subscription;
      if (sub.id !== m[1]) return bad(t('server.idMismatch'));
      const previous = (await loadSubs(env)).find((x) => x.id === sub.id);
      const today = todayIn((await getSettings(env)).timezone);
      const prepared = prepareSubWrite(previous, sub, today, { methods: await loadMethods(env), fx: await getFx(env) });
      if (prepared.error !== undefined) return bad(prepared.error);
      sub = prepared.sub;
      const rev = await upsert(env, 'subscriptions', sub.id, sub);
      return json(sub, 200, rev);
    }
    if (method === 'DELETE') {
      // 与 MCP delete_subscription 相同：同一事务里把它从公开页隐藏列表去掉，不留悬空 id
      const settings = deleteSubscriptionSettings(await getSettings(env), m[1]);
      const rev = await saveLedgerEdit(env, { settings }, [], [m[1]]);
      return json({ ok: true, settings }, 200, rev);
    }
  }
  // 人：保存时把称呼、联系方式同步到所有引用他的成员、代付上，返回改动过的订阅
  m = path.match(/^\/api\/people\/([\w-]+)(\/merge)?$/);
  if (m) {
    const people = await getPeople(env);
    const id = m[1];
    if (m[2] && method === 'POST') {
      const into = String(((await readJson(req)) as { into?: string }).into ?? '');
      if (!people.some((p) => p.id === id) || !people.some((p) => p.id === into) || into === id) return bad(t('server.personNotFound'), 404);
      const r = mergePeople(people, await loadSubs(env), id, into);
      const subscriptions = r.subs;
      const rev = await writePeople(env, r.people, subscriptions);
      return json({ people: r.people, subscriptions }, 200, rev);
    }
    if (!m[2] && method === 'PUT') {
      let p: Person | undefined;
      try {
        p = cleanPerson((await readJson(req)) as Partial<Person>, id);
      } catch (e) {
        return bad(e instanceof Error ? e.message : t('server.invalidPerson'));
      }
      if (!p) return bad(t('server.invalidPerson'));
      const old = people.find((x) => x.id === id);
      if (old?.createdAt) p.createdAt = old.createdAt;
      const next = old ? people.map((x) => (x.id === id ? p : x)) : [...people, p];
      try {
        validatePeopleAvatars(next);
      } catch (e) {
        return bad(e instanceof Error ? e.message : t('server.invalidPerson'));
      }
      const subscriptions = syncPerson(await loadSubs(env), p);
      const rev = await writePeople(env, next, subscriptions);
      return json({ person: p, subscriptions }, 200, rev);
    }
    if (!m[2] && method === 'DELETE') {
      // 还有合租、代付指向他时不删：先合并到别人名下或从那些订阅里移除，账不会悬空
      const n = refsFor(await loadSubs(env), id).length;
      if (n) return bad(t('server.personInUse', { count: n }), 409);
      const rev = await putKv(
        env,
        'people',
        people.filter((x) => x.id !== id),
      );
      return json({ ok: true }, 200, rev);
    }
  }
  m = path.match(/^\/api\/methods\/([\w-]+)$/);
  if (m) {
    if (method === 'PUT') {
      const pm = (await readJson(req)) as PaymentMethod;
      if (pm?.id !== m[1] || !pm.name?.trim()) return bad(t('server.invalidMethod'));
      const error = methodError(
        await getFx(env),
        (await loadMethods(env)).find((x) => x.id === pm.id),
        pm,
      );
      if (error) return bad(error);
      const rev = await upsert(env, 'methods', pm.id, pm);
      return json(pm, 200, rev);
    }
    // 删卡：与 MCP update_payment_method action=delete 同一套引用处理（订阅、阶段、单笔、拆分来源、默认支付方式）。
    // ?into=<id> 迁到另一张卡，?clear=1 清空引用；有引用又没选时 409，返回引用数。
    if (method === 'DELETE') {
      const q = new URL(req.url).searchParams;
      const into = q.get('into') || (q.get('clear') === '1' ? null : undefined);
      const st = { subscriptions: await loadSubs(env), methods: await loadMethods(env), settings: await getSettings(env) } as AppState;
      if (into === undefined && methodReferences(st, m[1]).length) return json({ error: t('server.methodInUse'), code: 'in_use' }, 409);
      let r: ReturnType<typeof deleteMethodData>;
      try {
        r = deleteMethodData(st, m[1], into);
      } catch {
        return bad(t('server.invalidMethod'));
      }
      const subscriptions = r.subscriptions;
      const rev = await saveLedgerEdit(env, { settings: r.settings, subscriptions }, [m[1]]);
      return json({ ok: true, settings: r.settings, subscriptions }, 200, rev);
    }
  }
  // 界面配置：按项合并，两台设备改不同的项互不覆盖
  if (path === '/api/prefs' && method === 'PATCH') {
    const next = mergePrefs((await getKv<Prefs>(env, 'prefs')) ?? {}, await req.json().catch(() => null));
    const rev = await putKv(env, 'prefs', next);
    return json(next, 200, rev);
  }
  if (path === '/api/settings' && method === 'PUT') {
    const cur = await getSettings(env);
    const patch = (await readJson(req)) as Partial<Settings>;
    const next = { ...DEFAULT_SETTINGS, ...cur, ...patch, icsToken: cur.icsToken };
    // null 表示清空这个设置
    for (const k of Object.keys(next) as Array<keyof Settings>) if (next[k] === null) delete next[k];
    next.notifyHour = Math.min(23, Math.max(0, Math.round(next.notifyHour)));
    if (next.maxSessions !== undefined) next.maxSessions = Math.min(50, Math.max(1, Math.round(next.maxSessions)));
    // 与 MCP update_settings 同一套校验：只校验改动过的字段，再剔除早已失效的引用
    const refs = { subscriptions: await loadSubs(env), methods: await loadMethods(env), fx: await getFx(env) };
    try {
      checkSettings(refs, { ...DEFAULT_SETTINGS, ...cur }, next);
    } catch (e) {
      return bad(e instanceof Error ? e.message : t('server.invalidAvatar'));
    }
    const pruned = pruneSettingsRefs(next, refs.subscriptions, refs.methods);
    const rev = await putKv(env, 'settings', pruned);
    if (next.maxSessions !== cur.maxSessions) await pruneSessions(req, env, next.maxSessions ?? DEFAULT_MAX_SESSIONS);
    return json(pruned, 200, rev);
  }
  // 分类表：整表保存；renames（旧名 → 新名）把相关订阅一起改掉，改名、删除时移走订阅都靠它
  if (path === '/api/categories' && method === 'PUT') {
    const b = (await readJson(req)) as { categories?: unknown; renames?: Record<string, unknown> };
    const r = cleanCategories(b.categories);
    if ('error' in r) return bad(r.error);
    const renames: Record<string, string> = {};
    for (const [from, to] of Object.entries(b.renames ?? {})) if (typeof to === 'string' && to.trim()) renames[from] = to.trim();
    const changed = renameInSubs(await loadSubs(env), renames);
    const settings = { ...(await getSettings(env)), categories: r.list };
    const rev = await saveSettingsWithSubs(env, settings, changed);
    return json({ settings, subscriptions: changed }, 200, rev);
  }
  if (path === '/api/ics/rotate' && method === 'POST') {
    const cur = await getSettings(env);
    const next = { ...cur, icsToken: randomToken(16) };
    const rev = await putKv(env, 'settings', next);
    return json(next, 200, rev);
  }
  // 完整备份：导出文件可在全新部署上原样恢复
  if (path === '/api/backup' && method === 'GET') {
    const b = await exportAll(env);
    return new Response(JSON.stringify(b, null, 1), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="calends-backup-${b.exportedAt.slice(0, 10)}.json"`,
        'cache-control': 'no-store',
      },
    });
  }
  if (path === '/api/backup' && method === 'POST') {
    let b;
    try {
      b = parseBackup(await readJson(req));
    } catch (e) {
      return bad(e instanceof Error ? e.message : t('server.invalidBackup'));
    }
    const err = invalidIn(b.subscriptions);
    if (err) return bad(err);
    const restored = await restoreAll(env, b);
    const state = await loadState(env);
    return json({ restored, state }, 200, state.rev);
  }
  if (path === '/api/import' && method === 'POST') {
    // 只导入订阅与支付方式；设置走 PUT /api/settings 的校验，这里不再接受
    const body = (await readJson(req)) as { subscriptions?: Subscription[]; methods?: PaymentMethod[]; mode?: 'merge' | 'replace' };
    const subs = body.subscriptions ?? [];
    const err = invalidIn(subs);
    if (err) return bad(err);
    const methods = body.methods ?? [];
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    // 与网页钱包、MCP 同一套支付方式校验；合并导入时已存的同 id 记录原币种放行
    const existing = mode === 'merge' ? await loadMethods(env) : [];
    const fx = await getFx(env);
    for (const pm of methods) {
      const error = methodError(
        fx,
        existing.find((x) => x.id === pm?.id),
        pm,
      );
      if (error) return bad(t('server.invalidItem', { name: pm?.name ?? '?', error }));
    }
    await replaceAll(env, subs, methods, mode);
    const state = await loadState(env);
    return json(state, 200, state.rev);
  }
  if (path === '/api/fx/status' && method === 'GET') {
    const st = await fxStatus(env, await loadState(env));
    return json({ ...st, missing: st.missing.slice(0, 50) });
  }
  if (path === '/api/fx/backfill' && method === 'POST') {
    const result = await backfill(env, await loadState(env));
    return json(result, 200, await getRev(env));
  }
  if (path === '/api/fx/refresh' && method === 'POST') {
    try {
      const fx = await refreshFx(env);
      return json(fx, 200, await getRev(env));
    } catch (e) {
      return bad(e instanceof Error ? e.message : t('server.refreshFailed'), 502);
    }
  }
  // AI 助手（DeepSeek）
  if (path === '/api/assistant/config' && method === 'GET') return json(await viewConfig(env));
  if (path === '/api/assistant/config' && method === 'PUT') return json(await saveConfig(env, (await readJson(req)) as Parameters<typeof saveConfig>[1]));
  if (path === '/api/assistant/test' && method === 'POST')
    return json(await testConfig(env, (await req.json().catch(() => ({}))) as { apiKey?: string; baseUrl?: string }));
  // 聊天记录
  if (path === '/api/assistant/chats' && method === 'GET') return json(await listChats(env));
  if (path === '/api/assistant/chats' && method === 'DELETE') return (await clearChats(env), json({ ok: true }));
  {
    const cm = path.match(/^\/api\/assistant\/chats\/([\w-]{1,40})$/);
    if (cm && method === 'PUT') {
      try {
        await saveChat(env, cm[1], await readJson(req));
        return json({ ok: true });
      } catch (e) {
        return bad(e instanceof Error ? e.message : String(e));
      }
    }
  }
  if (path === '/api/assistant/chat' && method === 'POST') return chat(env, (await readJson(req)) as Parameters<typeof chat>[1], req.signal);
  if (path === '/api/assistant/apply' && method === 'POST') {
    try {
      const result = await apply(env, (await readJson(req)) as Parameters<typeof apply>[1]);
      // A missing revision after commit must not turn a saved change into a retryable error.
      return json(result, 200, await getRev(env).catch(() => undefined));
    } catch (e) {
      return bad(e instanceof Error ? e.message : String(e));
    }
  }
  if (path === '/api/appstore/search' && method === 'GET') {
    const url = new URL(req.url);
    return json({ results: await searchAppStore(url.searchParams.get('q') ?? '', url.searchParams.get('country') ?? 'us') });
  }
  if (path === '/api/appstore/plans' && method === 'GET') {
    const url = new URL(req.url);
    return json(await appStorePlans(url.searchParams.get('id') ?? '', url.searchParams.get('country') ?? 'us'));
  }
  if (path === '/api/notify/preview' && method === 'GET') {
    const state = await loadState(env);
    const url = new URL(req.url);
    const day = url.searchParams.get('day') ?? todayIn(state.settings.timezone);
    const digests = [buildMonthly(state, day), buildDaily(state, day)].filter(Boolean) as Digest[];
    const log = await env.DB.prepare('SELECT dedupe_key, kind, subject, status, sent_at FROM notify_log ORDER BY sent_at DESC LIMIT 20').all();
    if (url.searchParams.get('html') === '1') {
      // 没有要发的提醒时也给一页可读的说明，不回落成原始 JSON
      const html = digests[0]
        ? renderEmail(digests[0], env.SITE_URL ?? '').html
        : `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${t('notify.previewEmpty')}</title><p style="font:15px/1.6 system-ui,sans-serif;color:#555;text-align:center;margin-top:20vh">${t('notify.previewEmpty')}</p>`;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
    return json({ day, digests, log: log.results });
  }
  if (path === '/api/notify/test' && method === 'POST') {
    const state = await loadState(env);
    const today = todayIn(state.settings.timezone);
    // 测试信：取未来 30 天内第一个会触发的日报；都没有就发一封样例
    let d: Digest | undefined;
    for (let i = 0; i < 30 && !d; i++) {
      d = buildDaily(state, addDays(today, i));
    }
    const digest: Digest = d
      ? { ...d, key: `test:${today}`, kind: 'test', subject: t('notify.test.subject', { subject: d.subject }) }
      : { key: `test:${today}`, kind: 'test', subject: t('notify.test.sampleSubject'), intro: t('notify.test.sampleIntro'), sections: [], date: today };
    // 可以只测某一个渠道；传入 channel 对象时测试还没保存的配置
    const body = (await req.json().catch(() => ({}))) as { channel?: Channel | string };
    if (body.channel && typeof body.channel === 'object') {
      const c = body.channel;
      return json(await sendDigest(env, { ...state, settings: { ...state.settings, channels: [c] } }, digest, { force: true, only: c.id }));
    }
    return json(await sendDigest(env, state, digest, { force: true, only: typeof body.channel === 'string' ? body.channel : undefined }));
  }
  return bad('not found', 404);
}

async function scheduledNotifications(env: Env, now: number): Promise<void> {
  const state = await loadState(env);
  applyLocale(settingsLocale(state.settings));
  // 定时任务没有请求地址：用后台最近一次访问时记下的地址
  env = { ...env, SITE_URL: siteUrl(env.SITE_URL || state.settings.siteUrl || '', env.BASE_PATH) };
  const log = await runScheduled(env, state, now);
  if (log.length) console.log('[notify]', log.join('; '));
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return withLocaleScope(() => handleFetch(req, env));
  },

  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    return withLocaleScope(() => handleScheduled(controller, env, ctx));
  },
} satisfies ExportedHandler<Env>;

async function handleFetch(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const prefix = normalizeBasePath(env.BASE_PATH);
  url.pathname = stripBase(url.pathname, prefix);
  // 旧域名：页面跳到新域名，接口、MCP、日历订阅继续在旧域名上可用
  if (env.OLD_HOSTS && env.SITE_URL && env.OLD_HOSTS.split(',').some((h) => h.trim() === url.hostname)) {
    const keep = url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/cal/');
    if (!keep) return Response.redirect(`${siteUrl(env.SITE_URL, prefix)}${url.pathname}${url.search}`, 301);
  }
  // 没配置 SITE_URL 时，以当前访问的地址作为站点地址（提醒、日历里的链接）
  env = { ...env, SITE_URL: siteUrl(env.SITE_URL || url.origin, prefix) };
  try {
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/cal/')) await ensureMigrated(env);
    // 公开页、静态资源不需要文案；接口、MCP、日历订阅按请求或设置切换语言
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/cal/')) {
      if (url.pathname !== '/api/rev') {
        const s = await getSettings(env);
        applyLocale(url.pathname === '/mcp' ? settingsLocale(s) : requestLocale(req, s));
      }
    }
    if (url.pathname.startsWith('/api/')) return await api(req, env, url.pathname);
    if (url.pathname === '/mcp') {
      // 在浏览器里打开 MCP 地址时，带去连接页查看令牌和配置
      if (req.method === 'GET' && req.headers.get('accept')?.includes('text/html')) return Response.redirect(`${env.SITE_URL}/connect`, 302);
      return await mcp(req, env);
    }
    const cal = url.pathname.match(/^\/cal\/([a-f0-9]{32})\.ics$/);
    if (cal) {
      // 先定长比对令牌，对上了才只读加载账本：猜令牌的请求既得不到计时线索，也不会触发写库
      const token = (await getSettings(env)).icsToken;
      if (!token || !constantEqual(token, cal[1])) return new Response('not found', { status: 404 });
      return new Response(buildIcs(await loadState(env, false), env.SITE_URL ?? ''), {
        headers: { 'content-type': 'text/calendar; charset=utf-8', 'cache-control': 'private, max-age=1800' },
      });
    }
    const asset = await env.ASSETS.fetch(new Request(url, req));
    // Assets 对 index.html 等的规范化重定向也必须留在当前安装前缀下。
    const location = asset.headers.get('location');
    if (prefix && asset.status >= 300 && asset.status < 400 && location) {
      const target = new URL(location, url);
      if (target.origin === url.origin) {
        target.pathname = withBase(target.pathname, prefix);
        const headers = new Headers(asset.headers);
        headers.set('location', target.href);
        return new Response(asset.body, { status: asset.status, headers });
      }
    }
    return asset;
  } catch (e) {
    if (e instanceof HttpError) return bad(e.message, e.status);
    console.error(e);
    return bad('server error', 500);
  }
}

async function handleScheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  await ensureMigrated(env);
  // 通知每刻钟检查；原有的每日维护仍只在 UTC 整点执行。
  if (new Date(controller.scheduledTime).getUTCMinutes() >= 15) {
    await scheduledNotifications(env, controller.scheduledTime);
    return;
  }
  const fx = await getFx(env);
  if (Date.now() - Date.parse(fx.fetchedAt) > 20 * 3_600_000) {
    ctx.waitUntil(refreshFx(env).catch((e) => console.error('[fx]', e)));
  }
  await scheduledNotifications(env, controller.scheduledTime);
}

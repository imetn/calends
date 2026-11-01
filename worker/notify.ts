import { isDataIcon } from '../shared/icon.ts';
import {
  addDays,
  addMonths,
  chargesBetween,
  convert,
  currentPhase,
  diffDays,
  effectiveStatus,
  isPostpaid,
  nextCharge,
  renewalDates,
  memberAboard,
  memberUnpaidFrom,
  memberCollection,
  memberBillMonths,
  priceAt,
  runwayFor,
  todayIn,
  totals,
  chargeMethodId,
} from '../shared/billing.ts';
import { toBaseOrNaN } from '../shared/fx.ts';
import { billLabel, cnDate, money, monthLabel, relDays } from '../shared/format.ts';
import { t } from '../shared/i18n.ts';
import { channelsOf, type AppState, type Subscription } from '../shared/types.ts';
import type { Env } from './env.ts';
import { proxyLedger } from '../shared/proxy.ts';
import { sendTo } from './channels.ts';

export interface Row {
  title: string;
  /** 一行说明：纯文本、Markdown 渠道用；邮件优先用 detail */
  sub?: string;
  amount?: string;
  amountSub?: string;
  tone?: 'warn' | 'ok' | 'muted';
  /** 订阅图标：emoji、图片地址或站内路径 */
  icon?: string;
  /** 距今天数：邮件里显示成「明天」「3 天后」的标签 */
  days?: number;
  /** 邮件里标题下的那行：日期 · 支付方式；不填时用 sub */
  detail?: string;
  /** 额外提示，如「优惠结束，恢复原价」 */
  note?: string;
}

export interface Section {
  heading: string;
  rows: Row[];
  /** 合计行：月度账单的本月合计 */
  total?: { label: string; amount: string };
}

export interface Digest {
  key: string;
  kind: 'daily' | 'monthly' | 'test';
  subject: string;
  /** 邮件大标题；不填时用 subject */
  title?: string;
  intro: string;
  sections: Section[];
  /** 生成这份提醒的日期（YYYY-MM-DD），邮件页眉显示 */
  date?: string;
  /** 收件箱列表里标题后那行预览；不填时用 intro */
  preheader?: string;
  /** 概览数字：月度账单的本月预计、笔数、月均支出 */
  stats?: Array<{ label: string; value: string }>;
}

/** 订阅图标：自己填的 emoji / 图片，没有就用官网的站点图标 */
function iconOf(s: Pick<Subscription, 'icon' | 'url'>): string | undefined {
  const icon = s.icon?.trim();
  // 内嵌图片不交给通知渠道（它们只认网址或 emoji），退回官网图标
  if (icon && !isDataIcon(icon)) return icon;
  try {
    return s.url ? `https://www.google.com/s2/favicons?domain=${new URL(s.url).hostname}&sz=128` : undefined;
  } catch {
    return undefined;
  }
}

/** 计算 today 应发出的提醒；不产生副作用，供 cron、预览与测试共用 */
export function buildDaily(state: AppState, today: string): Digest | undefined {
  const { settings, fx } = state;
  const base = settings.baseCurrency;
  const renew: Row[] = [];
  const trials: Row[] = [];
  const cancellation: Row[] = [];
  const ending: Row[] = [];
  const carpool: Row[] = [];
  const proxy: Row[] = [];
  const balance: Row[] = [];
  const headline: string[] = [];

  for (const s of state.subscriptions) {
    const st = effectiveStatus(s, today);
    const remind = s.remindDays ?? settings.remindDays;
    if (remind < 0) continue;
    if (st === 'trial' && s.trialEnd) {
      const d = diffDays(today, s.trialEnd);
      if (d === remind || d === 1 || d === 0) {
        trials.push({
          title: s.name,
          sub: t('notify.trial.sub', { when: relDays(d), date: cnDate(s.trialEnd), price: money(s.price, s.currency) }),
          amount: money(s.price, s.currency),
          tone: 'warn',
          icon: iconOf(s),
          days: d,
        });
        headline.push(t('notify.trial.headline', { name: s.name, when: relDays(d) }));
      }
    }
    // 后付费停止、暂停后还有最后一张账单，同样提醒
    const postpaid = isPostpaid(currentPhase(s, today));
    if (st === 'active' || st === 'ending' || (postpaid && ['ended', 'terminated', 'paused'].includes(st))) {
      const n = nextCharge(s, today);
      if (n) {
        const d = diffDays(today, n);
        if (d === remind || (remind > 1 && d === 1)) {
          const method = state.methods.find((m) => m.id === s.methodId);
          // 后付费账单按所用那一期计价
          const price = postpaid ? (chargesBetween(s, n, n, today).find((c) => !c.kind)?.amount ?? priceAt(s, n)) : priceAt(s, n);
          const conv = s.currency !== base ? `≈ ${money(convert(price, s.currency, base, fx), base)}` : undefined;
          const introEnds = !(s.intro && s.intro.until > n) && !!s.intro && diffDays(s.intro.until, n) < 40;
          renew.push({
            title: s.name,
            sub: [relDays(d), cnDate(n, true), method?.name, introEnds ? t('notify.renew.introEnds') : ''].filter(Boolean).join(' · '),
            amount: money(price, s.currency),
            amountSub: conv,
            icon: iconOf(s),
            days: d,
            detail: [cnDate(n, true), method?.name].filter(Boolean).join(' · '),
            note: introEnds ? t('notify.renew.introEnds') : undefined,
          });
          headline.push(
            t(postpaid ? 'notify.renew.billHeadline' : 'notify.renew.headline', { name: s.name, when: relDays(d), price: money(price, s.currency) }),
          );
        }
      }
    }
    if (['active', 'trial'].includes(st) && !s.end) {
      const deadline = renewalDates(s, today).cancelBy;
      if (deadline) {
        const d = diffDays(today, deadline);
        if (d === remind || (remind > 1 && d === 1) || d === 0) {
          cancellation.push({
            title: s.name,
            sub: t('core.renewal.cancelReminder', { date: cnDate(deadline, true) }),
            amount: cnDate(deadline),
            days: d,
            tone: 'warn',
            icon: iconOf(s),
          });
          headline.push(t('core.renewal.cancelReminder', { date: cnDate(deadline, true) }));
        }
      }
    }
    if (s.end && st === 'ending') {
      const d = diffDays(today, s.end);
      if (d === 7 || d === 1) {
        ending.push({ title: s.name, sub: t('notify.ending.sub', { when: relDays(d) }), amount: cnDate(s.end), tone: 'muted', icon: iconOf(s), days: d });
        headline.push(t('notify.ending.headline', { name: s.name, when: relDays(d) }));
      }
    }
  }

  // 合租：成员的「已付至」快到或已过，提醒去收下一期；到期前 7 天、3 天、当天，逾期后再提醒几次
  const collect = settings.collectCurrency ?? base;
  for (const s of state.subscriptions) {
    if (s.share?.role !== 'owner' || !['active', 'ending'].includes(effectiveStatus(s, today))) continue;
    for (const m of s.share.members) {
      if (m.exempt || !memberAboard(m, today)) continue;
      const due = memberUnpaidFrom(s, m);
      // 订阅到期不续（或已经结束）时，结束日之后的下一期不存在了，不用再催收
      if ((s.end && due > s.end) || (m.left && due >= m.left)) continue;
      const d = diffDays(today, due);
      // 逾期后第 7、14 天提醒，之后每 30 天提醒一次，避免天天打扰
      if (!(d === 7 || d === 3 || d === 0 || d === -7 || d === -14 || (d < 0 && -d % 30 === 0))) continue;
      const every = memberBillMonths(s, m, due);
      const period = memberCollection(s, m, due, collect);
      // 缺汇率时显示「—」，不显示成 0
      const fee = money(toBaseOrNaN(state, period.amount, period.currency, undefined, collect), collect);
      const who = (m.contactVia && m.contact ? `${m.contactVia} ${m.contact}` : (m.contact ?? m.tg)) ?? '';
      carpool.push({
        title: `${m.name} · ${s.name}`,
        sub: `${t('notify.carpool.sub', { status: d > 0 ? t('notify.carpool.dueIn', { when: relDays(d), date: cnDate(due) }) : d === 0 ? t('notify.carpool.dueToday') : t('notify.carpool.overdue', { count: -d }), bill: billLabel(every) })}${who ? ` · ${who}` : ''}`,
        amount: fee,
        tone: d < 0 ? 'warn' : undefined,
        icon: iconOf(s),
      });
      if (d <= 0) headline.push(t('notify.carpool.headline', { member: m.name, name: s.name }));
    }
  }

  // 代付：替人扣款当天提醒去收；扣了还没收回的，第 3、7、14、30 天各提醒一次
  for (const s of state.subscriptions) {
    if (!s.proxy) continue;
    const name = s.proxy.forName || t('notify.proxy.someone');
    const contact = s.proxy.contact ? ` · ${s.proxy.contactVia ? `${s.proxy.contactVia} ` : ''}${s.proxy.contact}` : '';
    // 与代付页同一本账：已收、已免的期不提醒
    for (const c of proxyLedger(s, today).periods.filter((p) => p.status === 'due' && p.from >= addDays(today, -45))) {
      const d = diffDays(c.from, today);
      if (![0, 3, 7, 14, 30].includes(d)) continue;
      const charged = c.due;
      const ccy = c.currency;
      proxy.push({
        title: `${name} · ${s.name}`,
        sub: `${t('notify.proxy.sub', { status: d === 0 ? t('notify.proxy.chargedToday') : t('notify.proxy.chargedAgo', { date: cnDate(c.from), count: d }) })}${contact}`,
        amount: money(charged, ccy),
        amountSub: `≈ ${money(toBaseOrNaN(state, charged, ccy, c.from, collect), collect)}`,
        tone: d > 0 ? 'warn' : undefined,
        icon: iconOf(s),
      });
      headline.push(t(d === 0 ? 'notify.proxy.headlineToday' : 'notify.proxy.headlineUnpaid', { name, sub: s.name }));
    }
  }

  for (const m of state.methods) {
    const r = runwayFor(m, state, today);
    if (!r?.shortfall) continue;
    const d = diffDays(today, r.shortfall.date);
    const lead = m.lowRunwayDays ?? 30;
    if (d === lead || d === 14 || d === 7 || d === 3 || d === 1 || d === 0) {
      balance.push({
        title: m.name,
        sub: t('notify.balance.sub', {
          balance: money(r.current, m.currency),
          date: cnDate(r.shortfall.date),
          sub: r.shortfall.sub.name,
          amount: money(r.shortfall.amount, r.shortfall.currency),
        }),
        amount: relDays(d),
        tone: 'warn',
        icon: m.logo && !m.logo.startsWith('data:') ? m.logo : undefined,
      });
      headline.push(t('notify.balance.headline', { name: m.name }));
    }
  }

  const sections: Section[] = [
    { heading: t('notify.section.renew'), rows: renew },
    { heading: t('notify.section.trials'), rows: trials },
    { heading: t('core.renewal.cancelBy'), rows: cancellation },
    { heading: t('notify.section.balance'), rows: balance },
    { heading: t('notify.section.carpool'), rows: carpool },
    { heading: t('notify.section.proxy'), rows: proxy },
    { heading: t('notify.section.ending'), rows: ending },
  ].filter((x) => x.rows.length);
  if (!sections.length) return undefined;
  const title =
    headline.length === 1
      ? t('notify.daily.title', { headline: headline[0] })
      : t('notify.daily.titleMore', { headline: headline[0], count: headline.length, more: headline.length - 1 });
  const tot = totals(state, today);
  return {
    key: `daily:${today}`,
    kind: 'daily',
    subject: t('notify.daily.subject', { title }),
    title,
    intro: t('notify.daily.intro', { mrr: money(tot.mrr, base, { compact: true }), count: tot.activeCount }),
    sections,
    date: today,
    // 标题只放得下第一项，其余几项放进预览行
    preheader: headline.length > 1 ? headline.slice(1).join(' · ') : undefined,
  };
}

export function buildMonthly(state: AppState, today: string): Digest | undefined {
  if (!state.settings.monthlyDigest || !today.endsWith('-01')) return undefined;
  const base = state.settings.baseCurrency;
  const end = addMonths(today, 1);
  // 月度账单只列我自己的订阅；代付在「代付待收」里单独提醒
  const charges = state.subscriptions
    .filter((s) => !s.proxy)
    .flatMap((s) => chargesBetween(s, today, end, today).filter((c) => c.date < end))
    .sort((a, b) => a.date.localeCompare(b.date));
  // 有一笔折算不了，本月合计就显示「—」，不把它当 0 少算
  const sum = charges.reduce((acc, c) => acc + convert(c.amount, c.currency, base, state.fx), 0);
  const tot = totals(state, today);
  const [y, m] = today.split('-').map(Number);
  const ym = today.slice(0, 7);
  const p = {
    y,
    m,
    month: monthLabel(ym, { year: false, long: true }),
    monthYear: monthLabel(ym, { long: true }),
    count: charges.length,
    sum: money(sum, base, { compact: true }),
    mrr: money(tot.mrr, base, { compact: true }),
    arr: money(tot.mrr * 12, base, { compact: true }),
  };
  return {
    key: `monthly:${today.slice(0, 7)}`,
    kind: 'monthly',
    subject: t('notify.monthly.subject', p),
    title: t('notify.monthly.title', p),
    intro: t('notify.monthly.intro', p),
    date: today,
    stats: [
      { label: t('notify.email.stat.sum'), value: p.sum },
      { label: t('notify.email.stat.count'), value: String(p.count) },
      { label: t('notify.email.stat.mrr'), value: money(tot.mrr, base, { compact: true }) },
    ],
    sections: [
      {
        heading: t('notify.section.month'),
        rows: charges.map((c) => {
          const method = state.methods.find((x) => x.id === chargeMethodId(c));
          return {
            title: c.sub.name,
            sub: cnDate(c.date, true),
            amount: money(c.amount, c.currency),
            amountSub: c.currency !== base ? `≈ ${money(convert(c.amount, c.currency, base, state.fx), base)}` : undefined,
            icon: iconOf(c.sub),
            detail: [cnDate(c.date, true), method?.name].filter(Boolean).join(' · '),
          };
        }),
        total: charges.length ? { label: t('notify.email.total'), amount: `≈ ${money(sum, base)}` } : undefined,
      },
    ],
  };
}

/** 发送占位的租约：超过这么久仍是 sending，视为上次发送中途崩溃 */
export const SEND_LEASE_MS = 10 * 60_000;

/**
 * 把一份提醒发到所有开着的渠道（或只发 only 指定的那一个）。
 * 任一渠道成功即完成，不重复补发；全部失败持久化原提醒，在之后的整点最多补发 3 次。
 */
export async function sendDigest(
  env: Env,
  state: AppState,
  d: Digest,
  opts: { force?: boolean; only?: string; now?: number } = {},
): Promise<{ sent: boolean; reason?: string; results?: Array<{ channel: string; ok: boolean; error?: string }> }> {
  const targets = channelsOf(state.settings).filter((c) => (opts.only ? c.id === opts.only : c.enabled));
  if (!targets.length) return { sent: false, reason: opts.only ? t('notify.send.noChannel') : t('notify.send.noneEnabled') };
  const now = opts.now ?? Date.now();
  if (!opts.force) {
    // 原子占位：新提醒或到期的失败重试只有一个任务能取得发送权。
    // 占位带租约（retry_at = 现在 + SEND_LEASE_MS）：发送中途崩溃留下的 sending 过了租约可再被取走，不会永远卡住。
    const claim = await env.DB.prepare(
      `INSERT INTO notify_log (dedupe_key, kind, subject, status, digest, attempts, retry_at)
       VALUES (?1, ?2, ?3, 'sending', ?4, 1, ?6)
       ON CONFLICT(dedupe_key) DO UPDATE SET status = 'sending', attempts = notify_log.attempts + 1, retry_at = ?6
       WHERE notify_log.status IN ('failed', 'sending') AND notify_log.attempts < 4 AND notify_log.retry_at <= ?5`,
    )
      .bind(d.key, d.kind, d.subject, JSON.stringify(d), now, now + SEND_LEASE_MS)
      .run();
    if (!claim.meta.changes) return { sent: false, reason: t('notify.send.alreadySent') };
  }
  const results = await Promise.all(
    targets.map(async (c) => {
      try {
        await sendTo(env, c, d);
        return { channel: c.name, ok: true };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        console.error('[notify]', c.kind, error);
        return { channel: c.name, ok: false, error };
      }
    }),
  );
  const okCount = results.filter((r) => r.ok).length;
  const status = okCount === results.length ? 'sent' : okCount ? `partial ${okCount}/${results.length}` : 'failed';
  if (!okCount) {
    if (!opts.force) {
      const retryAt = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
      await env.DB.prepare("UPDATE notify_log SET status = 'failed', retry_at = ?2, error = ?3 WHERE dedupe_key = ?1")
        .bind(d.key, retryAt, results.map((r) => r.error).join('; '))
        .run();
    }
    return {
      sent: false,
      reason: results.map((r) => t('notify.send.failure', { channel: r.channel, error: r.error })).join(t('notify.send.failureSep')),
      results,
    };
  }
  await env.DB.prepare(
    "INSERT INTO notify_log (dedupe_key, kind, subject, status) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(dedupe_key) DO UPDATE SET status = excluded.status, sent_at = datetime('now'), retry_at = NULL, error = NULL",
  )
    .bind(opts.force ? `${d.key}:${Date.now()}` : d.key, d.kind, d.subject, status)
    .run();
  return { sent: true, results };
}

function localHour(tz: string, now = Date.now()): number {
  try {
    return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date(now)));
  } catch {
    return new Date(now).getUTCHours();
  }
}

export async function runScheduled(env: Env, state: AppState, now = Date.now()): Promise<string[]> {
  const log: string[] = [];
  // 重试使用原提醒快照，跨日后也保留原日期与去重键。
  // 含租约已过的 sending（上次发送中途崩溃）；旧版留下的 sending 没有 retry_at，不会被取到
  const pending = await env.DB.prepare("SELECT digest FROM notify_log WHERE status IN ('failed', 'sending') AND attempts < 4 AND retry_at <= ?1")
    .bind(now)
    .all<{ digest: string }>();
  for (const row of pending.results) {
    const d: Digest = JSON.parse(row.digest);
    const r = await sendDigest(env, state, d, { now });
    log.push(`${d.key}: ${r.sent ? 'sent' : r.reason}`);
  }
  const today = todayIn(state.settings.timezone, now);
  // 每 15 分钟运行：当地整点到达后的首轮发出；延迟任务允许当天补发，去重键保证每日一次。
  if (localHour(state.settings.timezone, now) < state.settings.notifyHour) return log;
  for (const d of [buildMonthly(state, today), buildDaily(state, today)]) {
    if (!d) continue;
    const r = await sendDigest(env, state, d, { now });
    log.push(`${d.key}: ${r.sent ? 'sent' : r.reason}`);
  }
  return log;
}

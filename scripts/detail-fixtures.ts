/** Fictional, date-relative subscription detail ledger. Run with Node --experimental-strip-types. */
import { addDays, addMonths, chargesBetween, phaseSubs, subError, todayIn } from '../shared/billing.ts';
import { resume, stopSubscription, switchPlan } from '../shared/phases.ts';
import { DEFAULT_SETTINGS, type Cycle, type ShareMember, type Subscription } from '../shared/types.ts';

export interface DetailCase {
  case: number;
  id: string;
  name: string;
  description: string;
  expected: { records: number; phases: number; members: number };
}

export function detailFixtures(today = todayIn('Asia/Shanghai')) {
  // Local seed, reset for every call: ids look like uid(), without leaking a case or type.
  let seed = 0x5ca1e2d7;
  const id = () =>
    Array.from({ length: 12 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor((seed / 0x100000000) * 36)];
    }).join('');
  const methodId = id();
  // 第二张卡：只给「十年老用户」换卡用，验证换卡、换方案时柱子不重叠
  const methodId2 = id();
  const monthsAgo = (n: number) => addMonths(`${today.slice(0, 8)}${String(Math.min(Number(today.slice(8)), 28)).padStart(2, '0')}`, -n);
  const cycles: Record<string, Cycle> = {
    周付: { unit: 'week', every: 1 },
    月付: { unit: 'month', every: 1 },
    季付: { unit: 'month', every: 3 },
    半年付: { unit: 'month', every: 6 },
    年付: { unit: 'year', every: 1 },
    两年付: { unit: 'year', every: 2 },
    按天: { unit: 'day', every: 30 },
    买断: { unit: 'lifetime', every: 1 },
    特殊: { unit: 'month', every: 1 },
  };
  const icons: Record<string, string> = { 周付: '📅', 月付: '🌙', 季付: '🍂', 半年付: '🌓', 年付: '🌏', 两年付: '🪐', 按天: '☀️', 买断: '💎', 特殊: '🧪' };
  const subscriptions: Subscription[] = [];
  const cases: DetailCase[] = [];
  const longNote = [
    '这是一份虚构的共享方案说明。车主负责向服务方付款，成员按约定周期分摊费用。甲的收款已经逾期，乙提前付到了明年，丙无需分摊但仍占用席位。丁已退出，原收款和退回的余额都保留在记录中，戊后来补位。这里的姓名、账号、金额与服务均为虚构。',
    '续费前请先核对服务到期日、实际扣款日和最晚取消日。这三个日期可能不同，提前扣款也不代表服务提前到期。退款只减少实际收到的款项，不能抹去当时的付款与成员退出事实。',
    '备注可以分成多段，供成员阅读收费安排与变更原因。本段用于检查窄屏换行、长文展开和复制操作，也用于观察备注是否挤压日期、金额及按钮。所有历史都应按原有时间顺序保留，未来的计划阶段不能显示为已经付款，退出记录也应保持可查。',
  ].join('\n\n');
  const base = (name: string, start = addMonths(today, -11), patch: Partial<Subscription> = {}): Subscription => {
    const category = name.split(' · ')[0];
    return {
      id: id(),
      name,
      category,
      tags: [],
      price: 36,
      currency: 'CNY',
      cycle: cycles[category],
      start,
      status: 'active',
      icon: icons[category],
      methodId,
      ...patch,
    };
  };
  // Materialize the real billing schedule, including introductory/bonus/advance-charge rules.
  // Closed phases suppress inference after their end; open phases retain the next real cash date.
  const paid = (s: Subscription): Subscription => {
    const records = (p: Subscription) => ({
      payments: chargesBetween(p, p.start, today, today).map(({ date, amount, currency, kind, settled, note }) => ({
        date,
        amount,
        currency,
        kind,
        settled,
        note,
      })),
      nextDue:
        p.cycle.unit === 'lifetime'
          ? undefined
          : (chargesBetween(p, addDays(today, 1), addMonths(today, 36), today).find((c) => !c.kind)?.date ?? addDays(p.end ?? today, 1)),
    });
    return s.phases?.length ? { ...s, phases: phaseSubs(s).map((p, i) => ({ ...s.phases![i], ...records(p) })) } : { ...s, ...records(s) };
  };
  const add = (n: number, s: Subscription, description: string) => {
    const error = subError(s);
    if (error) throw new Error(`${s.name}: ${error}`);
    if (phaseSubs(s).some((p) => p.payments?.some((r) => r.date > today))) throw new Error(`${s.name}: future actual payment`);
    subscriptions.push(s);
    cases.push({
      case: n,
      id: s.id,
      name: s.name,
      description,
      expected: {
        records: chargesBetween(s, s.start, today, today).length,
        phases: phaseSubs(s).length,
        members: s.share?.members.length ?? 0,
      },
    });
  };
  const member = (name: string, joined: string, patch: Partial<ShareMember> = {}): ShareMember => ({
    id: id(),
    name,
    joined,
    share: 10,
    fee: 10,
    feeCurrency: 'CNY',
    billEvery: 1,
    ...patch,
  });
  const owner = (s: Subscription, full = false, billEvery = 1): Subscription => {
    const joined = s.start;
    // 一笔收款从加入起覆盖 months 个月：按成员的周期切成各期
    const receipt = (months: number, amount: number) => [
      { id: id(), date: joined, amount, currency: 'CNY', periods: Array.from({ length: months / billEvery }, (_, k) => addMonths(joined, k * billEvery)) },
    ];
    const elapsedMonths = (Number(today.slice(0, 4)) - Number(joined.slice(0, 4))) * 12 + Number(today.slice(5, 7)) - Number(joined.slice(5, 7));
    const overdueMonths = Math.floor((elapsedMonths - 3) / billEvery) * billEvery;
    const prepaidMonths = Math.ceil((elapsedMonths + 12) / billEvery) * billEvery;
    const share = 10 * s.cycle.every * (s.cycle.unit === 'year' ? 12 : 1);
    const members = [
      member('虚构甲', joined, { share, fee: 10 * billEvery, billEvery, receipts: receipt(overdueMonths, overdueMonths * 10) }),
      member('虚构乙', joined, { share, fee: 10 * billEvery, billEvery, receipts: receipt(prepaidMonths, prepaidMonths * 10) }),
    ];
    if (full)
      members.push(
        member('虚构丙', joined, { exempt: true, share: 0 }),
        member('虚构丁', joined, {
          share,
          left: addDays(today, -20),
          receipts: receipt(prepaidMonths, prepaidMonths * 10),
          leaveRefund: { date: addDays(today, -20), amount: 30, currency: 'CNY' },
        }),
        member('虚构戊', addDays(today, -19), { share }),
      );
    return {
      ...s,
      share: { role: 'owner', seats: full ? 5 : 4, since: joined, collectFrom: joined, rule: { fee: 10 * billEvery, currency: 'CNY', billEvery }, members },
    };
  };
  const multi = (s: Subscription, count: number, stepMonths: number): Subscription => {
    let v: Subscription = { ...s, region: 'US' };
    for (let i = 1; i < count; i++)
      v = switchPlan(v, addMonths(s.start, i * stepMonths), {
        // 美区每次小幅调价；土区约为美区的 35%，按里拉计价（汇率 34.2），折合后与美区同一量级，走势不会剧烈跳动
        price: i % 2 ? Math.round((s.price + i) * 0.35 * 34.2) : s.price + i,
        currency: i % 2 ? 'TRY' : 'USD',
        cycle: s.cycle,
        region: i % 2 ? 'TR' : 'US',
        methodId,
      });
    return paid(v);
  };

  add(1, paid(base('周付 · 两年', addDays(today, -728), { price: 12 })), '105 笔周付；展开后验证两年连续记录与长历史滚动。');
  add(2, paid(base('月付 · 三年平稳', addMonths(today, -35))), '36 笔月付，三年价格不变；走势为平线。');
  let s = paid(base('月付 · 每月返佣', addMonths(today, -34)));
  s.payments = s.payments!.flatMap((p) => [p, { date: p.date, amount: -3, kind: 'adjust' as const, note: '虚构每月返佣' }]);
  add(3, s, '35 个月，每月扣款与负数返佣各一行，共 70 行；检查负数及同日排序。');
  add(
    4,
    multi(base('月付 · 换区调价多段', monthsAgo(19), { price: 20, currency: 'USD' }), 5, 4),
    '5 个阶段，在 US/USD 与 TR/TRY 间切换并调价；检查历史价格和币种。',
  );
  add(5, owner(paid(base('月付 · 合租车主'))), '当前 3/4 席（含车主），一人逾期、一人预付；检查空席及收款覆盖期。');
  add(
    6,
    paid(base('月付 · 加入别人合租', addMonths(today, -11), { price: 12, share: { role: 'member', seats: 4, ownerName: '虚构车主', members: [] } })),
    'role=member，只记本人分摊款，验证与车主视角不同。',
  );
  add(
    7,
    base('月付 · 试用中', addDays(today, -9), { status: 'trial', trialEnd: addDays(today, 5) }),
    '试用首扣在 5 天后，零历史扣款；不能把免费试用推算为已付款。',
  );
  add(
    8,
    paid(base('月付 · 暂停中', addMonths(today, -13), { status: 'paused', pausedAt: addMonths(today, -1) })),
    '已暂停一个月，保留此前付款；暂停之后没有扣款。',
  );
  add(9, paid(base('月付 · 今天首笔', today)), '今天开始且只有一笔实际付款，验证首日与单点走势。');
  s = paid(base('月付 · 失败退款补差混合', addMonths(today, -4)));
  s.payments = s.payments!.flatMap((p) => [p, { date: p.date, amount: 36, kind: 'failed' as const }, { date: p.date, amount: -4, kind: 'refund' as const }]);
  s.payments.push({ date: today, amount: 5, kind: 'adjust', note: '虚构升级补差' });
  add(10, s, '16 行：正常扣款、失败、退款、正数补差；失败不计支出，退款不超过已付。');
  add(11, paid(base('月付 · 冷门币种缺汇率', undefined, { price: 27, currency: 'XCD' })), 'XCD 不在当前及历史汇率表；本位币金额应显示未知，不能显示为 0。');
  s = paid(base('月付 · 外币标价卡上实扣', undefined, { price: 19.99, currency: 'USD' }));
  s.payments = s.payments!.map((p) => ({ ...p, settled: { amount: 157.23, currency: 'HKD' } }));
  add(12, s, 'USD 标价、HKD 卡上实扣、CNY 本位币，验证 settled 的三币显示。');
  // Preserve an actual cash date of today even when calendar-month anchors clamp at month-end.
  s = paid(base('月付 · 今天就是扣款日'));
  s.payments!.at(-1)!.date = today;
  add(13, s, '已有一年历史，最后一笔实际扣款为今天；与今天才开始的单笔用例区分。');

  add(14, paid(base('季付 · 两年平稳', addMonths(today, -21), { price: 99 })), '8 笔季付，每 3 个月一次；验证周期名称与两年平稳走势。');
  add(15, owner(paid(base('季付 · 合租车主', addMonths(today, -21), { price: 120 })), false, 3), '车主 3/4 席，成员每季收 30 元；验证收款周期确为 3 个月。');
  s = switchPlan(base('季付 · 中途调价', addMonths(today, -21), { price: 90 }), addMonths(today, -9), {
    price: 120,
    currency: 'CNY',
    cycle: cycles.季付,
    methodId,
  });
  add(16, paid(s), '4 期旧价后换为 120 元，两个季度阶段；历史价格不能被新价覆盖。');
  s = paid(base('季付 · 主动取消 · 部分退款', addMonths(today, -1), { price: 300 }));
  add(17, stopSubscription(s, today, 'cancel', addDays(today, -5), undefined, { amount: 50 }), '季付未用完即主动取消，实退 50 元；验证部分退款及未退余额。');

  add(18, paid(base('半年付 · 三年平稳', addMonths(today, -30), { price: 180 })), '6 笔半年付，每 6 个月一次，三年价格不变。');
  add(
    19,
    paid(base('半年付 · 即将到期不续', addDays(addMonths(today, -6), 21), { price: 180, end: addDays(today, 20), status: 'cancelled' })),
    '服务最后一天在 20 天后，目前仍有效但不再续费，验证即将结束状态。',
  );
  s = base('半年付 · 断档后续订', monthsAgo(34), { price: 180, end: addDays(monthsAgo(22), -1), status: 'cancelled' });
  s = resume(s, monthsAgo(18), { price: 210, currency: 'CNY', cycle: cycles.半年付, methodId });
  add(20, paid(s), '首段两笔，结束后空出整 4 个月，再按半年续订；验证断档不生成付款。');

  add(21, paid(base('年付 · 刚开始', today, { price: 360 })), '今天开始年付，只有 1 笔；下一笔一年后，不应显示额外历史。');
  s = base('年付 · 八年逐年调价', addMonths(today, -90), { price: 180 });
  for (let i = 1; i < 8; i++) s = switchPlan(s, addMonths(s.start, i * 12), { price: 180 + i * 35, currency: 'CNY', cycle: cycles.年付, methodId });
  add(22, paid(s), '8 个年付阶段、8 笔付款，逐年从 180 涨到 425 元；验证价格阶梯与历程。');
  add(
    23,
    {
      ...owner(paid(base('年付 · 合租满员 · 长备注', addMonths(today, -12), { price: 600 })), true),
      notes: longNote,
      account: 'fictional-owner@example.invalid',
    },
    '当前 5/5 席，另保留一名已退出且退款的成员；约 300 字多段备注验证换行与成员历史。',
  );
  s = paid(base('年付 · 服务方停用 · 有损失', addMonths(today, -6), { price: 1200 }));
  add(
    24,
    stopSubscription(s, today, 'terminate', addDays(today, -5), '虚构服务方关闭旧方案，未退还预付余额。'),
    '服务方提前停用，无退款且存在未用损失；验证原因、损失和终止状态。',
  );
  add(
    25,
    paid(base('年付 · 已到期', addMonths(today, -14), { price: 360, end: addDays(addMonths(today, -2), -1), status: 'cancelled' })),
    '完整年付服务在两个月前结束，保留一笔付款，结束后无续扣。',
  );
  add(
    26,
    paid(base('年付 · 提前扣款', addMonths(today, -23), { price: 360, chargeLeadDays: 30, cancelLeadDays: 7 })),
    '续费在服务边界前 30 天扣款，最晚取消为扣款前 7 天；三个日期各自正确。',
  );
  add(
    27,
    paid(
      base('年付 · 首期优惠 · 赠送时长', addMonths(today, -15), {
        price: 360,
        intro: { price: 99, until: addMonths(today, -3) },
        bonus: { from: addMonths(today, -3), until: addMonths(today, 3) },
      }),
    ),
    '首年优惠 99 元已结束，随后赠送半年，目前零续扣；验证优惠与赠送覆盖。',
  );

  add(28, paid(base('两年付 · 六年', addMonths(today, -60), { price: 680 })), '每两年一次，共 3 笔付款；验证两年周期与六年服务覆盖。');
  add(29, paid(base('两年付 · 刚开始', today, { price: 680 })), '今天首付 680 元，只有 1 笔，两年后才续费。');
  add(30, paid(base('按天 · 每 30 天一扣', addDays(today, -360), { price: 30 })), '13 笔，每隔 30 天扣款；跨月漂移不能被格式化为自然月付。');
  add(31, paid(base('买断 · 一次付清', addMonths(today, -24), { price: 199 })), '一次性买断，1 笔且没有续费预测。');
  s = switchPlan(base('买断 · 后又升级', addMonths(today, -24), { price: 199 }), addMonths(today, -3), {
    price: 288,
    currency: 'CNY',
    cycle: cycles.买断,
    methodId,
  });
  add(32, paid(s), '两个 lifetime 阶段，各有一笔实际购买；买断升级也应保留旧价。');

  add(33, base('特殊 · 未开始', addDays(today, 20)), '20 天后开始，零历史及实际付款；验证未开始状态。');
  s = switchPlan(
    base('特殊 · 计划变更 · 并行方案', addMonths(today, -8), { region: 'US', currency: 'USD' }),
    addDays(today, -15),
    { price: 90, currency: 'TRY', cycle: cycles.月付, region: 'TR', methodId },
    addDays(today, 25),
  );
  s = switchPlan(s, addDays(today, 12), { price: 320, currency: 'CNY', cycle: cycles.年付, region: 'JP', planned: true, methodId });
  add(34, paid(s), 'US 旧方案仍在并行，TR 当前方案已付款，12 天后计划换 JP 年付待确认；计划无实际付款。');
  add(
    35,
    paid(
      base('特殊 · 超长名称与账号 · 星际协作 Interstellar Creative 全家桶专业年度增强方案与扩展存储', addMonths(today, -3), {
        account: `${'verylongfictionalaccount'.repeat(5)}@example.invalid`,
        url: `https://example.invalid/${'extremely-long-fictional-service-path/'.repeat(8)}`,
        manageUrl: `https://example.invalid/manage/${'fictional-billing-settings/'.repeat(8)}`,
      }),
    ),
    '约 60 字中英混合名称，长邮箱及两个长链接；验证截断、换行和复制。',
  );
  add(
    36,
    paid(base('特殊 · 无支付方式无分类', undefined, { methodId: undefined, category: '' })),
    '支付方式和分类均缺省，仍保留 emoji；验证可选信息缺失时的详情。',
  );
  s = paid(base('特殊 · 代付进行中'));
  s.proxy = {
    forName: '虚构代付对象',
    receipts: [{ id: id(), date: today, amount: 36, currency: 'CNY', periods: [s.payments!.at(-1)!.date] }],
    charged: [{ charge: s.payments!.at(-1)!.date, amount: 36 }],
    note: '虚构代付，月末结清',
  };
  add(37, s, '进行中的 proxy，保留支出及收回款，从代付列表打开详情。');
  add(
    38,
    paid(base('特殊 · 极端金额 · 高额年付', addMonths(today, -36), { cycle: cycles.年付, price: 123456.78, icon: icons.年付 })),
    '38a：每年 ¥123,456.78，4 笔；验证大金额、小数和本位币排版。',
  );
  add(
    38,
    paid(base('特殊 · 极端金额 · 低价周付', addDays(today, -84), { cycle: cycles.周付, price: 0.99, currency: 'USD', icon: icons.周付 })),
    '38b：每周 $0.99，13 笔；验证小金额与跨币种换算。',
  );
  s = base('特殊 · 全都有', monthsAgo(19), { price: 20, currency: 'USD', region: 'US', intro: { price: 6, until: addDays(monthsAgo(19), 10) } });
  s = multi(s, 20, 1);
  for (const p of s.phases!) p.payments!.push({ date: p.start, amount: -2, kind: 'adjust', note: '虚构每月返佣' });
  s = switchPlan(s, addDays(today, 18), { price: 88, currency: 'CNY', cycle: cycles.月付, planned: true, region: 'JP', methodId });
  add(
    39,
    { ...owner(s, true), account: 'fictional-everything@example.invalid', notes: longNote },
    '月付车主满员、20 段换区调价与 40 行密集记录、18 天后计划变更、已结束的首期优惠及长备注。',
  );

  // 十年月付：2016 年起，两次调价，第七年换卡；换卡那期旧卡扣完一周后新卡又扣一笔，两笔挨在一起
  s = base('月付 · 十年老用户', monthsAgo(120), { price: 25 });
  s = switchPlan(s, addMonths(s.start, 36), { price: 30, currency: 'CNY', cycle: cycles.月付, methodId });
  s = switchPlan(s, addDays(addMonths(s.start, 80), 7), { price: 36, currency: 'CNY', cycle: cycles.月付, methodId: methodId2 });
  s = switchPlan(s, addMonths(s.start, 104), { price: 42, currency: 'CNY', cycle: cycles.月付, methodId: methodId2 });
  add(40, paid(s), '十年月付约 120 笔：两次调价、第七年换卡；换卡当月两笔相隔一周，检查堆叠柱与按年折叠。');

  s = base('月付 · 导入记录 · 暂无扣款', monthsAgo(8), { estimateFrom: addDays(today, 1) });
  add(41, s, '导入后尚无已知扣款：提示独占正文，检查左右对齐、底部留白和窄屏换行。');
  add(
    41,
    { ...s, id: id(), name: '月付 · 导入记录 · 已有扣款', payments: [{ date: addDays(today, -5), amount: 36 }] },
    '导入后已有一笔已知扣款：提示不再显示，只留扣款表，检查表格全宽。',
  );

  const fxDates = new Set(subscriptions.flatMap((s) => chargesBetween(s, s.start, today, today).map((c) => c.date)).concat(today));
  const first = subscriptions.map((s) => s.start).sort()[0];
  for (let d = `${first.slice(0, 7)}-01`; d <= today; d = addMonths(d, 1)) {
    const end = addDays(addMonths(d, 1), -1);
    fxDates.add(end < today ? end : today);
  }
  const rates = { USD: 1, CNY: 7.12, HKD: 7.78, JPY: 151.5, TRY: 34.2 };
  return {
    backup: {
      format: 'calends-backup',
      version: 3,
      exportedAt: new Date().toISOString(),
      subscriptions,
      methods: [
        { id: methodId, name: '虚构测试卡', kind: 'credit', currency: 'CNY', last4: '0000' },
        { id: methodId2, name: '虚构备用卡', kind: 'debit', currency: 'CNY', last4: '1111' },
      ],
      people: [],
      settings: {
        ...DEFAULT_SETTINGS,
        baseCurrency: 'CNY',
        collectCurrency: 'CNY',
        timezone: 'Asia/Shanghai',
        language: 'zh-CN',
        displayName: '虚构订阅账本',
        monthlyDigest: false,
        categories: Object.keys(cycles).map((name) => ({ name })),
      },
      fx: { base: 'USD', rates, fetchedAt: today },
      fxDaily: [...fxDates].sort().map((date) => ({ date, rates, source: 'fictional-detail-fixtures' })),
    },
    cases,
    today,
    limitations: [],
  };
}

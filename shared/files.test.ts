import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anchorChoices,
  anchorError,
  cleanFileName,
  downloadName,
  fileBadgeKind,
  fileCoverage,
  fileReceiptPerson,
  fileTitle,
  fileYear,
  filesForReceipt,
  filesOf,
  orphanFiles,
  sniffMime,
  type FileMeta,
} from './files.ts';
import { flatten, setLocale } from './i18n.ts';
import { maskForPublic } from './mask.ts';
import { DEFAULT_SETTINGS, type AppState, type Subscription } from './types.ts';
import core from './locales/zh-CN/core.json' with { type: 'json' };

setLocale('zh-CN', [flatten('core', core)]);

const sub = (o: Partial<Subscription> = {}): Subscription => ({
  id: 's1',
  name: 'Fictional Cloud',
  category: 'Software',
  tags: [],
  price: 10,
  currency: 'USD',
  cycle: { unit: 'month', every: 1 },
  start: '2026-01-17',
  status: 'active',
  ...o,
});
const file = (o: Partial<FileMeta> = {}): FileMeta => ({
  id: 'f1',
  name: 'scan 001.pdf',
  mime: 'application/pdf',
  size: 1000,
  createdAt: '2026-11-20T08:00:00.000Z',
  ...o,
});
const bytes = (...xs: number[]) => new Uint8Array([...xs, ...Array.from({ length: 16 }, () => 0)]);

test('按文件头认类型，不认识的拒收', () => {
  assert.equal(sniffMime(new TextEncoder().encode('%PDF-1.7\n')), 'application/pdf');
  assert.equal(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMime(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMime(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined, 'SVG 可带脚本，不收');
  assert.equal(sniffMime(new TextEncoder().encode('<html>')), undefined);
  assert.equal(sniffMime(new Uint8Array()), undefined);
});

test('原始文件名去路径与控制字符、限长', () => {
  assert.equal(cleanFileName('C:\\Users\\a\\发票.pdf'), '发票.pdf');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('a\u0000b\nc.pdf'), 'abc.pdf');
  assert.equal(cleanFileName(''), 'file');
  assert.equal(cleanFileName(undefined), 'file');
  assert.equal([...cleanFileName('字'.repeat(300))].length, 120);
});

test('挂法校验：未关联不带日期，资料不带日期，合同期与扣款要日期', () => {
  const subs = [sub()];
  assert.equal(anchorError({ subId: null, kind: null, date: null }, subs), undefined);
  assert.ok(anchorError({ subId: null, kind: 'charge', date: '2026-01-17' }, subs));
  assert.ok(anchorError({ subId: 'nope', kind: 'sub', date: null }, subs));
  assert.equal(anchorError({ subId: 's1', kind: 'sub', date: null }, subs), undefined);
  assert.ok(anchorError({ subId: 's1', kind: 'sub', date: '2026-01-17' }, subs));
  assert.equal(anchorError({ subId: 's1', kind: 'charge', date: '2026-02-17' }, subs), undefined);
  assert.ok(anchorError({ subId: 's1', kind: 'charge', date: null }, subs));
  assert.ok(anchorError({ subId: 's1', kind: 'charge', date: '2026-02-30' }, subs));
  assert.ok(anchorError({ subId: 's1', kind: 'other' as never, date: '2026-02-17' }, subs));
});

test('显示名按关联派生：扣款、退款、合同期、资料、多份编号', () => {
  const s = sub({
    payments: [
      { date: '2026-03-17', amount: 10 },
      { date: '2026-04-02', amount: -10, kind: 'refund' },
    ],
    contract: { start: '2026-01-17', term: { unit: 'year', every: 1 } },
  });
  const subs = [s];
  const a = file({ id: 'a', subId: 's1', kind: 'charge', date: '2026-03-17' });
  const b = file({ id: 'b', subId: 's1', kind: 'charge', date: '2026-04-02' });
  const c = file({ id: 'c', subId: 's1', kind: 'contract', date: '2026-01-17' });
  const d = file({ id: 'd', subId: 's1', kind: 'sub' });
  const files = [a, b, c, d];
  assert.equal(fileTitle(a, files, subs), 'Fictional Cloud · 2026-03-17 扣款');
  assert.equal(fileTitle(b, files, subs), 'Fictional Cloud · 2026-04-02 退款');
  assert.equal(fileTitle(c, files, subs), 'Fictional Cloud · 合同 2026-01-17 至 2027-01-16');
  assert.equal(fileTitle(d, files, subs), 'Fictional Cloud · 资料');
  assert.equal(downloadName(a, files, subs), 'FictionalCloud_2026-03-17_扣款.pdf');
  assert.equal(downloadName(c, files, subs), 'FictionalCloud_合同2026-01-17至2027-01-16.pdf');
  // 同一笔两份：第二份带编号
  const a2 = file({ id: 'a2', subId: 's1', kind: 'charge', date: '2026-03-17', createdAt: '2026-11-21T00:00:00.000Z', mime: 'image/jpeg' });
  const more = [...files, a2];
  assert.equal(fileTitle(a, more, subs), 'Fictional Cloud · 2026-03-17 扣款');
  assert.equal(fileTitle(a2, more, subs), 'Fictional Cloud · 2026-03-17 扣款 2');
  assert.equal(downloadName(a2, more, subs), 'FictionalCloud_2026-03-17_扣款_2.jpg');
  // 有日期的倒序，资料排最后
  assert.deepEqual(
    filesOf(files, 's1').map((f) => f.id),
    ['b', 'a', 'c', 'd'],
  );
});

test('分开记账：缴费日写「缴费」，其余写「账单」', () => {
  const s = sub({ settlement: 'separate', payments: [{ date: '2026-03-01', amount: 30 }] });
  const paid = file({ subId: 's1', kind: 'charge', date: '2026-03-01' });
  const bill = file({ id: 'f2', subId: 's1', kind: 'charge', date: '2026-02-17' });
  assert.match(fileTitle(paid, [paid, bill], [s]), /缴费$/);
  assert.match(fileTitle(bill, [paid, bill], [s]), /账单$/);
});

test('未关联显示原始文件名；订阅删除后带「已删除 · 原订阅名」', () => {
  const loose = file();
  assert.equal(fileTitle(loose, [loose], []), 'scan 001.pdf');
  assert.equal(downloadName(loose, [loose], []), 'scan 001.pdf');
  const gone = file({ orphan: { name: 'Old Music', kind: 'charge', date: '2025-06-01' } });
  assert.equal(fileTitle(gone, [gone], []), '已删除 · Old Music · 2025-06-01 扣款');
  assert.equal(downloadName(gone, [gone], []), '已删除_OldMusic_2025-06-01_扣款.pdf');
});

test('年份：有日期按日期，资料与未关联按上传时间', () => {
  assert.equal(fileYear(file({ subId: 's1', kind: 'charge', date: '2025-12-31' })), '2025');
  assert.equal(fileYear(file({ orphan: { name: 'x', kind: 'charge', date: '2024-01-01' } })), '2024');
  assert.equal(fileYear(file({ subId: 's1', kind: 'sub' })), '2026');
});

test('公开页不下发文件', () => {
  const state = {
    subscriptions: [sub()],
    methods: [],
    fx: { base: 'USD', rates: {} },
    settings: { ...DEFAULT_SETTINGS, publicView: true },
    files: [file()],
    filesEnabled: true,
  } as unknown as AppState;
  const pub = maskForPublic(state) as unknown as Record<string, unknown>;
  assert.equal(pub.files, undefined);
  assert.equal(pub.filesEnabled, undefined);
});

test('删除订阅：它的文件留下来源快照、不再挂在订阅上，别的文件不变', () => {
  const s = sub({ icon: '☁️' });
  const mine = file({ id: 'a', subId: 's1', kind: 'charge', date: '2026-02-17' });
  const info = file({ id: 'b', subId: 's1', kind: 'sub' });
  const other = file({ id: 'c', subId: 's2', kind: 'sub' });
  const out = orphanFiles([mine, info, other], s);
  assert.deepEqual(out[0], { ...file({ id: 'a' }), orphan: { name: 'Fictional Cloud', kind: 'charge', date: '2026-02-17' } });
  assert.equal(out[1].subId, undefined);
  assert.deepEqual(out[1].orphan, { name: 'Fictional Cloud', kind: 'sub' });
  assert.equal(out[2], other);
  assert.equal(fileTitle(out[0], out, [other as never]).includes('Fictional Cloud'), true);
});

test('凭证覆盖：从第一份扣款凭证那一期起，之后每笔正常扣款都要有凭证', () => {
  const s = sub();
  const files = [
    file({ id: 'a', subId: 's1', kind: 'charge', date: '2026-08-17' }),
    file({ id: 'b', subId: 's1', kind: 'charge', date: '2026-10-17' }),
    file({ id: 'c', subId: 's1', kind: 'sub' }),
    file({ id: 'd', subId: 's1', kind: 'charge', date: '2026-09-03' }),
  ];
  const c = fileCoverage(s, files, '2026-11-20');
  assert.deepEqual(
    c.slots.map((x) => [x.date, x.files.map((f) => f.id)]),
    [
      ['2026-11-17', []],
      ['2026-10-17', ['b']],
      ['2026-09-17', []],
      ['2026-08-17', ['a']],
    ],
    '第一份凭证之前的 1 至 7 月不追踪；未来扣款不算',
  );
  assert.equal(c.covered, 2);
  assert.deepEqual(
    c.rest.map((f) => f.id),
    ['d', 'c'],
    '对不上扣款日的在前，资料最后',
  );
});

test('凭证覆盖：没传过扣款凭证的订阅不追踪；退款与免费不要求凭证', () => {
  assert.deepEqual(fileCoverage(sub(), [file({ subId: 's1', kind: 'sub' })], '2026-11-20').slots, []);
  const s = sub({ payments: [{ date: '2026-10-20', amount: -10, kind: 'refund' }] });
  const c = fileCoverage(s, [file({ subId: 's1', kind: 'charge', date: '2026-10-17' })], '2026-11-01');
  assert.deepEqual(
    c.slots.map((x) => x.date),
    ['2026-10-17'],
  );
});

test('合租与代付收款凭证：挂法校验、标签区分、同日不串号、覆盖追踪与删除来源快照', () => {
  const carpool = sub({
    id: 'car1',
    name: 'Family Cloud',
    share: {
      role: 'owner',
      seats: 4,
      members: [
        {
          id: 'm1',
          name: 'Alice',
          share: 5,
          receipts: [
            { id: 'r-alice-1', date: '2026-10-03', amount: 35, currency: 'CNY', periods: ['2026-10-01'] },
            { id: 'r-alice-open', date: '2026-09-01', amount: 0, currency: 'CNY', periods: ['2026-09-01'], opening: true },
          ],
        },
        {
          id: 'm2',
          name: 'Bob',
          share: 5,
          receipts: [
            { id: 'r-bob-1', date: '2026-10-03', amount: 35, currency: 'CNY', periods: ['2026-10-01'] },
            { id: 'r-bob-2', date: '2026-11-03', amount: 35, currency: 'CNY', periods: ['2026-11-01'] },
          ],
        },
      ],
    },
  });
  const proxy = sub({
    id: 'px1',
    name: 'AI Pro Proxy',
    proxy: {
      forName: 'Lin',
      receipts: [{ id: 'r-px-1', date: '2026-10-15', amount: 145, currency: 'CNY', periods: ['2026-10-15'] }],
    },
  });
  const subs = [carpool, proxy];

  // 挂法校验
  assert.equal(anchorError({ subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: 'r-alice-1' }, subs), undefined);
  assert.equal(anchorError({ subId: 'px1', kind: 'receipt', date: '2026-10-15', receiptId: 'r-px-1' }, subs), undefined);
  assert.ok(anchorError({ subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: null }, subs));
  assert.ok(anchorError({ subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: 'missing' }, subs));
  assert.equal(anchorError({ subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: 'missing' }, subs, { requireReceipt: false }), undefined);
  assert.ok(anchorError({ subId: 'car1', kind: 'charge', date: '2026-10-03', receiptId: 'r-alice-1' }, subs));

  // 同日不同成员收款各自从 1 起不串号；同一笔收款两份文件才编号
  const fAlice1 = file({ id: 'fa1', subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: 'r-alice-1', mime: 'image/png' });
  const fAlice2 = file({
    id: 'fa2',
    subId: 'car1',
    kind: 'receipt',
    date: '2026-10-03',
    receiptId: 'r-alice-1',
    mime: 'image/png',
    createdAt: '2026-11-21T08:00:00.000Z',
  });
  const fBob1 = file({ id: 'fb1', subId: 'car1', kind: 'receipt', date: '2026-10-03', receiptId: 'r-bob-1', mime: 'image/jpeg' });
  const fPx1 = file({ id: 'fp1', subId: 'px1', kind: 'receipt', date: '2026-10-15', receiptId: 'r-px-1', mime: 'image/png' });
  const all = [fAlice1, fAlice2, fBob1, fPx1];

  assert.equal(fileBadgeKind(fAlice1, subs), 'carpool');
  assert.equal(fileBadgeKind(fPx1, subs), 'proxy');
  assert.equal(fileReceiptPerson(fAlice1, subs), 'Alice');
  assert.equal(fileReceiptPerson(fPx1, subs), 'Lin');
  assert.equal(fileTitle(fAlice1, all, subs), 'Family Cloud · 2026-10-03 Alice 合租收款');
  assert.equal(fileTitle(fAlice2, all, subs), 'Family Cloud · 2026-10-03 Alice 合租收款 2');
  assert.equal(fileTitle(fBob1, all, subs), 'Family Cloud · 2026-10-03 Bob 合租收款');
  assert.equal(fileTitle(fPx1, all, subs), 'AI Pro Proxy · 2026-10-15 Lin 代付收款');
  assert.equal(downloadName(fPx1, all, subs), 'AIProProxy_2026-10-15_Lin_代付收款.png');
  assert.deepEqual(
    filesForReceipt(all, 'car1', 'r-alice-1').map((f) => f.id),
    ['fa1', 'fa2'],
  );

  // 可选项排除期初结清
  assert.deepEqual(
    anchorChoices(carpool, '2026-11-20').receipts.map((r) => r.id),
    ['r-bob-2', 'r-alice-1', 'r-bob-1'],
  );

  // 覆盖追踪：从首份收款凭证起，Bob 11 月未补凭证会出现在缺凭证槽位
  const cov = fileCoverage(carpool, all, '2026-11-20');
  assert.deepEqual(
    cov.slots.map((x) => [x.kind, x.receiptId, x.files.map((f) => f.id)]),
    [
      ['receipt', 'r-bob-2', []],
      ['receipt', 'r-alice-1', ['fa1', 'fa2']],
      ['receipt', 'r-bob-1', ['fb1']],
    ],
  );
  assert.equal(cov.covered, 2);

  // 删除订阅保留合租/代付标签与付款人快照
  const orphaned = orphanFiles([fAlice1, fPx1], carpool);
  assert.equal(fileBadgeKind(orphaned[0], [proxy]), 'carpool');
  assert.equal(fileReceiptPerson(orphaned[0], [proxy]), 'Alice');
  assert.equal(fileTitle(orphaned[0], orphaned, [proxy]), '已删除 · Family Cloud · 2026-10-03 Alice 合租收款');
});

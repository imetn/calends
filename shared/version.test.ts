import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  autoCheckDue,
  compareVersions,
  isNewer,
  LATEST_RELEASE_API,
  nextUpdateCache,
  parseRelease,
  parseUpdateCache,
  parseVersion,
  RELEASE_NOTES_MAX,
  releaseNotes,
  SETTINGS_CHECK_INTERVAL,
  UPDATE_CHECK_INTERVAL,
} from './version.ts';

test('版本比较：v 前缀、逐段按数字比、相等', () => {
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.10.0', '1.9.0')! > 0);
  assert.ok(compareVersions('1.9.0', '1.10.0')! < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99')! > 0);
  assert.ok(compareVersions('1.37.1', 'v1.37.0')! > 0);
  assert.equal(compareVersions('1.2.3+build.5', '1.2.3'), 0);
});

test('版本比较：预发布低于同号正式版，按语义化版本规则排序', () => {
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1')! > 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')! < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta')! < 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')! < 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-rc.1')! < 0);
});

test('开发版本或非语义化版本不参与比较，也不算有新版', () => {
  for (const v of ['test', 'dev', '', '1.2', '1.2.3.4', '01.2.3', 'version1.2.3']) assert.equal(parseVersion(v), null, v);
  assert.equal(compareVersions('1.38.0', 'dev'), null);
  assert.equal(isNewer('1.38.0', 'test'), false);
  assert.equal(isNewer('garbage', '1.37.0'), false);
  assert.equal(isNewer(undefined, '1.37.0'), false);
  assert.equal(isNewer('1.37.0', '1.37.0'), false);
  assert.equal(isNewer('v1.38.0', '1.37.0'), true);
  assert.equal(isNewer('1.36.0', '1.37.0'), false);
  assert.equal(isNewer('1.38.0', '1.38.0-beta.1'), true);
});

test('GitHub release 解析：只认本仓库的正式版发布页', () => {
  const url = 'https://github.com/imetn/calends/releases/tag/v1.38.0';
  assert.equal(LATEST_RELEASE_API, 'https://api.github.com/repos/imetn/calends/releases/latest');
  assert.deepEqual(parseRelease({ tag_name: 'v1.38.0', html_url: url, draft: false, prerelease: false }), { version: '1.38.0', url });
  assert.equal(parseRelease({ tag_name: 'v1.38.0', html_url: url, prerelease: true }), null);
  assert.equal(parseRelease({ tag_name: 'v1.38.0', html_url: url, draft: true }), null);
  assert.equal(parseRelease({ tag_name: 'v1.38.0-rc.1', html_url: url }), null);
  assert.equal(parseRelease({ tag_name: 'nightly', html_url: url }), null);
  assert.equal(parseRelease({ tag_name: 'v1.38.0', html_url: 'https://evil.example/releases/x' }), null);
  assert.equal(parseRelease({ message: 'API rate limit exceeded' }), null);
  assert.equal(parseRelease(null), null);
  // 正文为空或不是字符串：不带 notes 键
  assert.deepEqual(parseRelease({ tag_name: 'v1.38.0', html_url: url, body: '' }), { version: '1.38.0', url });
  assert.deepEqual(parseRelease({ tag_name: 'v1.38.0', html_url: url, body: 42 }), { version: '1.38.0', url });
});

const BODY_145 = [
  'Calends 1.45.0 checks for updates more promptly when you return to the app or open **Settings**.',
  '',
  '## Highlights',
  '',
  '- Automatic checks now run at most hourly and resume when the page returns to the foreground.',
  '',
  '## Fixes',
  '',
  '- Fixed update status remaining “up to date” for the whole day. Fixes [#21](https://github.com/imetn/calends/issues/21).',
  '',
  '## Upgrading',
  '',
  'No new database migrations, dependency changes, or API/MCP changes.',
  '',
  '## Images',
  '',
  'Multi-architecture images for linux/amd64 and linux/arm64:',
  '',
  '```bash',
  'docker pull xizozhe/calends:1.45.0',
  '```',
  '',
  '`1.45` follows this release series; `latest` follows main.',
].join('\r\n');

test('更新内容摘录：按小节取纯文本，去掉镜像小节、代码块和链接地址', () => {
  assert.deepEqual(releaseNotes(BODY_145), [
    { kind: 'p', text: 'Calends 1.45.0 checks for updates more promptly when you return to the app or open Settings.' },
    { kind: 'h', text: 'Highlights' },
    { kind: 'li', text: 'Automatic checks now run at most hourly and resume when the page returns to the foreground.' },
    { kind: 'h', text: 'Fixes' },
    { kind: 'li', text: 'Fixed update status remaining “up to date” for the whole day. Fixes #21.' },
    { kind: 'h', text: 'Upgrading' },
    { kind: 'p', text: 'No new database migrations, dependency changes, or API/MCP changes.' },
  ]);
  const url = 'https://github.com/imetn/calends/releases/tag/v1.45.0';
  assert.deepEqual(parseRelease({ tag_name: 'v1.45.0', html_url: url, body: BODY_145 })?.notes, releaseNotes(BODY_145));
  // HTML、图片、表格、分隔线不进摘录；没有小标题时就是前几段
  assert.deepEqual(releaseNotes('<img src="x.png"> Intro ![shot](a.png)\n\n---\n\n| a | b |\n|---|---|\n\n<script>alert(1)</script>next'), [
    { kind: 'p', text: 'Intro' },
    { kind: 'p', text: 'alert(1)next' },
  ]);
  assert.deepEqual(releaseNotes(''), []);
});

test('更新内容摘录：太长时截断，升级注意事项不被挤掉', () => {
  const many = Array.from({ length: 12 }, (_, i) => `- change ${i + 1}`).join('\n');
  const body = `## Highlights\n${many}\n\n## Upgrading\n\nRun the new migration before starting.\n  `;
  const notes = releaseNotes(body, 4);
  assert.deepEqual(notes, [
    { kind: 'h', text: 'Highlights' },
    { kind: 'li', text: 'change 1' },
    { kind: 'li', text: 'change 2' },
    { kind: 'li', text: 'change 3' },
    { kind: 'h', text: 'Upgrading' },
    { kind: 'p', text: 'Run the new migration before starting.' },
  ]);
  assert.equal(releaseNotes(body).filter((n) => n.kind !== 'h').length, RELEASE_NOTES_MAX);
  // 列表续行并进上一项；单条过长截成 300 字以内
  assert.deepEqual(releaseNotes('- first line\n  continues here'), [{ kind: 'li', text: 'first line continues here' }]);
  const long = releaseNotes(`x${'y'.repeat(400)}`)[0].text;
  assert.equal(long.length, 300);
  assert.ok(long.endsWith('…'));
});

test('自动检查每台设备每小时最多一次；失败只记时间并保留上次版本', () => {
  const now = Date.UTC(2026, 10, 16, 8);
  assert.equal(autoCheckDue(null, now), true);
  assert.equal(autoCheckDue({ checkedAt: now - UPDATE_CHECK_INTERVAL + 1 }, now), false);
  assert.equal(autoCheckDue({ checkedAt: now - UPDATE_CHECK_INTERVAL }, now), true);
  // 设备时钟被往回调过：记录在未来，不能因此永远不查
  assert.equal(autoCheckDue({ checkedAt: now + 60_000 }, now), true);

  const latest = { version: '1.38.0', url: 'https://github.com/imetn/calends/releases/tag/v1.38.0' };
  const ok = nextUpdateCache(null, now, latest);
  assert.deepEqual(ok, { checkedAt: now, latest });
  const failed = nextUpdateCache(ok, now + 1000, null);
  assert.deepEqual(failed, { checkedAt: now + 1000, latest });
  assert.deepEqual(nextUpdateCache(null, now, null), { checkedAt: now, latest: undefined });
});

test('缓存读回：坏数据当作没有缓存', () => {
  const latest = { version: '1.38.0', url: 'https://github.com/imetn/calends/releases/tag/v1.38.0' };
  assert.deepEqual(parseUpdateCache(JSON.stringify({ checkedAt: 5, latest })), { checkedAt: 5, latest });
  assert.deepEqual(parseUpdateCache(JSON.stringify({ checkedAt: 5, latest: { version: 'x', url: 1 } })), { checkedAt: 5, latest: undefined });
  for (const raw of [null, '', '{', '[]', '{"checkedAt":"5"}', 'null']) assert.equal(parseUpdateCache(raw), null, String(raw));
  // 摘录随版本一起存取；形状不对时只丢摘录，版本照常
  const notes = [{ kind: 'p', text: 'Faster checks.' }];
  assert.deepEqual(parseUpdateCache(JSON.stringify({ checkedAt: 5, latest: { ...latest, notes } })), { checkedAt: 5, latest: { ...latest, notes } });
  for (const bad of [[{ kind: 'script', text: 'x' }], [{ kind: 'p', text: 1 }], [{ kind: 'p', text: 'x'.repeat(301) }], 'x', []])
    assert.deepEqual(parseUpdateCache(JSON.stringify({ checkedAt: 5, latest: { ...latest, notes: bad } })), { checkedAt: 5, latest }, JSON.stringify(bad));
});

/** 从入口出发收集静态与动态 import 到的本地源码 */
function importGraph(entry: string) {
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = resolve(dirname(file), m[1]);
      const hit = [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')].find((p) => existsSync(p) && /\.(ts|tsx)$/.test(p));
      if (hit) walk(hit);
    }
  };
  walk(entry);
  return seen;
}

test('公开页不检查更新：入口依赖里没有检查模块，也不请求 GitHub', () => {
  const root = fileURLToPath(new URL('../app/src/', import.meta.url));
  const files = importGraph(join(root, 'public/main.tsx'));
  assert.ok(files.size > 5);
  for (const f of files) {
    assert.ok(!f.endsWith('update-check.ts'), f);
    assert.ok(!readFileSync(f, 'utf8').includes('api.github.com'), f);
  }
  // 登录后的应用确实接入了自动检查
  assert.ok(importGraph(join(root, 'app.tsx')).has(join(root, 'update-check.ts')));
  assert.match(readFileSync(join(root, 'app.tsx'), 'utf8'), /autoCheckUpdate\(\)/);
});

test('issue #21：一天发多个版本时不会整天停在「已是最新」', () => {
  const now = Date.UTC(2026, 10, 19, 12, 45);
  const r = (version: string) => ({ version, url: `https://github.com/imetn/calends/releases/tag/v${version}` });
  // 10:47 升到 1.43.0 后查过一次，12:41 发了 1.44.0：一小时后的刷新或回到前台会重查
  assert.equal(UPDATE_CHECK_INTERVAL, 60 * 60 * 1000);
  assert.equal(autoCheckDue({ checkedAt: now - 2 * 60 * 60 * 1000, latest: r('1.43.0') }, now, UPDATE_CHECK_INTERVAL, '1.43.0'), true);
  // 打开设置页：结果超过 5 分钟就重查，5 分钟内不重复请求
  assert.equal(autoCheckDue({ checkedAt: now - SETTINGS_CHECK_INTERVAL, latest: r('1.43.0') }, now, SETTINGS_CHECK_INTERVAL, '1.43.0'), true);
  assert.equal(autoCheckDue({ checkedAt: now - 60_000, latest: r('1.43.0') }, now, SETTINGS_CHECK_INTERVAL, '1.43.0'), false);
  // 刚升级：缓存里的最新版比正在运行的旧，是升级前查的，按五分钟重查
  assert.equal(autoCheckDue({ checkedAt: now - SETTINGS_CHECK_INTERVAL, latest: r('1.42.0') }, now, UPDATE_CHECK_INTERVAL, '1.43.0'), true);
  // 但 GitHub 的 latest 一直落后于运行版本时不能每次都请求（未认证每 IP 每小时 60 次）
  assert.equal(autoCheckDue({ checkedAt: now - 60_000, latest: r('1.42.0') }, now, UPDATE_CHECK_INTERVAL, '1.43.0'), false);
  assert.equal(autoCheckDue({ checkedAt: now - 60_000, latest: r('1.44.0') }, now, UPDATE_CHECK_INTERVAL, '1.43.0'), false);

  const root = fileURLToPath(new URL('../app/src/', import.meta.url));
  const app = readFileSync(join(root, 'app.tsx'), 'utf8');
  assert.match(app, /if \(document\.visibilityState === 'visible'\) autoCheckUpdate\(\);/);
  assert.match(app, /document\.addEventListener\('visibilitychange', onVisible\);/);
  const settings = readFileSync(join(root, 'views/Settings.tsx'), 'utf8');
  assert.match(settings, /useEffect\(\(\) => autoCheckUpdate\(SETTINGS_CHECK_INTERVAL\), \[\]\);/);
  const check = readFileSync(join(root, 'update-check.ts'), 'utf8');
  assert.match(check, /autoCheckDue\(state\.cache, now, interval, APP_VERSION\)/);
});

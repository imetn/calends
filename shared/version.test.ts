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
});

test('自动检查每台设备每天最多一次；失败只记时间并保留上次版本', () => {
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

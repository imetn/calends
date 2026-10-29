import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MIGRATIONS } from '../worker/migrations.gen.ts';
import { sha256 } from '../worker/auth.ts';
import type { Env } from '../worker/env.ts';
import { afterSelection, beginPasskeyAutofill, isPasskeyCancellation } from '../app/src/passkey-autofill.ts';

registerHooks({
  load(url, ctx, next) {
    if (url.endsWith('.json')) return { format: 'module', source: `export default ${readFileSync(new URL(url), 'utf8')}`, shortCircuit: true };
    return next(url, ctx);
  },
});
const { default: worker } = await import('../worker/index.ts');

/** 隔离的内存 SQLite 执行真实 SQL；请求走 Worker 路由，无网络或用户数据。 */
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const m of MIGRATIONS) for (const sql of m.statements) db.exec(sql);
  db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
  for (const m of MIGRATIONS) db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(m.name);
  const prepare = (sql: string) => {
    let args: Array<string | number | null> = [];
    const stmt = {
      bind(...values: typeof args) {
        args = values;
        return stmt;
      },
      async first() {
        return db.prepare(sql).get(...args) ?? null;
      },
      async all() {
        return { results: db.prepare(sql).all(...args) };
      },
      async run() {
        return { meta: { changes: Number(db.prepare(sql).run(...args).changes) } };
      },
    };
    return stmt;
  };
  const env = {
    DB: {
      prepare,
      async batch(stmts: Array<ReturnType<typeof prepare>>) {
        return Promise.all(stmts.map((s) => s.run()));
      },
    },
  } as unknown as Env;
  const request = (path: string, body?: unknown, cookie?: string, origin = 'https://ledger.example.test') =>
    worker.fetch(
      new Request(`https://ledger.example.test${path}`, {
        method: path === '/api/auth/status' ? 'GET' : 'POST',
        headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      env,
    );
  return { db, env, request };
}

const digest = (data: string | Buffer) => createHash('sha256').update(data).digest();
const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const jwk = keyPair.publicKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([
  Buffer.from('a5010203262001215820', 'hex'),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from('225820', 'hex'),
  Buffer.from(jwk.y!, 'base64url'),
]);
const credentialId = Buffer.from('fictional-old-owner-passkey').toString('base64url');
function assertion(challenge: string, counter: number) {
  const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: 'https://ledger.example.test' }));
  const flagsAndCounter = Buffer.alloc(5);
  flagsAndCounter[0] = 1; // UP，仅保持 preferred，不强制 UV
  flagsAndCounter.writeUInt32BE(counter, 1);
  const authenticatorData = Buffer.concat([digest('ledger.example.test'), flagsAndCounter]);
  const signature = sign('sha256', Buffer.concat([authenticatorData, digest(clientDataJSON)]), keyPair.privateKey);
  return {
    id: credentialId,
    rawId: credentialId,
    type: 'public-key',
    response: {
      clientDataJSON: clientDataJSON.toString('base64url'),
      authenticatorData: authenticatorData.toString('base64url'),
      signature: signature.toString('base64url'),
    },
    clientExtensionResults: {},
  };
}

test('Worker 注册选项按当前域名命名账号，登录前不可读取设置；开发 Origin 与 rpID 一致', async () => {
  const f = fixture();
  try {
    assert.equal((await f.request('/api/auth/passkey/register/options')).status, 401);
    const cookie = 'sid=fictional-session';
    f.db.prepare('INSERT INTO sessions(token_hash, expires_at) VALUES (?, ?)').run(await sha256('fictional-session'), Date.now() + 60_000);
    for (const displayName of ['', 'Alex', '   ']) {
      f.db.prepare('INSERT OR REPLACE INTO kv(key,value) VALUES (?,?)').run('settings', JSON.stringify({ displayName }));
      const res = await f.request('/api/auth/passkey/register/options', undefined, cookie);
      assert.equal(res.status, 200);
      const { options } = await res.json();
      assert.equal(options.user.name, 'owner@ledger.example.test');
      assert.equal(options.user.displayName, `${displayName.trim() || 'Calends'} · ledger.example.test`);
      assert.equal(options.rp.id, 'ledger.example.test');
      assert.equal(options.authenticatorSelection.residentKey, 'required');
      assert.equal(options.authenticatorSelection.userVerification, 'preferred');
    }
    f.env.DEV_BYPASS_AUTH = '1';
    const { options } = await (await f.request('/api/auth/passkey/register/options', undefined, undefined, 'http://localhost:5173')).json();
    assert.equal(options.rp.id, 'localhost');
    assert.equal(options.user.name, 'owner@localhost');
    assert.equal(options.user.displayName, 'Calends · localhost');
  } finally {
    f.db.close();
  }
});

test('Worker 独立挑战可逆序使用，旧 owner 凭据仍可签名登录，挑战过期与重放有明确错误', async () => {
  const f = fixture();
  try {
    f.db.prepare('INSERT INTO passkeys(id,public_key,counter,name) VALUES (?,?,?,?)').run(credentialId, publicKey.toString('base64url'), 0, 'Old owner');
    const options = async () => {
      const res = await f.request('/api/auth/passkey/login/options');
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.options.rpId, 'ledger.example.test');
      assert.equal(data.options.userVerification, 'preferred');
      assert.equal('allowCredentials' in data.options, false);
      return data;
    };
    const a = await options();
    const b = await options();
    assert.notEqual(a.challengeId, b.challengeId);
    assert.notEqual(a.options.challenge, b.options.challenge);
    for (const [i, data] of [b, a].entries()) {
      const res = await f.request('/api/auth/passkey/login', { challengeId: data.challengeId, response: assertion(data.options.challenge, i + 1) });
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('set-cookie')?.includes('HttpOnly'));
      assert.equal((await res.json()).ok, true);
    }
    const expired = await options();
    f.db.prepare('UPDATE auth_challenges SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.challengeId);
    for (const data of [expired, a]) {
      const res = await f.request('/api/auth/passkey/login', { challengeId: data.challengeId, response: assertion(data.options.challenge, 3) });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).code, 'PASSKEY_CHALLENGE_EXPIRED');
    }
    assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM login_attempts').get()!.n, 0);
    const fresh = await options();
    assert.equal((await f.request('/api/auth/passkey/login', { challengeId: fresh.challengeId, response: assertion(fresh.options.challenge, 3) })).status, 200);
    // 账本已删掉的凭据：带 code 返回，前端据此通知密码管理器
    f.db.prepare('DELETE FROM passkeys').run();
    const orphan = await options();
    const gone = await f.request('/api/auth/passkey/login', { challengeId: orphan.challengeId, response: assertion(orphan.options.challenge, 4) });
    assert.equal(gone.status, 401);
    assert.equal((await gone.json()).code, 'PASSKEY_NOT_BOUND');
    f.env.DEV_BYPASS_AUTH = '1';
    assert.equal((await (await f.request('/api/auth/passkey/login/options', undefined, undefined, 'http://localhost:5173')).json()).options.rpId, 'localhost');
  } finally {
    f.db.close();
  }
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('取消错误覆盖原生、SimpleWebAuthn 包装和跨 realm 对象，不吞普通验证失败', () => {
  for (const e of [
    new DOMException('cancelled', 'AbortError'),
    { name: 'NotAllowedError' },
    { code: 'ERROR_CEREMONY_ABORTED' },
    new Error('wrapped', { cause: { name: 'AbortError' } }),
  ])
    assert.equal(isPasskeyCancellation(e), true);
  for (const e of [null, 'AbortError', new Error('network'), { name: 'SecurityError' }, { code: 'PASSKEY_CHALLENGE_EXPIRED' }])
    assert.equal(isPasskeyCancellation(e), false);
});

test('条件式登录先检查支持；检测中卸载不会启动请求', async () => {
  for (const supported of [false, true]) {
    let resolve!: (v: boolean) => void;
    let calls = 0;
    const stop = beginPasskeyAutofill({
      supports: () =>
        new Promise<boolean>((r) => {
          resolve = r;
        }),
      login: async () => {
        calls++;
      },
      cancel: () => {
        calls++;
      },
    });
    stop();
    resolve(supported);
    await tick();
    assert.equal(calls, 0);
  }
  let calls = 0;
  beginPasskeyAutofill({
    supports: async () => false,
    login: async () => {
      calls++;
    },
    cancel() {},
  });
  await tick();
  assert.equal(calls, 0);
});

test('条件式登录取消进行中的请求且不重启，重复清理不会中止后来的按钮请求', async () => {
  let calls = 0;
  let cancels = 0;
  let signal!: AbortSignal;
  const stop = beginPasskeyAutofill({
    supports: async () => true,
    login: (s) => {
      calls++;
      signal = s;
      return new Promise((_, reject) => s.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
    },
    cancel: () => {
      cancels++;
    },
  });
  await tick();
  stop();
  stop();
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(calls, 1);
  assert.equal(cancels, 1);
});

test('条件式登录挑战过期后获取新挑战；取消和其他错误安静停止', async () => {
  for (const error of [{ code: 'PASSKEY_CHALLENGE_EXPIRED' }, { name: 'AbortError' }, { code: 'ERROR_CEREMONY_ABORTED' }, new Error('network')]) {
    let calls = 0;
    const stop = beginPasskeyAutofill({
      supports: async () => true,
      login: async () => {
        if (++calls === 1) throw error;
      },
      cancel() {},
    });
    await tick();
    assert.equal(calls, 'code' in error && error.code === 'PASSKEY_CHALLENGE_EXPIRED' ? 2 : 1);
    stop();
  }
});

test('条件式登录选中的凭据被拒时提示原因并重新等待选择', async () => {
  const errors: unknown[] = [];
  let calls = 0;
  const stop = beginPasskeyAutofill({
    supports: async () => true,
    login: (s) => {
      if (++calls === 1) return Promise.reject(afterSelection(Object.assign(new Error('not bound'), { code: 'PASSKEY_NOT_BOUND', status: 401 })));
      return new Promise((_, reject) => s.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError'))));
    },
    cancel() {},
    onError: (e) => errors.push(e),
  });
  await tick();
  assert.equal(calls, 2);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as Error).message, 'not bound');
  stop();
  await tick();
  assert.equal(calls, 2);
});

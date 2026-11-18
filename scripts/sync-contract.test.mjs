// App 同步协议的契约测试：iOS 参考模拟器的 61 个固定用例，对 calends Worker 的同步实现（worker/sync.ts）逐个运行。
// 服务器为内存 SQLite 经 D1 适配层，客户端为参考实现（scripts/sync-contract/client.mjs）。只用虚构数据。
// 只能在参考服务器上打开的错误写法半边（SERVER_NAIVE）略过；单跑某个用例：node --experimental-strip-types --test --test-name-pattern F07 scripts/sync-contract.test.mjs
import { test } from 'node:test';
import { cases, progress, ServerNaive } from './sync-contract/cases.mjs';
import { round } from './sync-contract/sim.mjs';

for (const [name, fn] of Object.entries(cases)) {
  test(name, async (t) => {
    progress.built = 0;
    try {
      await fn();
    } catch (e) {
      if (!(e instanceof ServerNaive)) throw e;
      // 正确写法的半边已通过，只略过错误写法的半边；整个用例都依赖参考服务器的错误写法时（F22）记为跳过
      if (progress.built) t.diagnostic(`正确写法通过；服务器侧错误写法 ${e.message} 仅参考服务器可开，略过该半边`);
      else t.skip(`整个用例依赖服务器侧错误写法 ${e.message}，不适用于真实实现`);
    }
  });
}

// 随机时序：参考模拟器的故障注入（丢包、重复、乱序、崩溃、交错提交、恢复备份、物理回滚、克隆等）对真实实现跑固定种子
test('随机时序 40 轮', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const r = await round(seed, {});
    if (!r.ok) throw new Error(`种子 ${seed}：${r.kind} ${r.message.slice(0, 600)}`);
  }
});

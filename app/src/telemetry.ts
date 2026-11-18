import { telemetryPage } from '../../shared/telemetry.ts';
import { base } from './base.ts';

/**
 * 匿名使用统计（浏览器这一半）：只记打开次数和各页面的打开次数，攒在内存里，
 * 页面切到后台或每 5 分钟交给自己的服务端一次。开关、按天累计和对外发送都在服务端（worker/telemetry.ts）。
 * 本地开发不记。
 */
let counts: Record<string, number> = {};
let started = false;
let lastPage: string | undefined;

const add = (key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

function flush() {
  if (!Object.keys(counts).length) return;
  const body = JSON.stringify({ counts });
  counts = {};
  // keepalive：页面关闭时请求也能发完
  void fetch(base('/api/telemetry/counts'), {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body,
  }).catch(() => undefined);
}

export function startTelemetry() {
  if (import.meta.env.DEV || started) return;
  started = true;
  add('opens');
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  setInterval(flush, 5 * 60_000);
}

/** 进入某个页面；同一页面里的子路由切换（分类、名册）不重复计 */
export function countPage(route: string) {
  if (!started) return;
  const page = telemetryPage(route);
  if (!page || page === lastPage) return;
  lastPage = page;
  add(`page.${page}`);
}

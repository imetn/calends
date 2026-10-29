/** Isolated detail stress acceptance. node scripts/detail-shots.mjs --out /tmp/detail-shots [--cases 4,15] [--keep] */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, open } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
let out;
let selected;
let keep = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') out = args[++i];
  else if (args[i] === '--cases') selected = args[++i]?.split(',').map(Number);
  else if (args[i] === '--keep') keep = true;
  else throw new Error(`Unknown argument: ${args[i]}`);
}
assert.ok(out, 'Usage: node scripts/detail-shots.mjs --out <directory> [--cases 4,15] [--keep]');
assert.ok(
  !selected || (selected.length && selected.every((n) => Number.isInteger(n) && n >= 1 && n <= 40)),
  'Cases must be 1–40 (38 selects both amount variants)',
);
out = resolve(out);
await mkdir(out, { recursive: true });
// Refuse collisions; never reuse or kill an existing listener (including 5173/8787).
for (const port of [8790, 5180]) {
  const server = createServer();
  await new Promise((res, rej) => server.once('error', rej).listen(port, '127.0.0.1', res));
  await new Promise((res) => server.close(res));
}
const temp = await mkdtemp(join(tmpdir(), 'calends-detail-'));
const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', WRANGLER_SEND_METRICS: 'false' };
delete env.CALENDS_LOCAL;
delete env.BASE_PATH;
const children = [];
const commands = new Set();
const files = [];
function start(command, argv, log, options = {}) {
  const child = spawn(command, argv, { cwd: temp, env, stdio: ['ignore', log, log], detached: true, ...options });
  children.push(child);
  return child;
}
async function command(command, argv, options = {}) {
  const child = spawn(command, argv, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...options });
  commands.add(child);
  child.once('exit', () => commands.delete(child));
  let output = '';
  child.stdout.on('data', (b) => {
    output += b;
    if (command === 'ego-browser' && argv[0] === 'nodejs') process.stdout.write(b);
  });
  child.stderr.on('data', (b) => (output += b));
  await new Promise((res, rej) => {
    child.once('error', rej);
    child.once('exit', (code) => (code === 0 ? res() : rej(new Error(`${command}: ${output.slice(-5000)}`))));
  });
  return output;
}
async function api(path, method = 'GET', body) {
  const response = await fetch(`http://127.0.0.1:8790/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
}
async function ready(url, child) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited; inspect ${out}/*.log`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`Timed out: ${url}`);
}
let stopping;
function stop() {
  return (stopping ??= stopOnce());
}
async function stopOnce() {
  for (const child of [...children, ...commands]) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  }
  await Promise.all(
    [...children, ...commands].map((child) =>
      child.exitCode !== null
        ? undefined
        : new Promise((res) => {
            const timer = setTimeout(() => {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch {}
              res();
            }, 4000);
            child.once('exit', () => {
              clearTimeout(timer);
              res();
            });
          }),
    ),
  );
  for (const file of files) await file.close();
  await rm(temp, { recursive: true, force: true });
}
let succeeded = false;
let browserToFinish;
process.once('SIGINT', () => {
  void stop().then(() => process.exit(130));
});
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(143));
});
try {
  // Run TS in a separate Node process; no tsx, provider calls or production config.
  const fixtureJson = await command(process.execPath, [
    '--experimental-strip-types',
    '--input-type=module',
    '-e',
    `const {detailFixtures}=await import(${JSON.stringify(pathToFileURL(join(root, 'scripts/detail-fixtures.ts')).href)}); console.log(JSON.stringify(detailFixtures()));`,
  ]);
  const fixture = JSON.parse(fixtureJson);
  const uiFiles = (await command('git', ['ls-files', 'app', 'shared', 'worker'])).trim().split('\n');
  const uiHash = createHash('sha256');
  for (const file of uiFiles) {
    uiHash.update(file);
    uiHash.update(await readFile(join(root, file)));
  }
  const { exportedAt: _exportedAt, ...ledger } = fixture.backup;
  const signature = createHash('sha256').update(JSON.stringify(ledger)).update(uiHash.digest('hex')).update('capture-v1').digest('hex');
  let completed = [];
  let completedImages = [];
  try {
    const previousRun = JSON.parse(await readFile(join(out, 'run.json'), 'utf8'));
    if (previousRun.signature === signature && !previousRun.finished) {
      const previous = JSON.parse(await readFile(join(out, 'measurements.json'), 'utf8'));
      completed = previous.filter((c) => fixture.cases.some((f) => f.id === c.id && f.expected.records === c.verified.records));
      const files = new Set(completed.flatMap((c) => c.shots.map((s) => s.file)));
      completedImages = JSON.parse(await readFile(join(out, 'images.json'), 'utf8')).filter((s) => files.has(s.file));
      assert.equal(completedImages.length, files.size, 'Incomplete image checkpoint');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const runInfo = { signature, today: fixture.today, uiCommit: (await command('git', ['rev-parse', 'HEAD'])).trim(), finished: false };
  await writeFile(join(out, 'run.json'), JSON.stringify(runInfo, null, 2));
  await writeFile(join(out, 'fixtures.json'), JSON.stringify(fixture, null, 2));
  await writeFile(join(out, 'backup.json'), JSON.stringify(fixture.backup, null, 2));
  await writeFile(
    join(temp, 'wrangler.json'),
    JSON.stringify({
      name: 'calends-detail-fictional',
      main: join(root, 'worker/index.ts'),
      compatibility_date: '2026-10-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'detail-fictional',
          database_id: '00000000-0000-0000-0000-000000000000',
          migrations_dir: join(root, 'worker/migrations'),
        },
      ],
      vars: { DEV_BYPASS_AUTH: '1' },
    }),
  );
  const wrangler = join(root, 'node_modules/.bin/wrangler');
  const config = ['--config', join(temp, 'wrangler.json')];
  const persist = ['--persist-to', join(temp, 'data')];
  const migration = await command(wrangler, ['d1', 'migrations', 'apply', 'DB', '--local', ...config, ...persist], { cwd: temp });
  await writeFile(join(out, 'migration.log'), migration);
  const workerLog = await open(join(out, 'worker.log'), 'w');
  files.push(workerLog);
  const worker = start(
    wrangler,
    ['dev', ...config, '--local', '--ip', '127.0.0.1', '--port', '8790', '--inspector-port', '0', ...persist, '--show-interactive-dev-session=false'],
    workerLog.fd,
  );
  await ready('http://127.0.0.1:8790/api/auth/status', worker);
  assert.equal((await api('state')).subscriptions.length, 0, 'New database must be empty');
  const imported = await api('backup', 'POST', fixture.backup);
  assert.equal(imported.restored.subscriptions, fixture.cases.length);
  assert.deepEqual(imported.state.subscriptions.map((s) => s.id).sort(), fixture.cases.map((c) => c.id).sort());
  assert.equal((await api('fx/status')).missing.length, 0, 'Fixture FX must cover every required date');
  await api('prefs', 'PATCH', { theme: 'light', 'list-view': 'grid' });
  // Separate optimizer cache avoids touching another running Vite's shared node_modules/.vite.
  const viteLog = await open(join(out, 'vite.log'), 'w');
  files.push(viteLog);
  const vite = start(
    join(root, 'node_modules/.bin/vite'),
    ['--config', join(root, 'app/vite.config.ts'), '--host', '127.0.0.1', '--port', '5180', '--strictPort'],
    viteLog.fd,
    { cwd: root, env: { ...env, VITE_WORKER_ORIGIN: 'http://127.0.0.1:8790', VITE_CACHE_DIR: join(temp, 'vite-cache') } },
  );
  await ready('http://127.0.0.1:5180/list', vite);
  await command('ego-browser', ['skill']);
  // A caller doing several QA rounds may explicitly resume its owned space and finish it later.
  const input = {
    root,
    out,
    cases: fixture.cases.filter((c) => !selected || selected.includes(c.case)),
    space: process.env.DETAIL_SHOTS_SPACE || `calends-detail-${Date.now()}`,
    today: fixture.today,
    finish: process.env.DETAIL_SHOTS_DEFER_FINISH !== '1',
    completed,
    completedImages,
  };
  const browserFile = join(temp, 'browser.mjs');
  await writeFile(browserFile, `await (${browserRun.toString()})(${JSON.stringify(input)});`);
  console.log(`Isolated data: ${temp}\nCapturing ${input.cases.length} subscriptions at http://127.0.0.1:5180/list`);
  if (input.finish) browserToFinish = input.space;
  await command('ego-browser', ['nodejs', '-e', `await import(${JSON.stringify(pathToFileURL(browserFile).href)})`]);
  const finishedDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  assert.equal(finishedDay, fixture.today, 'Run crossed midnight; regenerate and capture again');
  const { default: sharp } = await import('sharp');
  const images = JSON.parse(await readFile(join(out, 'images.json'), 'utf8'));
  for (const spec of images) {
    const pieces = [];
    for (const tile of spec.tiles) {
      pieces.push({
        input: await sharp(await readFile(join(out, tile.path)))
          .resize(spec.width, tile.height)
          .png()
          .toBuffer(),
        left: 0,
        top: tile.top,
      });
    }
    await sharp({ create: { width: spec.width, height: spec.height, channels: 4, background: '#ffffff' } })
      .composite(pieces)
      .png()
      .toFile(join(out, spec.file));
  }
  const results = JSON.parse(await readFile(join(out, 'measurements.json'), 'utf8'));
  await writeFile(join(out, 'index.html'), overview(results, fixture));
  if (browserToFinish) {
    await command('ego-browser', ['nodejs', '-e', `const task=await taskSpace(${JSON.stringify(browserToFinish)}); await task.finish({keep:[]});`]);
    browserToFinish = undefined;
  }
  await writeFile(join(out, 'run.json'), JSON.stringify({ ...runInfo, finished: true }, null, 2));
  succeeded = true;
} finally {
  if (browserToFinish) {
    try {
      await command('ego-browser', ['nodejs', '-e', `const task=await taskSpace(${JSON.stringify(browserToFinish)}); await task.finish({keep:[]});`]);
    } catch (error) {
      console.error(`Could not close TaskSpace ${browserToFinish}: ${error.message}`);
    }
  }
  if (keep && succeeded) {
    for (const child of children) child.unref();
    for (const file of files) await file.close();
    const instructions = {
      url: 'http://127.0.0.1:5180/list',
      temp,
      pids: children.map((c) => c.pid),
      stopCommands: children.map((c) => `kill -TERM -- -${c.pid}`),
    };
    await writeFile(join(out, 'keep.json'), JSON.stringify(instructions, null, 2));
    console.log(
      `Services kept: ${instructions.url}\nTemporary data: ${temp}\nProcess groups: ${instructions.pids.join(', ')}\nStop each process group with kill -TERM -- -<pid>, then remove the temporary directory.`,
    );
  } else await stop();
}

function overview(results, fixture) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const summary = (r) => r.shots.find((s) => s.kind === 'zh-desktop').measurement;
  const ranked = [...results].sort((a, b) => summary(b).blankRatio - summary(a).blankRatio);
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>详情压力验收</title><style>
  body{font:14px/1.6 system-ui;margin:24px;color:#222} table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:12px;vertical-align:top}td:first-child{width:280px}img{width:150px;height:190px;object-fit:contain;object-position:top;background:#eee} .shots{display:flex;gap:8px;flex-wrap:wrap}figure{margin:0}a{color:#1856a0}code{white-space:pre-wrap}li{margin:4px}</style>
  <h1>订阅详情压力验收 · ${esc(fixture.today)}</h1><p>仅虚构数据。完整长图保留默认折叠状态；expanded 图额外展开全部扣款与历程。固定头部仅拼接一次，原始切片保存在 tiles/。异常为候选信号，需结合图片判断；自定义滚动条或 overlay 滚动条无法从 DOM 保证视觉可见。</p>
  <p><a href="measurements.json">全部测量 JSON</a> · <a href="backup.json">可导入备份</a> · <a href="fixtures.json">用例清单</a> · <a href="problems.md">人工问题清单</a></p>
  <h2>桌面空白比例排序</h2><ol>${ranked.map((r) => `<li><a href="#${esc(r.id)}">${esc(r.name)}</a> ${(summary(r).blankRatio * 100).toFixed(1)}% · 高度差 ${summary(r).heightDifference}px</li>`).join('')}</ol>
  <table><thead><tr><th>用例 / 说明 / 测量摘要</th><th>截图（点击原图）</th></tr></thead><tbody>${results
    .map((r) => {
      const m = summary(r);
      return `<tr id="${esc(r.id)}"><td><b>${r.case} · ${esc(r.name)}</b><p>${esc(r.description)}</p><p>高度差 ${m.heightDifference}px · 空白 ${(m.blankRatio * 100).toFixed(1)}%<br>横向溢出 ${m.horizontalOverflow.length} · 截断候选 ${m.truncated.length} · 滚动容器 ${m.scrollContainers.length}<br>${r.case === 11 && m.text.includes('¥0') ? '<b>异常：缺失汇率显示为零</b><br>' : ''}全历史 ${r.verified.records}/${r.expected.records} · 阶段 ${r.expected.phases} · 成员 ${r.expected.members}</p><a href="${esc(r.id)}.json">此例JSON（各截图测量、文本与卡片）</a></td><td><div class="shots">${r.shots.map((s) => `<figure><a href="${esc(s.file)}"><img loading="lazy" src="${esc(s.file)}" alt="${esc(s.kind)}"></a><figcaption>${esc(s.kind)}</figcaption></figure>`).join('')}</div></td></tr>`;
    })
    .join('')}</tbody></table><h2>构造限制</h2><ul>${fixture.limitations.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></html>`;
}

// Executed only by `ego-browser nodejs`. Uses its documented Page/CDP interfaces.
async function browserRun(input) {
  const fs = await import('node:fs/promises');
  const imageSpecs = [...input.completedImages];
  const task = await taskSpace(input.space);
  console.log({ spaceId: task.spaceId });
  const page = task.page('p1');
  const results = [...input.completed];
  await fs.mkdir(`${input.out}/tiles`, { recursive: true });
  let browserZoom;
  async function resize(width, height) {
    if (browserZoom === undefined) {
      await page.cdp('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      browserZoom = await page.evaluate(() => devicePixelRatio);
    }
    await page.cdp('Emulation.setDeviceMetricsOverride', {
      width: Math.round(width * browserZoom),
      height: Math.round(height * browserZoom),
      deviceScaleFactor: 1 / browserZoom,
      mobile: false,
    });
    return browserZoom;
  }
  async function settle() {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all([...document.querySelectorAll('.sheet img')].map((img) => img.decode().catch(() => {})));
      const finite = document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity);
      await Promise.race([Promise.all(finite.map((a) => a.finished.catch(() => {}))), new Promise((res) => setTimeout(res, 2000))]);
      let previous = '';
      let stable = 0;
      for (let i = 0; i < 40 && stable < 3; i++) {
        await new Promise((res) => requestAnimationFrame(res));
        const geometry = [...document.querySelectorAll('.sheet,.dt,.cc,.dt-panel')]
          .map((e) => {
            const r = e.getBoundingClientRect();
            return [r.x, r.y, r.width, r.height].map(Math.round).join(',');
          })
          .join(';');
        stable = geometry === previous ? stable + 1 : 0;
        previous = geometry;
      }
    });
  }
  let zoom = 1;
  let openedCase;
  let openedLanguage;
  async function openCase(c, language, width, height) {
    zoom = await resize(width, height);
    if (openedCase === c.id && openedLanguage === language) {
      await page.evaluate(() => {
        document.querySelector('.sheet').scrollTop = 0;
        ((s) => {
          const b = s.querySelector('.sheet-body');
          return b && b.scrollHeight > b.clientHeight + 1 ? b : s;
        })(document.querySelector('.sheet:has(.dt)') ?? document.querySelector('.sheet')).scrollTop = 0;
      });
      await settle();
      return;
    }
    const r = await fetch('http://127.0.0.1:8790/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language }),
    });
    if (!r.ok) throw new Error('Temporary locale change failed');
    const proxy = c.case === 37;
    await page.goto(`http://127.0.0.1:5180/${proxy ? 'behalf' : 'list'}`);
    await page.waitForFunction(
      ({ language, proxy }) =>
        document.documentElement.lang === language &&
        JSON.parse(localStorage.getItem('ledger:state:v1') || '{}').settings?.language === language &&
        (proxy
          ? !!document.querySelector('.proxy-card .name-link')
          : document.querySelector('input[type="search"]')?.getAttribute('placeholder') === (language === 'en' ? 'Search' : '搜索订阅')),
      { language, proxy },
    );
    await settle();
    // Proxies intentionally do not appear in /list; their name link opens the same Detail view.
    if (proxy) await page.click('.proxy-card .name-link');
    else {
      await page.fill('input[type="search"]', c.name);
      await page.waitForFunction((name) => [...document.querySelectorAll('button.scard')].some((e) => e.textContent.includes(name)), c.name);
      await page.click('button.scard');
    }
    await page.waitForSelector('.sheet .dt');
    await settle();
    openedCase = c.id;
    openedLanguage = language;
    await page.evaluate(() => {
      ((s) => {
        const b = s.querySelector('.sheet-body');
        return b && b.scrollHeight > b.clientHeight + 1 ? b : s;
      })(document.querySelector('.sheet:has(.dt)') ?? document.querySelector('.sheet')).scrollTop = 0;
    });
  }
  async function measure() {
    return page.evaluate(() => {
      const sheet = document.querySelector('.sheet:has(.dt)');
      const body = ((b) => (b && b.scrollHeight > b.clientHeight + 1 ? b : sheet))(sheet.querySelector('.sheet-body'));
      const rect = (e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      };
      const label = (e) => `${e.tagName.toLowerCase()}${e.className && typeof e.className === 'string' ? '.' + e.className.trim().replace(/\s+/g, '.') : ''}`;
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden';
      };
      const columns = {};
      const cards = [];
      // 旧版两栏：主栏与侧栏各自堆叠，较短一栏下方整列留白
      const legacy = sheet.querySelector('.dt-main') && sheet.querySelector('.dt-side');
      const gaps = [];
      if (legacy) {
        for (const name of ['main', 'side']) {
          const col = sheet.querySelector(`.dt-${name}`);
          const kids = [...col.children].filter(visible);
          const bounds = kids.map(rect);
          const contentHeight = bounds.length ? Math.max(...bounds.map((b) => b.y + b.height)) - Math.min(...bounds.map((b) => b.y)) : 0;
          columns[name] = { ...rect(col), contentHeight: Math.round(contentHeight), display: getComputedStyle(col).display };
          for (const e of kids) cards.push({ column: name, title: e.querySelector('.card-title,.dt-ph,h3')?.textContent?.trim() || label(e), ...rect(e) });
        }
        if (getComputedStyle(sheet.querySelector('.dt-body')).display === 'grid') {
          const [m, sd] = [columns.main, columns.side];
          const short = m.contentHeight < sd.contentHeight ? m : sd;
          gaps.push({ row: 'columns', difference: Math.abs(m.contentHeight - sd.contentHeight), width: short.width });
        }
      } else {
        // 网格里同一视觉行（顶边相同）的卡片按各自自然高度比较，差值就是行内留白（拉伸后表现为卡片内部空白）
        for (const grid of sheet.querySelectorAll('.dt-grid')) {
          const kids = [...grid.children].filter(visible);
          for (const e of kids) cards.push({ column: 'grid', title: e.querySelector('.card-title,.dt-ph,h3')?.textContent?.trim() || label(e), ...rect(e) });
          const rows = new Map();
          for (const e of kids) {
            const top = Math.round(e.getBoundingClientRect().top);
            rows.set(top, [...(rows.get(top) ?? []), e]);
          }
          for (const [top, row] of rows) {
            if (row.length < 2) continue;
            const prev = row.map((e) => e.style.alignSelf);
            row.forEach((e) => (e.style.alignSelf = 'start'));
            const hs = row.map((e) => ({ h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width }));
            row.forEach((e, i) => (e.style.alignSelf = prev[i]));
            const hi = Math.max(...hs.map((x) => x.h));
            gaps.push({ row: `grid@${top}`, difference: hi - Math.min(...hs.map((x) => x.h)), width: 0, area: hs.reduce((a, x) => a + (hi - x.h) * x.w, 0) });
          }
        }
      }
      const horizontalOverflow = [];
      const scrollContainers = [];
      const truncated = [];
      for (const e of [sheet, ...sheet.querySelectorAll('*')]) {
        if (!(e instanceof HTMLElement) || !visible(e)) continue;
        const cs = getComputedStyle(e);
        const dx = e.scrollWidth - e.clientWidth;
        const dy = e.scrollHeight - e.clientHeight;
        const info = { element: label(e), text: e.textContent?.trim().slice(0, 140), ...rect(e), scrollWidth: e.scrollWidth, clientWidth: e.clientWidth };
        if (dx > 1) horizontalOverflow.push({ ...info, overflowX: cs.overflowX });
        if ((dx > 1 && /auto|scroll/.test(cs.overflowX)) || (dy > 1 && /auto|scroll/.test(cs.overflowY)))
          scrollContainers.push({
            ...info,
            scrollHeight: e.scrollHeight,
            clientHeight: e.clientHeight,
            scrollbarGutter: Math.max(0, e.offsetWidth - e.clientWidth - parseFloat(cs.borderLeftWidth) - parseFloat(cs.borderRightWidth)),
            scrollbarMode: cs.scrollbarWidth,
            potentiallyVisible: cs.scrollbarWidth !== 'none',
          });
        const textNodes = [...e.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim());
        if (!textNodes.length) continue;
        let clipped = false;
        for (const n of textNodes) {
          const range = document.createRange();
          range.selectNodeContents(n);
          const textRects = [...range.getClientRects()];
          for (let ancestor = e; ancestor && ancestor !== body; ancestor = ancestor.parentElement) {
            const style = getComputedStyle(ancestor);
            const a = ancestor.getBoundingClientRect();
            if (
              textRects.some(
                (r) =>
                  (/hidden|clip/.test(style.overflowX) && (r.left < a.left - 1 || r.right > a.right + 1)) ||
                  (/hidden|clip/.test(style.overflowY) && (r.top < a.top - 1 || r.bottom > a.bottom + 1)),
              )
            )
              clipped = true;
          }
        }
        if (clipped || (dx > 1 && cs.textOverflow === 'ellipsis'))
          truncated.push({ ...info, reason: cs.textOverflow === 'ellipsis' ? 'ellipsis' : 'clipped-text-range' });
      }
      const metrics = [...sheet.querySelectorAll('.metric')].map((e) => {
        let area = 0;
        const walker = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (!n.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          for (const r of range.getClientRects()) area += r.width * r.height;
        }
        const r = rect(e);
        return { text: e.textContent.trim(), ...r, textAreaRatio: Math.min(1, area / (r.width * r.height)) };
      });
      const twoColumns = gaps.length > 0;
      const difference = Math.max(0, ...gaps.map((g) => g.difference));
      const blankArea = gaps.reduce((a, g) => a + (g.area ?? g.difference * g.width), 0);
      const dialog = rect(sheet);
      const fullHeight = dialog.height + body.scrollHeight - body.clientHeight;
      return {
        dialog,
        fullHeight,
        columns,
        twoColumns,
        heightDifference: Math.round(difference),
        blankRatio: blankArea / (dialog.width * fullHeight),
        blankArea,
        rowGaps: gaps,
        blankRatioDenominator: 'dialog.width × full stitched dialog height',
        horizontalOverflow,
        scrollContainers,
        scrollbarVisibility: {
          reservedGutter: scrollContainers.some((s) => s.potentiallyVisible && s.scrollbarGutter > 0),
          overlayCandidates: scrollContainers.filter((s) => s.potentiallyVisible && s.scrollbarGutter === 0).length,
          note: 'Overlay scrollbar paint requires visual review',
        },
        truncated,
        cards,
        metricCount: metrics.length,
        metrics,
        historyRows: sheet.querySelectorAll('.dt-charges .dt-row').length,
        eventRows: sheet.querySelectorAll('.dt-ev').length,
        phaseLabel: sheet.querySelector('.dt-events .dt-aside')?.textContent || null,
        images: [...sheet.querySelectorAll('img')].map((e) => ({ src: e.getAttribute('src'), loaded: e.complete && e.naturalWidth > 0 })),
        text: sheet.innerText,
      };
    });
  }
  async function screenshot(path, clip) {
    // CDP clip 的单位随浏览器缩放与设备像素比变化：先截一张整屏，按截图宽度与视口宽度之比换算
    const probe = await page.cdp('Page.captureScreenshot', { format: 'png' }, { timeout: 60000 });
    const ratio = Buffer.from(probe.data, 'base64').readUInt32BE(16) / (await page.evaluate(() => innerWidth));
    const result = await page.cdp(
      'Page.captureScreenshot',
      {
        format: 'png',
        captureBeyondViewport: true,
        clip: { x: clip.x * ratio, y: clip.y * ratio, width: clip.width * ratio, height: clip.height * ratio, scale: 1 / ratio },
      },
      { timeout: 60000 },
    );
    await fs.writeFile(path, Buffer.from(result.data, 'base64'));
  }
  async function capture(file, full) {
    // Sheets scroll at the sheet itself. Grow the viewport until their natural content fits,
    // preserving the real layout rather than changing overflow CSS or stitching scrolled tiles.
    if (full) {
      // 桌面弹窗高度上限是 920px：完整长图临时去掉上限，首屏图仍是真实高度
      await page.evaluate(() => {
        if (innerWidth < 641 || document.getElementById('detail-shot-full')) return;
        const st = document.createElement('style');
        st.id = 'detail-shot-full';
        st.textContent = '.sheet:has(.dt){max-height:none!important}';
        document.head.append(st);
      });
      for (let i = 0; i < 8; i++) {
        const size = await page.evaluate(() => {
          const sheet = document.querySelector('.sheet:has(.dt)');
          return { width: innerWidth, height: innerHeight, excess: sheet.scrollHeight - sheet.clientHeight };
        });
        if (size.excess <= 1) break;
        zoom = await resize(size.width, Math.ceil(size.height + size.excess + 100));
        await settle();
        if (i === 7) throw new Error('Narrow dialog still scrolls after growing viewport');
      }
    }
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await page.evaluate(() => {
      ((s) => {
        const b = s.querySelector('.sheet-body');
        return b && b.scrollHeight > b.clientHeight + 1 ? b : s;
      })(document.querySelector('.sheet:has(.dt)') ?? document.querySelector('.sheet')).scrollTop = 0;
    });
    await settle();
    const geometry = () =>
      page.evaluate(() => {
        const sheet = document.querySelector('.sheet:has(.dt)');
        const body = ((b) => (b && b.scrollHeight > b.clientHeight + 1 ? b : sheet))(sheet.querySelector('.sheet-body'));
        const head = sheet.querySelector('.dt-head');
        const r = sheet.getBoundingClientRect();
        const b = body.getBoundingClientRect();
        return {
          x: Math.ceil(r.x),
          y: Math.ceil(r.y),
          width: Math.floor(r.width),
          height: Math.floor(r.height),
          bodyTop: Math.ceil(b.y),
          bodyBottom: Math.floor(b.bottom),
          sticky: Math.ceil(head.getBoundingClientRect().height),
          scroll: body.scrollTop,
          max: body.scrollHeight - body.clientHeight,
        };
      });
    let g = await geometry();
    const measurement = await measure();
    if (!full || g.max <= 1) {
      const tile = `tiles/${file.replace('.png', '')}-0.png`;
      await screenshot(`${input.out}/${tile}`, { x: g.x, y: g.y, width: g.width, height: g.height });
      imageSpecs.push({ file, width: g.width, height: g.height, tiles: [{ path: tile, top: 0, height: g.height }] });
      await page.evaluate(() => document.getElementById('detail-shot-full')?.remove());
      return { viewport, measurement, stitching: { tiles: 1 } };
    }
    const pieces = [];
    let total = 0;
    let index = 0;
    let previous = 0;
    while (true) {
      const first = index === 0;
      const top = first ? g.y : g.bodyBottom - Math.round(g.scroll - previous);
      const height = g.bodyBottom - top;
      if (height <= 0) throw new Error('Invalid stitch geometry');
      const tile = `tiles/${file.replace('.png', '')}-${index}.png`;
      await screenshot(`${input.out}/${tile}`, { x: g.x, y: top, width: g.width, height });
      pieces.push({ path: tile, top: total, height });
      total += height;
      if (g.scroll >= g.max - 1) break;
      previous = g.scroll;
      await page.evaluate(
        (step) => {
          ((s) => {
            const b = s.querySelector('.sheet-body');
            return b && b.scrollHeight > b.clientHeight + 1 ? b : s;
          })(document.querySelector('.sheet:has(.dt)') ?? document.querySelector('.sheet')).scrollTop += step;
        },
        Math.max(1, g.bodyBottom - g.bodyTop - g.sticky - 4),
      );
      await settle();
      g = await geometry();
      if (g.scroll <= previous) throw new Error('Dialog did not scroll');
      if (++index > 150) throw new Error('Stitch limit exceeded');
    }
    // Preserve fixed outer footer/border if any, once after the final body slice.
    const tail = g.y + g.height - g.bodyBottom;
    if (tail > 0) {
      const path = `${input.out}/tiles/${file.replace('.png', '')}-tail.png`;
      await screenshot(path, { x: g.x, y: g.bodyBottom, width: g.width, height: tail });
      pieces.push({ path: path.slice(input.out.length + 1), top: total, height: tail });
      total += tail;
    }
    imageSpecs.push({ file, width: g.width, height: total, tiles: pieces });
    await page.evaluate(() => {
      ((s) => {
        const b = s.querySelector('.sheet-body');
        return b && b.scrollHeight > b.clientHeight + 1 ? b : s;
      })(document.querySelector('.sheet:has(.dt)') ?? document.querySelector('.sheet')).scrollTop = 0;
    });
    return {
      viewport,
      measurement,
      stitching: { tiles: pieces.length, width: g.width, height: total, stickyHeader: 'first tile only', layoutOverrides: false },
    };
  }
  for (const c of input.cases) {
    if (results.some((r) => r.id === c.id)) {
      console.log(`${c.id}: resumed completed capture`);
      continue;
    }
    const imageStart = imageSpecs.length;
    const resultStart = results.length;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = { ...c, shots: [], verified: {} };
        for (const [kind, language, width, height, full] of [
          ['zh-desktop', 'zh-CN', 1440, 1800, true],
          ['zh-first', 'zh-CN', 1440, 900, false],
          ['zh-narrow', 'zh-CN', 390, 1800, true],
          ...([23, 34, 35, 39].includes(c.case) ? [['en-desktop', 'en', 1440, 1800, true]] : []),
        ]) {
          await openCase(c, language, width, height);
          const file = `${c.id}-${kind}.png`;
          r.shots.push({ kind, file, viewport: { width, height }, ...(await capture(file, full)) });
        }
        // Extra expanded capture proves counts and exposes long histories without altering initial-state images.
        await openCase(c, 'zh-CN', 1440, 1800);
        // 多年记录按年折叠：先点表头「全部展开」
        const collapsedYears = await page.evaluate(() => !!document.querySelector('.dt-charges .ld-toggle[aria-expanded="false"]'));
        if (collapsedYears) {
          await page.click('.dt-charges .ld-toggle[aria-expanded="false"]');
          await settle();
        }
        const moreHistory = collapsedYears || (await page.evaluate(() => !!document.querySelector('.dt-charges .dt-tfoot button')));
        if (await page.evaluate(() => !!document.querySelector('.dt-charges .dt-tfoot button'))) {
          await page.click('.dt-charges .dt-tfoot button');
          await settle();
        }
        const moreEvents = await page.evaluate(() => !!document.querySelector('.dt-events .dt-link'));
        if (moreEvents) {
          await page.click('.dt-events .dt-link');
          await settle();
        }
        const expanded = await measure();
        r.verified = { records: expanded.historyRows, eventRows: expanded.eventRows, phaseLabel: expanded.phaseLabel, text: expanded.text };
        // 历程不足三条时详情不单独成卡，此时没有段数标签可核对
        if (c.expected.phases > 1 && expanded.phaseLabel && Number(expanded.phaseLabel?.match(/\d+/)?.[0]) !== c.expected.phases)
          throw new Error(`${c.id}: phase label mismatch`);
        if (expanded.historyRows !== c.expected.records)
          throw new Error(`${c.id}: visible expanded records ${expanded.historyRows} != expected ${c.expected.records}`);
        if (moreHistory || moreEvents) {
          const kind = 'zh-expanded';
          const file = `${c.id}-${kind}.png`;
          r.shots.push({ kind, file, viewport: { width: 1440, height: 1800 }, ...(await capture(file, true)) });
        }
        await fs.writeFile(`${input.out}/${c.id}.json`, JSON.stringify(r, null, 2));
        results.push(r);
        await fs.writeFile(`${input.out}/measurements.json`, JSON.stringify(results, null, 2));
        await fs.writeFile(`${input.out}/images.json`, JSON.stringify(imageSpecs, null, 2));
        console.log(`${c.id}: ${r.verified.records} records, ${r.shots.length} shots`);
        break;
      } catch (error) {
        imageSpecs.length = imageStart;
        results.length = resultStart;
        if (attempt || !/target navigated|CDP request timed out|element is not connected/i.test(error.message)) throw error;
        const state = await page.info();
        console.log(`${c.id}: retry after transient navigation/capture failure (${state.url || 'owned page'})`);
        openedCase = undefined;
        openedLanguage = undefined;
      }
    }
  }
  await fs.writeFile(`${input.out}/images.json`, JSON.stringify(imageSpecs, null, 2));
}

// MCP Apps（io.modelcontextprotocol/ui，SEP-1865）：为外部支持 MCP Apps 的宿主（Claude、ChatGPT 等）
// 提供自包含、零外链依赖的交互式 HTML 组件，直接复用 tools/call 结果与 hostContext 主题变量。
export const MCP_APP_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_MIME = 'text/html;profile=mcp-app';
export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

export const MCP_APP_URIS = {
  fileViewer: 'ui://calends/file-viewer.html',
  spendingDashboard: 'ui://calends/spending-dashboard.html',
  subscriptionCard: 'ui://calends/subscription-card.html',
  carpoolCard: 'ui://calends/carpool-card.html',
} as const;

/** 工具名 → 对应的 MCP App 资源 URI；不支持 MCP Apps 的宿主会自动忽略 _meta.ui */
export const MCP_APP_TOOL_URIS: Record<string, string> = {
  list_files: MCP_APP_URIS.fileViewer,
  get_file: MCP_APP_URIS.fileViewer,
  get_overview: MCP_APP_URIS.spendingDashboard,
  spending_stats: MCP_APP_URIS.spendingDashboard,
  get_insights: MCP_APP_URIS.spendingDashboard,
  list_subscriptions: MCP_APP_URIS.subscriptionCard,
  get_subscription: MCP_APP_URIS.subscriptionCard,
  get_carpool: MCP_APP_URIS.carpoolCard,
};

export interface McpAppResourceMeta {
  uri: string;
  name: string;
  title: string;
  description: string;
  mimeType: typeof MCP_APP_MIME;
  _meta: {
    ui: {
      prefersBorder: boolean;
      csp: {
        connectDomains: string[];
        resourceDomains: string[];
      };
    };
  };
}

interface McpAppDef {
  uri: string;
  name: string;
  title: string;
  description: string;
  body: string;
  script: string;
}

const BASE_CSS = `
:root {
  color-scheme: light dark;
  --bg: var(--color-background-primary, #ffffff);
  --surface: var(--color-background-secondary, #f5f5f7);
  --surface-2: var(--color-background-tertiary, #eceef2);
  --fg: var(--color-text-primary, #111318);
  --muted: var(--color-text-secondary, #5f6672);
  --subtle: var(--color-text-tertiary, #8c93a0);
  --line: var(--color-border-primary, rgba(17, 19, 24, 0.1));
  --accent: var(--color-text-info, #2563eb);
  --ok: var(--color-text-success, #16a34a);
  --warn: var(--color-text-warning, #d97706);
  --bad: var(--color-text-danger, #dc2626);
  --radius: var(--border-radius-md, 12px);
  --radius-sm: var(--border-radius-sm, 8px);
  --font: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif);
  --mono: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: var(--color-background-primary, #14161a);
    --surface: var(--color-background-secondary, #1d2026);
    --surface-2: var(--color-background-tertiary, #262a33);
    --fg: var(--color-text-primary, #f2f4f8);
    --muted: var(--color-text-secondary, #a2aab8);
    --subtle: var(--color-text-tertiary, #737b8a);
    --line: var(--color-border-primary, rgba(255, 255, 255, 0.12));
    --accent: var(--color-text-info, #60a5fa);
    --ok: var(--color-text-success, #4ade80);
    --warn: var(--color-text-warning, #fbbf24);
    --bad: var(--color-text-danger, #f87171);
  }
}
:root[data-theme="dark"] {
  --bg: var(--color-background-primary, #14161a);
  --surface: var(--color-background-secondary, #1d2026);
  --surface-2: var(--color-background-tertiary, #262a33);
  --fg: var(--color-text-primary, #f2f4f8);
  --muted: var(--color-text-secondary, #a2aab8);
  --subtle: var(--color-text-tertiary, #737b8a);
  --line: var(--color-border-primary, rgba(255, 255, 255, 0.12));
  --accent: var(--color-text-info, #60a5fa);
  --ok: var(--color-text-success, #4ade80);
  --warn: var(--color-text-warning, #fbbf24);
  --bad: var(--color-text-danger, #f87171);
}
* { box-sizing: border-box; }
html, body {
  margin: 0;
  padding: 0;
  background: transparent;
  color: var(--fg);
  font: 13px/1.5 var(--font);
  -webkit-font-smoothing: antialiased;
}
.app { padding: 12px; display: flex; flex-direction: column; gap: 12px; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.title { margin: 0; font-size: 15px; font-weight: 650; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
.sub { color: var(--muted); font-size: 12px; }
.pill {
  display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px;
  background: var(--surface); border: 1px solid var(--line); font-size: 11px; font-weight: 600; color: var(--muted);
}
.pill.ok { color: var(--ok); }
.pill.warn { color: var(--warn); }
.pill.bad { color: var(--bad); }
.pill.accent { color: var(--accent); }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(136px, 1fr)); gap: 8px; }
.kpi {
  padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--line);
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.kpi small { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi b { font-size: 16px; font-weight: 650; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi span { font-size: 11px; color: var(--subtle); }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.search {
  flex: 1; min-width: 150px; height: 32px; padding: 0 10px; border-radius: var(--radius-sm);
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font: inherit; outline: none;
}
.search:focus { border-color: var(--accent); }
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 12px;
  border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--surface); color: var(--fg);
  font: 500 12px/1 var(--font); cursor: pointer; white-space: nowrap; text-decoration: none;
}
.btn:hover { background: var(--surface-2); }
.btn.primary { background: var(--fg); color: var(--bg); border-color: transparent; }
.btn.active { background: var(--fg); color: var(--bg); border-color: transparent; }
.list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; background: var(--bg); }
.row {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 12px;
  border-bottom: 1px solid var(--line); text-align: left; background: transparent; color: inherit;
  border-left: 0; border-right: 0; border-top: 0; width: 100%; font: inherit;
}
.row:last-child { border-bottom: 0; }
button.row { cursor: pointer; }
button.row:hover { background: var(--surface); }
.row-main { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
.row-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-meta { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.row-right { text-align: right; font-variant-numeric: tabular-nums; flex-shrink: 0; display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.badge-ext {
  width: 34px; height: 42px; border-radius: 4px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;
  background: var(--surface); border: 1px solid var(--line); font: 700 10px/1 var(--mono); color: var(--muted);
}
.badge-ext.pdf { color: var(--bad); }
.badge-ext.img { color: var(--accent); }
.preview-box {
  border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 220px; position: relative;
}
.preview-img { max-width: 100%; max-height: 460px; object-fit: contain; display: block; cursor: zoom-in; transition: transform 160ms ease; }
.preview-img.zoomed { max-height: none; cursor: zoom-out; transform: scale(1.75); transform-origin: center top; }
.preview-scroll { width: 100%; max-height: 480px; overflow: auto; display: flex; justify-content: center; align-items: flex-start; padding: 8px; }
.preview-pdf { width: 100%; height: 480px; border: 0; background: #fff; display: block; }
.bars { display: flex; flex-direction: column; gap: 8px; }
.bar-row { display: grid; grid-template-columns: minmax(90px, 140px) 1fr auto; align-items: center; gap: 10px; font-size: 12px; }
.bar-label { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--fg); }
.bar-track { height: 8px; border-radius: 999px; background: var(--surface-2); overflow: hidden; }
.bar-fill { height: 100%; border-radius: 999px; background: var(--accent); min-width: 2px; }
.bar-val { font-variant-numeric: tabular-nums; font-weight: 600; white-space: nowrap; }
.notice {
  padding: 8px 10px; border-radius: var(--radius-sm); background: var(--surface); border: 1px solid var(--line);
  font-size: 12px; color: var(--muted);
}
.empty { padding: 28px 16px; text-align: center; color: var(--muted); font-size: 12.5px; }
.section-title { font-size: 11.5px; font-weight: 650; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin: 2px 0 0; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
`;

/** 极简零依赖的 MCP Apps postMessage JSON-RPC 2.0 桥接层，遵循 io.modelcontextprotocol/ui 规范 */
const BRIDGE_JS = `
(() => {
  let seq = 1;
  const pending = new Map();
  const listeners = new Set();

  function post(msg) {
    if (window.parent && window.parent !== window) window.parent.postMessage(msg, '*');
  }

  function request(method, params) {
    const id = seq++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      post({ jsonrpc: '2.0', id, method, params });
    });
  }

  function notify(method, params) {
    post({ jsonrpc: '2.0', method, params });
  }

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') {
      document.documentElement.setAttribute('data-theme', ctx.theme);
    }
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        if (typeof k === 'string' && k.startsWith('--') && typeof v === 'string') {
          document.documentElement.style.setProperty(k, v);
        }
      }
    }
  }

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id != null && !msg.method && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'RPC error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/resource-teardown') {
      if (msg.id != null) post({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    if (msg.method === 'ui/notifications/host-context-changed') {
      applyHostContext(msg.params);
    }
    for (const fn of listeners) {
      try { fn(msg); } catch {}
    }
  });

  function sendSize() {
    const h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    const w = Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 0);
    if (h > 0) notify('ui/notifications/size-changed', { width: w, height: h });
  }

  let sizeTimer = 0;
  function scheduleSize() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(sendSize, 32);
  }

  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(scheduleSize).observe(document.documentElement);
  }

  function extractData(result) {
    if (!result || typeof result !== 'object') return { data: null, blocks: [] };
    const blocks = Array.isArray(result.content) ? result.content : [];
    if (result.structuredContent && typeof result.structuredContent === 'object') {
      return { data: result.structuredContent, blocks, isError: !!result.isError };
    }
    const textBlock = blocks.find((b) => b && b.type === 'text' && typeof b.text === 'string');
    if (textBlock) {
      try {
        return { data: JSON.parse(textBlock.text), blocks, isError: !!result.isError };
      } catch {}
    }
    return { data: null, blocks, isError: !!result.isError };
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtMoney(amount, ccy) {
    if (amount == null || !Number.isFinite(Number(amount))) return '—';
    const n = Number(amount);
    const code = String(ccy || '').toUpperCase();
    try {
      if (code) return new Intl.NumberFormat(undefined, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(n);
    } catch {}
    return code ? n.toFixed(2) + ' ' + code : n.toFixed(2);
  }

  function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  window.CalendsMcpApp = {
    onMessage(fn) { listeners.add(fn); },
    callTool(name, args) { return request('tools/call', { name, arguments: args || {} }); },
    openLink(url) { return request('ui/open-link', { url }); },
    extractData,
    esc,
    fmtMoney,
    fmtBytes,
    scheduleSize,
    init(appName) {
      request('ui/initialize', {
        protocolVersion: '${MCP_APP_PROTOCOL_VERSION}',
        appInfo: { name: appName, version: '1.0.0' },
        appCapabilities: {},
      })
        .then((res) => {
          applyHostContext(res && res.hostContext);
          notify('ui/notifications/initialized', {});
          scheduleSize();
        })
        .catch(() => {
          notify('ui/notifications/initialized', {});
          scheduleSize();
        });
    },
  };
})();
`;

const FILE_VIEWER_SCRIPT = `
(() => {
  const app = window.CalendsMcpApp;
  const root = document.getElementById('root');
  const st = { list: null, detail: null, q: '', filter: 'all', loading: false, err: '', blobUrl: '' };

  function clearBlob() {
    if (st.blobUrl) {
      URL.revokeObjectURL(st.blobUrl);
      st.blobUrl = '';
    }
  }

  function b64ToBlob(b64, mime) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  async function openFile(id) {
    st.loading = true;
    st.err = '';
    render();
    try {
      const res = await app.callTool('get_file', { file: id });
      const parsed = app.extractData(res);
      if (parsed.isError) throw new Error((parsed.blocks[0] && parsed.blocks[0].text) || 'Failed to load file');
      st.detail = parsed;
    } catch (e) {
      st.err = e && e.message ? e.message : String(e);
    } finally {
      st.loading = false;
      render();
    }
  }

  function renderDetail() {
    clearBlob();
    const { data, blocks } = st.detail;
    const f = (data && data.file) || {};
    const imgBlock = blocks.find((b) => b && b.type === 'image' && b.data);
    const resBlock = blocks.find((b) => b && b.type === 'resource' && b.resource && b.resource.blob);
    const dlUrl = data && data.download_url;
    let previewHtml = '<div class="empty">No inline preview available.</div>';
    let blobHref = '';

    if (imgBlock) {
      const src = 'data:' + app.esc(imgBlock.mimeType || f.mime || 'image/png') + ';base64,' + imgBlock.data;
      blobHref = src;
      previewHtml = '<div class="preview-scroll"><img class="preview-img" id="zoomImg" src="' + src + '" alt="' + app.esc(f.title || f.name || 'Receipt') + '" /></div>';
    } else if (resBlock) {
      const mime = resBlock.resource.mimeType || f.mime || 'application/pdf';
      const blob = b64ToBlob(resBlock.resource.blob, mime);
      st.blobUrl = URL.createObjectURL(blob);
      blobHref = st.blobUrl;
      previewHtml = '<iframe class="preview-pdf" src="' + app.esc(st.blobUrl) + '" title="' + app.esc(f.title || f.name || 'PDF') + '"></iframe>';
    } else if (dlUrl) {
      previewHtml = '<div class="empty">File exceeds inline preview size limit (5 MB).<br/><br/><button class="btn primary" id="openDl">Open / Download File</button></div>';
    }

    const metaBits = [
      f.subscription && f.subscription.name,
      f.kind,
      f.date,
      f.type ? String(f.type).toUpperCase() : '',
      f.size ? app.fmtBytes(f.size) : '',
    ].filter(Boolean);

    root.innerHTML =
      '<div class="head">' +
        '<div>' +
          '<h1 class="title">' +
            (st.list ? '<button class="btn" id="backBtn">← Files</button>' : '') +
            '<span>' + app.esc(f.title || f.name || 'File Preview') + '</span>' +
          '</h1>' +
          '<div class="sub">' + app.esc(metaBits.join(' · ')) + '</div>' +
        '</div>' +
        '<div class="toolbar">' +
          (blobHref ? '<a class="btn" download="' + app.esc(f.name || 'file') + '" href="' + app.esc(blobHref) + '">Download</a>' : '') +
          (dlUrl ? '<button class="btn primary" id="openDlTop">Open Link</button>' : '') +
        '</div>' +
      '</div>' +
      (st.err ? '<div class="notice">' + app.esc(st.err) + '</div>' : '') +
      '<div class="preview-box">' + previewHtml + '</div>';

    const back = document.getElementById('backBtn');
    if (back) back.addEventListener('click', () => { clearBlob(); st.detail = null; st.err = ''; render(); });
    const img = document.getElementById('zoomImg');
    if (img) img.addEventListener('click', () => { img.classList.toggle('zoomed'); app.scheduleSize(); });
    const open = () => dlUrl && app.openLink(dlUrl).catch(() => {});
    const dl1 = document.getElementById('openDl');
    const dl2 = document.getElementById('openDlTop');
    if (dl1) dl1.addEventListener('click', open);
    if (dl2) dl2.addEventListener('click', open);
    app.scheduleSize();
  }

  function renderList() {
    const d = st.list || {};
    if (d.storage === false) {
      root.innerHTML = '<div class="notice">File storage is not configured on this Calends server.</div>';
      app.scheduleSize();
      return;
    }
    const all = Array.isArray(d.files) ? d.files : [];
    const q = st.q.trim().toLowerCase();
    const rows = all.filter((f) => {
      if (st.filter === 'linked' && !f.subscription) return false;
      if (st.filter === 'unlinked' && f.subscription) return false;
      if (!q) return true;
      return String(f.title || '').toLowerCase().includes(q)
        || String(f.name || '').toLowerCase().includes(q)
        || String((f.subscription && f.subscription.name) || '').toLowerCase().includes(q);
    });

    root.innerHTML =
      '<div class="head">' +
        '<h1 class="title">Files <span class="pill">' + rows.length + ' / ' + (d.total != null ? d.total : all.length) + '</span></h1>' +
        (st.loading ? '<span class="pill accent">Loading preview…</span>' : '') +
      '</div>' +
      '<div class="toolbar">' +
        '<input class="search" id="q" type="search" placeholder="Search receipts, contracts, subscriptions…" value="' + app.esc(st.q) + '" />' +
        '<button class="btn ' + (st.filter === 'all' ? 'active' : '') + '" data-f="all">All</button>' +
        '<button class="btn ' + (st.filter === 'linked' ? 'active' : '') + '" data-f="linked">Linked</button>' +
        '<button class="btn ' + (st.filter === 'unlinked' ? 'active' : '') + '" data-f="unlinked">Unlinked</button>' +
      '</div>' +
      (st.err ? '<div class="notice">' + app.esc(st.err) + '</div>' : '') +
      (rows.length
        ? '<div class="list">' + rows.map((f) => {
            const ext = String(f.type || '').toUpperCase() || 'FILE';
            const cls = ext === 'PDF' ? 'pdf' : 'img';
            const meta = [
              f.subscription ? f.subscription.name : (f.deleted_source ? 'Deleted: ' + f.deleted_source : 'Unlinked'),
              f.kind,
              f.date,
              app.fmtBytes(f.size),
            ].filter(Boolean).join(' · ');
            return (
              '<button class="row" data-id="' + app.esc(f.id) + '">' +
                '<span class="badge-ext ' + cls + '">' + app.esc(ext) + '</span>' +
                '<span class="row-main">' +
                  '<span class="row-title">' + app.esc(f.title || f.name) + '</span>' +
                  '<span class="row-meta">' + app.esc(meta) + '</span>' +
                '</span>' +
                '<span class="pill">Preview</span>' +
              '</button>'
            );
          }).join('') + '</div>'
        : '<div class="empty">No matching files.</div>');

    const input = document.getElementById('q');
    if (input) {
      input.addEventListener('input', (e) => { st.q = e.target.value; renderList(); });
    }
    root.querySelectorAll('[data-f]').forEach((b) => {
      b.addEventListener('click', () => { st.filter = b.getAttribute('data-f'); renderList(); });
    });
    root.querySelectorAll('[data-id]').forEach((b) => {
      b.addEventListener('click', () => openFile(b.getAttribute('data-id')));
    });
    app.scheduleSize();
  }

  function render() {
    if (st.detail) return renderDetail();
    if (st.list) return renderList();
    root.innerHTML = '<div class="empty">Waiting for file data…</div>';
    app.scheduleSize();
  }

  app.onMessage((msg) => {
    if (msg.method !== 'ui/notifications/tool-result') return;
    const parsed = app.extractData(msg.params);
    if (!parsed.data) return;
    if (parsed.data.file) {
      st.detail = parsed;
      st.err = '';
    } else if (Array.isArray(parsed.data.files) || parsed.data.storage === false) {
      st.list = parsed.data;
      st.detail = null;
      st.err = '';
    }
    render();
  });

  render();
  app.init('calends-file-viewer');
})();
`;

const SPENDING_DASHBOARD_SCRIPT = `
(() => {
  const app = window.CalendsMcpApp;
  const root = document.getElementById('root');
  let payload = null;

  function renderBars(rows, ccy) {
    const valid = rows.filter((r) => r && r.amount != null && Number.isFinite(Number(r.amount)));
    const max = Math.max(0.01, ...valid.map((r) => Math.abs(Number(r.amount))));
    return '<div class="bars">' + rows.map((r) => {
      const label = r.label || r.key || r.name || r.month || 'Other';
      const val = r.amount;
      const pct = val != null && Number.isFinite(Number(val)) ? Math.max(2, Math.round((Math.abs(Number(val)) / max) * 100)) : 0;
      const share = r.share_pct != null ? ' (' + r.share_pct + '%)' : '';
      return (
        '<div class="bar-row">' +
          '<span class="bar-label" title="' + app.esc(label) + '">' + app.esc(label) + '</span>' +
          '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '<span class="bar-val">' + app.esc(app.fmtMoney(val, ccy) + share) + '</span>' +
        '</div>'
      );
    }).join('') + '</div>';
  }

  function render() {
    if (!payload) {
      root.innerHTML = '<div class="empty">Waiting for spending data…</div>';
      app.scheduleSize();
      return;
    }
    const d = payload;
    const ccy = d.currency_out || d.currency || d.base_currency || '';
    const incomplete = !!d.incomplete || (Array.isArray(d.fx_missing) && d.fx_missing.length > 0);
    const kpis = [];
    let title = 'Spending Overview';
    let bars = [];
    let insights = [];

    if (d.mrr !== undefined && d.active_count !== undefined) {
      title = 'Ledger Overview';
      kpis.push({ label: 'Monthly (MRR)', value: app.fmtMoney(d.mrr, ccy), note: d.today || '' });
      kpis.push({ label: 'Yearly', value: app.fmtMoney(d.yearly, ccy) });
      kpis.push({ label: 'Active', value: String(d.active_count), note: (d.subscription_count || 0) + ' total' });
      if (d.share_recovered_mrr > 0) kpis.push({ label: 'Shared Recovered', value: app.fmtMoney(d.share_recovered_mrr, ccy) });
      if (Array.isArray(d.insights)) insights = d.insights;
    } else if (Array.isArray(d.blocks)) {
      const hl = d.blocks.find((b) => b && b.type === 'headline');
      const comp = d.blocks.find((b) => b && b.type === 'composition');
      title = hl && hl.month ? 'Month Report · ' + hl.month : 'Scope Report';
      if (hl) {
        if (hl.total !== undefined) kpis.push({ label: 'Total', value: app.fmtMoney(hl.total, ccy) });
        if (hl.paid !== undefined) kpis.push({ label: 'Paid', value: app.fmtMoney(hl.paid, ccy) });
        if (hl.upcoming !== undefined) kpis.push({ label: 'Upcoming', value: app.fmtMoney(hl.upcoming, ccy) });
        if (hl.mrr !== undefined) kpis.push({ label: 'MRR', value: app.fmtMoney(hl.mrr, ccy) });
        if (hl.annual !== undefined) kpis.push({ label: 'Annual', value: app.fmtMoney(hl.annual, ccy) });
        if (hl.active_count !== undefined) kpis.push({ label: 'Active', value: String(hl.active_count) });
      }
      if (comp && Array.isArray(comp.categories) && comp.categories.length) bars = comp.categories;
      else if (comp && Array.isArray(comp.methods) && comp.methods.length) bars = comp.methods;
    } else {
      title = d.from && d.to ? 'Spending · ' + d.from + ' – ' + d.to : 'Spending Summary';
      if (d.total !== undefined) kpis.push({ label: 'Total', value: app.fmtMoney(d.total, ccy) });
      if (d.known_total !== undefined && d.total === null) kpis.push({ label: 'Known Total', value: app.fmtMoney(d.known_total, ccy) });
      if (d.count !== undefined) kpis.push({ label: 'Charges', value: String(d.count) });
      if (Array.isArray(d.groups)) {
        bars = d.groups.map((g) => ({ label: g.label || g.key || 'Other', amount: g.total != null ? g.total : g.amount, share_pct: g.share_pct }));
      } else if (Array.isArray(d.items)) {
        bars = d.items.slice(0, 10).map((it) => ({ label: it.name || it.label || it.key, amount: it.total != null ? it.total : it.amount }));
      }
    }

    root.innerHTML =
      '<div class="head">' +
        '<h1 class="title">' + app.esc(title) + '</h1>' +
        (incomplete ? '<span class="pill warn">Incomplete FX</span>' : (ccy ? '<span class="pill">' + app.esc(ccy) + '</span>' : '')) +
      '</div>' +
      (kpis.length
        ? '<div class="kpis">' + kpis.map((k) =>
            '<div class="kpi"><small>' + app.esc(k.label) + '</small><b>' + app.esc(k.value) + '</b>' + (k.note ? '<span>' + app.esc(k.note) + '</span>' : '') + '</div>'
          ).join('') + '</div>'
        : '') +
      (bars.length ? '<div class="section-title">Breakdown</div>' + renderBars(bars.slice(0, 12), ccy) : '') +
      (insights.length
        ? '<div class="section-title">Insights</div><div class="list">' + insights.map((i) =>
            '<div class="row"><div class="row-main"><div class="row-title">' + app.esc(i.title) + '</div><div class="row-meta">' + app.esc(i.body) + '</div></div>' +
            (i.tone ? '<span class="pill ' + (i.tone === 'warn' ? 'warn' : i.tone === 'bad' ? 'bad' : '') + '">' + app.esc(i.tone) + '</span>' : '') + '</div>'
          ).join('') + '</div>'
        : '');
    app.scheduleSize();
  }

  app.onMessage((msg) => {
    if (msg.method !== 'ui/notifications/tool-result') return;
    const parsed = app.extractData(msg.params);
    if (parsed.data) {
      payload = parsed.data;
      render();
    }
  });

  render();
  app.init('calends-spending-dashboard');
})();
`;

const SUBSCRIPTION_CARD_SCRIPT = `
(() => {
  const app = window.CalendsMcpApp;
  const root = document.getElementById('root');
  const st = { list: null, detail: null, q: '', loading: false, err: '' };

  function statusTone(s) {
    if (s === 'active' || s === 'lifetime') return 'ok';
    if (s === 'trial' || s === 'ending' || s === 'paused') return 'warn';
    if (s === 'cancelled' || s === 'terminated' || s === 'ended') return 'bad';
    return '';
  }

  async function inspectSub(id) {
    st.loading = true;
    st.err = '';
    render();
    try {
      const res = await app.callTool('get_subscription', { subscription: id });
      const parsed = app.extractData(res);
      if (parsed.isError || !parsed.data) throw new Error('Failed to load subscription');
      st.detail = parsed.data;
    } catch (e) {
      st.err = e && e.message ? e.message : String(e);
    } finally {
      st.loading = false;
      render();
    }
  }

  function renderDetail() {
    const d = st.detail;
    const s = d.subscription || d;
    const priceText = s.price ? app.fmtMoney(s.price.amount, s.price.currency) + (s.cycle ? ' / ' + s.cycle : '') : '—';
    const meta = [s.category, s.region, s.method_name || s.method, s.account].filter(Boolean).join(' · ');
    const spentObj = d.spent_total || d.spent;
    const kpis = [
      { label: 'Current Plan', value: priceText },
      { label: 'Next Charge', value: s.next_charge || '—' },
      { label: 'Service Expires', value: d.expires || s.service_expires || '—' },
      { label: 'Total Spent', value: spentObj ? app.fmtMoney(spentObj.amount, spentObj.currency) : '—' },
    ];
    const files = Array.isArray(d.files) ? d.files : [];
    const charges = Array.isArray(d.charges) ? d.charges.slice(-6).reverse() : [];

    root.innerHTML =
      '<div class="head">' +
        '<div>' +
          '<h1 class="title">' +
            (st.list ? '<button class="btn" id="backBtn">← List</button>' : '') +
            '<span>' + app.esc(s.name || 'Subscription') + '</span>' +
            (s.status ? '<span class="pill ' + statusTone(s.status) + '">' + app.esc(s.status) + '</span>' : '') +
          '</h1>' +
          (meta ? '<div class="sub">' + app.esc(meta) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="kpis">' + kpis.map((k) => '<div class="kpi"><small>' + app.esc(k.label) + '</small><b>' + app.esc(k.value) + '</b></div>').join('') + '</div>' +
      (charges.length
        ? '<div class="section-title">Recent Charges</div><div class="list">' + charges.map((c) =>
            '<div class="row"><div class="row-main"><div class="row-title">' + app.esc(c.date) + (c.kind && c.kind !== 'charge' ? ' · ' + app.esc(c.kind) : '') + '</div>' +
            '<div class="row-meta">' + app.esc(c.projected ? 'Projected' : 'Recorded') + '</div></div>' +
            '<div class="row-right"><b>' + app.esc(app.fmtMoney(c.amount, c.currency)) + '</b></div></div>'
          ).join('') + '</div>'
        : '') +
      (files.length
        ? '<div class="section-title">Attached Files (' + files.length + ')</div><div class="list">' + files.map((f) =>
            '<div class="row"><span class="badge-ext ' + (String(f.type || '').toLowerCase() === 'pdf' ? 'pdf' : 'img') + '">' + app.esc(String(f.type || 'FILE').toUpperCase()) + '</span>' +
            '<div class="row-main"><div class="row-title">' + app.esc(f.title || f.name) + '</div><div class="row-meta">' + app.esc([f.kind, f.date].filter(Boolean).join(' · ')) + '</div></div></div>'
          ).join('') + '</div>'
        : '');

    const back = document.getElementById('backBtn');
    if (back) back.addEventListener('click', () => { st.detail = null; render(); });
    app.scheduleSize();
  }

  function renderList() {
    const d = st.list || {};
    const all = Array.isArray(d.subscriptions) ? d.subscriptions : [];
    const q = st.q.trim().toLowerCase();
    const rows = all.filter((s) => !q || String(s.name || '').toLowerCase().includes(q) || String(s.category || '').toLowerCase().includes(q) || String(s.account || '').toLowerCase().includes(q));

    root.innerHTML =
      '<div class="head">' +
        '<h1 class="title">Subscriptions <span class="pill">' + rows.length + '</span></h1>' +
        (st.loading ? '<span class="pill accent">Loading…</span>' : '') +
      '</div>' +
      '<div class="toolbar"><input class="search" id="q" type="search" placeholder="Filter by name, category, account…" value="' + app.esc(st.q) + '" /></div>' +
      (st.err ? '<div class="notice">' + app.esc(st.err) + '</div>' : '') +
      (rows.length
        ? '<div class="list">' + rows.map((s) => {
            const p = s.price ? app.fmtMoney(s.price.amount, s.price.currency) : '—';
            const meta = [s.category, s.cycle, s.next_charge ? 'Next ' + s.next_charge : ''].filter(Boolean).join(' · ');
            return (
              '<button class="row" data-id="' + app.esc(s.id) + '">' +
                '<span class="row-main"><span class="row-title">' + app.esc(s.name) + '</span><span class="row-meta">' + app.esc(meta) + '</span></span>' +
                '<span class="row-right"><b>' + app.esc(p) + '</b><span class="pill ' + statusTone(s.status) + '">' + app.esc(s.status || '') + '</span></span>' +
              '</button>'
            );
          }).join('') + '</div>'
        : '<div class="empty">No matching subscriptions.</div>');

    const input = document.getElementById('q');
    if (input) input.addEventListener('input', (e) => { st.q = e.target.value; renderList(); });
    root.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => inspectSub(b.getAttribute('data-id'))));
    app.scheduleSize();
  }

  function render() {
    if (st.detail) return renderDetail();
    if (st.list) return renderList();
    root.innerHTML = '<div class="empty">Waiting for subscription data…</div>';
    app.scheduleSize();
  }

  app.onMessage((msg) => {
    if (msg.method !== 'ui/notifications/tool-result') return;
    const parsed = app.extractData(msg.params);
    if (!parsed.data) return;
    if (Array.isArray(parsed.data.subscriptions)) {
      st.list = parsed.data;
      st.detail = null;
    } else if (parsed.data.subscription || parsed.data.id) {
      st.detail = parsed.data;
    }
    render();
  });

  render();
  app.init('calends-subscription-card');
})();
`;

const CARPOOL_CARD_SCRIPT = `
(() => {
  const app = window.CalendsMcpApp;
  const root = document.getElementById('root');
  let payload = null;

  function owedNum(m, preferConverted) {
    const obj = m.owed || (m.pending_amount && typeof m.pending_amount === 'object' ? m.pending_amount : null);
    if (obj) {
      if (preferConverted) return obj.converted != null ? Number(obj.converted) : null;
      return obj.amount != null ? Number(obj.amount) : 0;
    }
    return typeof m.pending_amount === 'number' ? m.pending_amount : 0;
  }

  function renderPlan(p, baseCcy) {
    const members = Array.isArray(p.members) ? p.members : [];
    const seats = p.seats && typeof p.seats === 'object'
      ? (p.seats.taken + ' / ' + p.seats.total)
      : (p.seats != null ? String(p.seats) : String(members.length));
    let owedTotal = 0;
    let owedIncomplete = false;
    for (const m of members) {
      const v = owedNum(m, true);
      if (v == null || !Number.isFinite(v)) owedIncomplete = true;
      else owedTotal += v;
    }
    const yearNet = p.year && p.year.i_earn > 0
      ? { label: 'Yearly Earn', value: app.fmtMoney(p.year.i_earn, baseCcy) }
      : { label: 'My Yearly Cost', value: app.fmtMoney(p.year ? p.year.i_pay : null, baseCcy) };
    const kpis = [
      { label: 'Seats', value: seats },
      yearNet,
      { label: 'Pending Dues', value: owedIncomplete ? '—' : app.fmtMoney(owedTotal, baseCcy) },
      { label: 'Anchor', value: p.collect_from || '—' },
    ];
    return (
      '<div class="head">' +
        '<h1 class="title">' + app.esc(p.name || 'Shared Plan') + '</h1>' +
        (p.role ? '<span class="pill">' + app.esc(p.role) + '</span>' : '') +
      '</div>' +
      '<div class="kpis">' + kpis.map((k) => '<div class="kpi"><small>' + app.esc(k.label) + '</small><b>' + app.esc(k.value) + '</b></div>').join('') + '</div>' +
      (members.length
        ? '<div class="section-title">Members (' + members.length + ')</div><div class="list">' + members.map((m) => {
            const feeAmt = m.fee && typeof m.fee === 'object' ? m.fee.amount : m.fee;
            const feeCcy = (m.fee && typeof m.fee === 'object' ? m.fee.currency : m.fee_currency) || baseCcy;
            const owed = owedNum(m, false) || 0;
            const owedCcy = (m.owed && m.owed.currency) || (m.pending_amount && m.pending_amount.currency) || feeCcy;
            const tone = m.left ? '' : owed > 0 ? 'warn' : 'ok';
            const badge = m.left ? 'Left ' + m.left : owed > 0 ? 'Owes ' + app.fmtMoney(owed, owedCcy) : 'Settled';
            const paidUntil = m.paid_until || m.paid_through;
            const meta = [
              m.exempt ? 'Exempt' : (feeAmt != null ? app.fmtMoney(feeAmt, feeCcy) : ''),
              paidUntil ? 'Paid until ' + paidUntil : '',
              m.next_collection_date ? 'Next ' + m.next_collection_date : '',
            ].filter(Boolean).join(' · ');
            return (
              '<div class="row">' +
                '<div class="row-main"><div class="row-title">' + app.esc(m.name) + '</div><div class="row-meta">' + app.esc(meta) + '</div></div>' +
                '<div class="row-right"><span class="pill ' + tone + '">' + app.esc(badge) + '</span></div>' +
              '</div>'
            );
          }).join('') + '</div>'
        : '<div class="empty">No members recorded.</div>')
    );
  }

  function render() {
    if (!payload) {
      root.innerHTML = '<div class="empty">Waiting for carpool data…</div>';
      app.scheduleSize();
      return;
    }
    const baseCcy = payload.currency || '';
    const plans = Array.isArray(payload.plans) ? payload.plans : [payload];
    if (!plans.length) {
      root.innerHTML = '<div class="empty">No shared plans found.</div>';
      app.scheduleSize();
      return;
    }
    root.innerHTML = plans.map((p) => renderPlan(p, baseCcy)).join('');
    app.scheduleSize();
  }

  app.onMessage((msg) => {
    if (msg.method !== 'ui/notifications/tool-result') return;
    const parsed = app.extractData(msg.params);
    if (parsed.data) {
      payload = parsed.data;
      render();
    }
  });

  render();
  app.init('calends-carpool-card');
})();
`;

const APPS: McpAppDef[] = [
  {
    uri: MCP_APP_URIS.fileViewer,
    name: 'calends-file-viewer',
    title: 'Calends File Viewer',
    description: 'Interactive receipt, invoice, and contract gallery and inline PDF/image previewer for list_files and get_file.',
    body: '<main class="app" id="root"></main>',
    script: FILE_VIEWER_SCRIPT,
  },
  {
    uri: MCP_APP_URIS.spendingDashboard,
    name: 'calends-spending-dashboard',
    title: 'Calends Spending Dashboard',
    description: 'Interactive KPI summary, category/method breakdown chart, and insights view for get_overview, spending_stats, and get_insights.',
    body: '<main class="app" id="root"></main>',
    script: SPENDING_DASHBOARD_SCRIPT,
  },
  {
    uri: MCP_APP_URIS.subscriptionCard,
    name: 'calends-subscription-card',
    title: 'Calends Subscription Card',
    description: 'Interactive subscription list and detail viewer with renewal dates, recent charges, and linked files.',
    body: '<main class="app" id="root"></main>',
    script: SUBSCRIPTION_CARD_SCRIPT,
  },
  {
    uri: MCP_APP_URIS.carpoolCard,
    name: 'calends-carpool-card',
    title: 'Calends Carpool Card',
    description: 'Interactive shared-plan seat, paid-through, and pending-dues overview for get_carpool.',
    body: '<main class="app" id="root"></main>',
    script: CARPOOL_CARD_SCRIPT,
  },
];

function renderAppHtml(def: McpAppDef): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width,initial-scale=1" />',
    `<title>${def.title}</title>`,
    `<style>${BASE_CSS}</style>`,
    '</head>',
    '<body>',
    def.body,
    `<script>${BRIDGE_JS}</script>`,
    `<script>${def.script}</script>`,
    '</body>',
    '</html>',
  ].join('\n');
}

const APP_META = {
  ui: {
    prefersBorder: true,
    csp: {
      connectDomains: [] as string[],
      resourceDomains: [] as string[],
    },
  },
};

export function listMcpAppResources(): McpAppResourceMeta[] {
  return APPS.map((a) => ({
    uri: a.uri,
    name: a.name,
    title: a.title,
    description: a.description,
    mimeType: MCP_APP_MIME,
    _meta: APP_META,
  }));
}

export function readMcpAppResource(uri: string) {
  const def = APPS.find((a) => a.uri === uri);
  if (!def) return null;
  return {
    contents: [
      {
        uri: def.uri,
        mimeType: MCP_APP_MIME,
        text: renderAppHtml(def),
        _meta: APP_META,
      },
    ],
  };
}

export function toolUiMeta(toolName: string): { ui: { resourceUri: string } } | undefined {
  const resourceUri = MCP_APP_TOOL_URIS[toolName];
  return resourceUri ? { ui: { resourceUri } } : undefined;
}

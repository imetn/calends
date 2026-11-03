import { readUiSource } from './ui-test-source.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { parsers } from 'prettier/plugins/typescript';
import { transformSync } from 'oxc-transform-react';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { tooltipPosition } from '../app/src/components/tooltip-position.ts';

const root = new URL('../app/src/', import.meta.url);
const sources = [];
for (const file of readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.tsx') && !file.startsWith('public/'))) {
  const source = readUiSource(new URL(file, root));
  sources.push([file, await parsers.typescript.parse(source), source]);
}
const visit = (node, fn) => {
  if (!node || typeof node !== 'object') return;
  fn(node);
  for (const [key, value] of Object.entries(node)) {
    if (['loc', 'range', 'comments', 'tokens'].includes(key)) continue;
    if (Array.isArray(value)) value.forEach((child) => visit(child, fn));
    else visit(value, fn);
  }
};
const attr = (node, key) => node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === key);
const text = (node, source) => (node ? source.slice(...node.range) : '');
const functionRange = (ast, name) => {
  let range;
  visit(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && node.id?.name === name) range = node.range;
  });
  return range;
};
const inside = (node, range) => range && node.range[0] >= range[0] && node.range[1] <= range[1];

test('SIM and bank faces render identical chips with independent gradient IDs', () => {
  const [, ast, source] = sources.find(([file]) => file === 'components/PayCardFace.tsx');
  const compiled = transformSync('Wallet.tsx', ['CardFace', 'CardChip'].map((name) => source.slice(...functionRange(ast, name))).join('\n'), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(compiled.fatal, false);
  const Face = new Function(
    'React',
    'useId',
    'isSim',
    'brandOf',
    'bankOf',
    'methodLogo',
    'KIND_LABEL',
    'CARD_KINDS',
    'FlagImg',
    'methodRegion',
    'fmtPhone',
    'copyParts',
    `${compiled.code}; return CardFace;`,
  )(
    React,
    React.useId,
    (m) => m.kind === 'phone',
    () => undefined,
    () => undefined,
    () => undefined,
    { debit: 'Debit' },
    ['debit', 'credit', 'crypto'],
    () => null,
    () => 'US',
    (s) => s,
    (s) => s,
  );
  const html = renderToStaticMarkup(
    React.createElement(
      React.Fragment,
      null,
      ...['phone', 'debit', 'phone'].map((kind, i) =>
        React.createElement(Face, { key: i, m: { id: String(i), name: 'Example', kind, currency: 'USD' }, label: '', value: '0', right: '', rightSub: '' }),
      ),
    ),
  );
  const chips = html.match(/<svg class="pc-chip"[\s\S]*?<\/svg>/g) ?? [];
  assert.equal(chips.length, 3, 'every SIM and bank face must display a chip');
  const normalizeIds = (svg) => svg.replace(/id="[^"]+"/g, 'id="chip"').replace(/url\(#[^)]+\)/g, 'url(#chip)');
  assert.equal(normalizeIds(chips[0]), normalizeIds(chips[1]));
  assert.equal(normalizeIds(chips[2]), normalizeIds(chips[1]));
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'chips must not reuse another card’s gradient IDs');
});

test('compiled search hook refreshes an unchanged query when the lazy dictionary arrives', async () => {
  const { loadSearch, searchIndex, matchText } = await import('../app/src/search.ts');
  const source = readFileSync(new URL('use-search.ts', root), 'utf8').replace(/^import .*;\n/gm, '');
  const compiled = transformSync('use-search.ts', source, { lang: 'ts', reactCompiler: true });
  assert.equal(compiled.fatal, false);
  const code = compiled.code.replace(/^import .*;\n/gm, '').replace('export function', 'function');
  const memo = [];
  let ready = 0;
  let effect;
  const hook = new Function('useState', 'useEffect', '_c', 'locale', 'loadSearch', 'searchIndex', 'matchText', `${code}; return useTextSearch;`)(
    () => [
      ready,
      (update) => {
        ready = update(ready);
      },
    ],
    (callback) => {
      effect = callback;
    },
    (size) => {
      if (!memo.length) memo.push(...Array(size).fill(Symbol.for('react.memo_cache_sentinel')));
      return memo;
    },
    () => 'zh-CN',
    loadSearch,
    searchIndex,
    matchText,
  );
  const texts = ['土耳其 TR'];
  assert.equal(hook(texts)('teq', texts[0]), false);
  const cleanup = effect();
  await loadSearch('zh-CN');
  await Promise.resolve();
  assert.equal(hook(texts)('teq', texts[0]), true);
  assert.equal(hook(texts)('TR', texts[0]), true);
  cleanup();
});

test('payment method picker filters names by pinyin and keeps currency code matching', async () => {
  const { loadSearch, searchIndex, matchText } = await import('../app/src/search.ts');
  await loadSearch('zh-CN');
  const [, ast, source] = sources.find(([file]) => file === 'components/MethodPicker.tsx');
  const compiled = transformSync('MethodPicker.tsx', source.slice(...functionRange(ast, 'MethodPicker')), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  const methods = [
    { id: 'bank', name: '招商银行', kind: 'bank', currency: 'CNY' },
    { id: 'wallet', name: '土耳其钱包', kind: 'bank', currency: 'TRY' },
  ];
  let query = '';
  let cursor = 0;
  const Picker = new Function(
    'React',
    'useState',
    'useRef',
    'useTextSearch',
    't',
    'KIND_LABEL',
    'Icon',
    'MethodMark',
    'Pop',
    'touchFirst',
    `${compiled.code}; return MethodPicker;`,
  )(
    React,
    () => [cursor++ === 0 ? true : query, () => {}],
    () => ({ current: null }),
    (texts) => {
      const indexes = new Map(texts.map((text) => [text, searchIndex(text, 'zh-CN')]));
      return (key, text) => matchText(key, indexes.get(text), 'zh-CN');
    },
    (key) => key,
    { bank: '银行卡' },
    () => null,
    () => null,
    ({ children }) => React.createElement('div', null, children),
    () => false,
  );
  for (const [key, expected, excluded] of [
    ['zsyh', '招商银行', '土耳其钱包'],
    ['tuerqi', '土耳其钱包', '招商银行'],
    ['try', '土耳其钱包', '招商银行'],
  ]) {
    query = key;
    cursor = 0;
    const html = renderToStaticMarkup(React.createElement(Picker, { methods, onChange() {} }));
    const list = html.slice(html.indexOf('role="listbox"'));
    assert.ok(list.includes(expected));
    assert.ok(!list.includes(excluded));
  }
});

test('app title hints go through CardTitle so text and trigger share an alignment context', () => {
  const failures = [];
  for (const [file, ast] of sources) {
    const owner = file === 'components/ui.tsx' ? functionRange(ast, 'CardTitle') : undefined;
    visit(ast, (node) => {
      if (node.type === 'JSXOpeningElement' && node.name.name === 'Hint' && !inside(node, owner)) failures.push(file);
    });
  }
  assert.deepEqual(failures, []);
});

test('native system controls stay out of the UI', async () => {
  const types = 'date|time|datetime-local|month|week|number|range|radio|color';
  const bannedType = new RegExp(`['"](?:${types})['"]`);
  const publicFiles = readdirSync(new URL('public/', root), { recursive: true }).filter((file) => file.endsWith('.tsx'));
  const publicSources = [];
  for (const file of publicFiles) {
    const source = readFileSync(new URL(`public/${file}`, root), 'utf8');
    publicSources.push([`public/${file}`, await parsers.typescript.parse(source), source]);
  }
  const failures = [];
  for (const [file, ast, source] of [...sources, ...publicSources]) {
    visit(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;
      const name = node.name.name;
      if (['select', 'option', 'optgroup', 'datalist', 'progress', 'meter', 'dialog', 'title'].includes(name)) failures.push(`${file}: <${name}>`);
      // NumInput 等会把 type 透传给 input，所以不只查 input 标签；三元、字面量表达式也算
      const type = text(attr(node, 'type')?.value, source);
      if (bannedType.test(type)) failures.push(`${file}: ${name} type=${type}`);
    });
  }
  assert.deepEqual(failures, []);
});

test('title attributes render through the shared tip in both bundles', () => {
  for (const entry of ['app.tsx', 'public/main.tsx']) assert.match(readFileSync(new URL(entry, root), 'utf8'), /^\s*installTitleTips\(\);/m);
  const source = readFileSync(new URL('components/title-tips.ts', root), 'utf8');
  // 置空而不是摘掉：空 title 同时挡住外层元素的 title，组件之后改或删属性也都能观察到
  assert.match(source, /setAttribute\('title', ''\)/);
  assert.doesNotMatch(source, /removeAttribute\('title'\)/);
  // title 空着时读屏靠它；元素被卸载时提示也要收起
  assert.match(source, /setAttribute\('aria-description', text\)/);
  assert.match(source, /childList: true/);
});

test('stylesheets keep no selector list left dangling by a deleted rule', () => {
  // 删规则时留下逗号，选择器会并入下一条规则，语法上仍然合法
  for (const file of ['styles.css', 'components/ui.css', 'public/index.css', 'views/public-page-editor.css']) {
    assert.doesNotMatch(readFileSync(new URL(file, root), 'utf8'), /,[ \t]*\n[ \t]*(\n|\/\*)/, file);
  }
});

test('import preview never hands an unrecognized source date to the calendar', () => {
  // 月历拿到 Jan 5 2026 这类值会抛 RangeError，整页崩溃
  const [, ast, source] = sources.find(([file]) => file === 'views/ImportSheet.tsx');
  let value;
  visit(ast, (node) => {
    if (node.type === 'JSXOpeningElement' && node.name.name === 'DatePicker') value = text(attr(node, 'value')?.value, source);
  });
  assert.match(value, /validDay\(start\) \? start : undefined/);
});

test('checkboxes and disclosure markers are redrawn, never the system look', () => {
  const css = readFileSync(new URL('components/ui.css', root), 'utf8');
  assert.match(css, /input\[type='checkbox'\] \{\s*appearance: none;/);
  assert.match(css, /summary \{[^}]*list-style: none;/);
  assert.match(css, /summary::-webkit-details-marker \{\s*display: none;/);
});

test('circular icon controls use the shared primitive and cannot override its hit area inline', () => {
  const failures = [];
  for (const [file, ast, source] of sources) {
    const owner = file === 'components/ui.tsx' ? functionRange(ast, 'IconButton') : undefined;
    visit(ast, (node) => {
      if (node.type !== 'JSXOpeningElement') return;
      const tag = node.name.name;
      const classes = text(attr(node, 'className')?.value, source);
      if (
        !inside(node, owner) &&
        tag === 'button' &&
        /(?<![\w-])(?:icon-btn|sb-btn|dp-nav|tb-search-x|as-icon|as-send|as-bottom|pubs-x|cat-grip)(?![\w-])/.test(classes)
      )
        failures.push(`${file}: native ${classes}`);
      if (tag === 'IconButton' && /\b(width|height|transform|marginTop)\s*:/.test(text(attr(node, 'style'), source)))
        failures.push(`${file}: inline size/offset`);
      if (tag === 'IconButton' && !attr(node, 'aria-label')) failures.push(`${file}: missing accessible label`);
    });
  }
  assert.deepEqual(failures, []);
});

test('chart tooltip placement fits narrow viewports and flips at the top edge', () => {
  assert.deepEqual(tooltipPosition({ x: 200, top: 200, bottom: 230 }, { width: 180, height: 40 }, { width: 390, height: 844 }), { left: 110, top: 152 });
  for (const x of [0, 20, 195, 390]) {
    for (const top of [0, 15, 400, 840]) {
      const pos = tooltipPosition({ x, top, bottom: top + 32 }, { width: 320, height: 80 }, { width: 390, height: 844 });
      assert.ok(pos.left >= 8 && pos.left + 320 <= 382);
      assert.ok(pos.top >= 8 && pos.top + 80 <= 836);
    }
  }
  assert.equal(tooltipPosition({ x: 100, top: 0, bottom: 32 }, { width: 180, height: 40 }, { width: 390, height: 844 }).top, 40);
});

test('title and icon primitives preserve heading semantics, accessible names and non-submitting actions', () => {
  const [, ast, source] = sources.find(([file]) => file === 'components/ui.tsx');
  const functions = [];
  visit(ast, (node) => {
    if (node.type === 'FunctionDeclaration' && ['CardTitle', 'IconButton'].includes(node.id?.name)) functions.push(text(node, source));
  });
  const [, copyAst, copySource] = sources.find(([file]) => file === 'components/copy.tsx');
  functions.push(copySource.slice(...functionRange(copyAst, 'copyParts')));
  const result = transformSync('ui.tsx', functions.join('\n'), { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const { CardTitle, IconButton } = new Function('React', 'Hint', `${result.code}; return { CardTitle, IconButton };`)(React, 'hint');
  const title = renderToStaticMarkup(React.createElement(CardTitle, { as: 'h2', hint: 'Details' }, '每月花了多少'));
  assert.match(title, /<h2 class="ui-title /);
  assert.match(title, /<span class="ui-title-text">每月花了多少<\/span>/);
  assert.match(title, /<hint text="Details"/);
  const button = renderToStaticMarkup(React.createElement(IconButton, { 'aria-label': 'Close', className: 'accent', disabled: true }));
  assert.match(button, /type="button"/);
  assert.match(button, /aria-label="Close"/);
  assert.match(button, /class="icon-btn accent"/);
  assert.match(button, /disabled=""/);
});

// Exercise the real price editor handlers with a small hook driver; domain validation stays real.
async function priceEditorHarness() {
  const billing = await import('../shared/billing.ts');
  const phases = await import('../shared/phases.ts');
  const keyboard = await import('../app/src/keyboard.ts');
  const { t } = await import('../shared/i18n.ts');
  const [, ast, source] = sources.find(([file]) => file === 'components/ChangePanel.tsx');
  const range = functionRange(ast, 'ChangePanel');
  const result = transformSync('ChangePanel.tsx', source.slice(...range), { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const hooks = [];
  let cursor = 0;
  let valid = true;
  let confirmations = 0;
  let form = {
    id: 'fictional',
    name: 'Orbit Notes',
    category: 'tools',
    tags: [],
    currency: 'USD',
    cycle: { unit: 'month', every: 1 },
    start: '2026-01-01',
    end: '2026-12-31',
    status: 'active',
    price: 18,
    priceHistory: [
      { from: '2026-01-01', amount: 10 },
      { from: '2026-04-01', amount: 14 },
      { from: '2026-07-01', amount: 18 },
    ],
  };
  const deps = {
    ...billing,
    ...phases,
    ...keyboard,
    React,
    t,
    useState(initial) {
      const index = cursor++;
      if (!(index in hooks)) hooks[index] = initial;
      return [
        hooks[index],
        (value) => {
          hooks[index] = value;
        },
      ];
    },
    useId: () => 'point-error',
    CYCLES: [['m1', { unit: 'month', every: 1 }]],
    ConfirmButton: 'confirm-button',
    History: 'history',
    Group: 'group',
    Icon: 'icon',
    IconButton: 'icon-button',
    DatePicker: 'date-picker',
    ask: async () => {
      confirmations++;
      throw new Error('price deletion must not open ask');
    },
  };
  const Component = new Function(...Object.keys(deps), `${result.code}; return ChangePanel;`)(...Object.values(deps));
  const walk = (el) => (!el || typeof el !== 'object' ? [] : [el, ...React.Children.toArray(el.props?.children).flatMap(walk)]);
  const render = () => {
    cursor = 0;
    return Component({
      f: form,
      setF: (next) => {
        form = next;
      },
      state: { methods: [] },
      today: '2026-10-22',
      onPriceValidity: (v) => {
        valid = v;
      },
    });
  };
  const history = () => walk(render()).find((el) => el.type === 'history');
  const inline = () => history().props.priceEditor?.content;
  return {
    open: (from = '2026-07-01') => history().props.onPrice('2026-01-01', from),
    change: (type, value) =>
      type === 'date'
        ? walk(inline())
            .find((el) => el.type === 'date-picker')
            .props.onChange(value || undefined)
        : walk(inline())
            .find((el) => el.type === 'input' && el.props.inputMode === 'decimal')
            .props.onChange({ target: { value } }),
    remove: () =>
      walk(inline())
        .find((el) => el.type === 'confirm-button')
        .props.onConfirm(),
    inline,
    form: () => form,
    valid: () => valid,
    confirmations: () => confirmations,
    nodes: () => walk(inline()),
  };
}

test('inline price edits update the form immediately without an inner apply/cancel or confirmation', async () => {
  const h = await priceEditorHarness();
  h.open();
  h.change('amount', '22');
  assert.equal(h.form().priceHistory.at(-1).amount, 22);
  h.change('date', '2026-06-15');
  assert.equal(h.form().priceHistory.at(-1).from, '2026-06-15');
  h.change('amount', '0');
  assert.equal(h.form().priceHistory.at(-1).amount, 0);
  assert.equal(h.valid(), true);
  assert.equal(h.confirmations(), 0);
  assert.equal(
    h.nodes().some((el) => el.type === 'button'),
    false,
  );
  h.inline().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(h.inline(), undefined);
});

test('invalid price drafts remain visible and block completion until corrected', async () => {
  const h = await priceEditorHarness();
  h.open();
  for (const [field, value] of [
    ['date', '2025-12-31'],
    ['date', '2027-01-01'],
    ['date', '2026-04-01'],
    ['date', ''],
    ['amount', '-1'],
    ['amount', ''],
    ['amount', 'no'],
    ['amount', 'Infinity'],
  ]) {
    h.change('date', '2026-07-01');
    h.change('amount', '18');
    h.change(field, value);
    assert.equal(h.valid(), false, `${field}: ${value}`);
    assert.ok(h.nodes().some((el) => el.props?.role === 'alert'));
    h.inline().props.onBlur({ currentTarget: { contains: () => false }, relatedTarget: null });
    assert.ok(h.inline());
    h.open('2026-04-01');
    assert.equal(h.nodes().find((el) => el.type === 'date-picker').props.value, field === 'date' ? value : '2026-07-01');
    assert.equal(h.form().price, 18);
  }
  h.change('amount', '19');
  assert.equal(h.valid(), true);
  assert.equal(h.form().price, 19);
});

test('inline deletion uses the capsule confirmation and only changes the form; initial price has no delete action', async () => {
  const h = await priceEditorHarness();
  h.open();
  assert.equal(h.form().priceHistory.length, 3);
  assert.ok(h.nodes().some((el) => el.type === 'confirm-button' && el.props.hint));
  h.change('amount', 'invalid');
  await h.remove();
  assert.equal(h.form().priceHistory.length, 2);
  assert.equal(h.form().price, 14);
  assert.equal(h.valid(), true);
  assert.equal(h.inline(), undefined);
  assert.equal(h.confirmations(), 0);
  h.open('2026-01-01');
  assert.equal(
    h.nodes().some((el) => el.type === 'confirm-button'),
    false,
  );
});

test('mobile sheets fit the visible viewport so the header and close button stay on screen', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const start = css.search(/\.scrim \{\s*align-items: flex-end;/);
  assert.ok(start > 0);
  const block = css.slice(start, css.indexOf('animation: none;', start));
  // iOS 的 vh 按工具栏收起后的大视口计算；最后生效的 max-height 必须基于 dvh
  const heights = [...block.matchAll(/max-height:\s*([^;]+);/g)].map((m) => m[1]);
  assert.match(heights.at(-1) ?? '', /dvh/);
});

test('mobile carpool cards stretch to full width instead of shrinking to content', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const rule = /@media \(max-width: 860px\) \{\s*\.car-cols \{([^}]*)\}/.exec(css);
  assert.ok(rule);
  assert.match(rule[1], /align-items:\s*stretch/);
});

const cssRules = (text) => {
  const out = [];
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, '');
  let i = 0;
  for (;;) {
    const m = /([^{}]+)\{/.exec(clean.slice(i));
    if (!m) break;
    const start = i + m.index + m[0].length;
    let depth = 1;
    let j = start;
    while (depth) {
      depth += clean[j] === '{' ? 1 : clean[j] === '}' ? -1 : 0;
      j++;
    }
    out.push([m[1].trim(), clean.slice(start, j - 1)]);
    i = j;
  }
  return out;
};
const allCss = ['styles.css', 'components/ui.css'].map((f) => readFileSync(new URL(f, root), 'utf8')).join('\n');

test('viewport-height sizes also get a dvh override so iOS toolbars cannot push content off screen', () => {
  const failures = [];
  const walk = (rules, scope) => {
    for (const [sel, body] of rules) {
      if (sel.startsWith('@media')) walk(cssRules(body), sel);
      else
        for (const [, prop] of body.matchAll(/(height|max-height|margin-top):\s*[^;]*\d+vh/g))
          if (!new RegExp(`${prop}:[^;]*dvh`).test(body)) failures.push(`${scope} ${sel} ${prop}`);
    }
  };
  walk(cssRules(allCss), '');
  assert.deepEqual(failures, []);
});

test('grids aligned to start reset align-items when a breakpoint turns them into a flex column', () => {
  const base = new Map();
  const media = [];
  for (const [sel, body] of cssRules(allCss)) {
    if (sel.startsWith('@media')) for (const [s, b] of cssRules(body)) media.push([sel, s, b]);
    else if (!sel.startsWith('@')) for (const s of sel.split(',')) base.set(s.trim(), [...(base.get(s.trim()) ?? []), body]);
  }
  const failures = media.flatMap(([mq, sel, body]) =>
    /flex-direction:\s*column/.test(body) && !/align-items/.test(body)
      ? sel
          .split(',')
          .map((s) => s.trim())
          .filter((s) => (base.get(s) ?? []).some((b) => /align-items:\s*(start|flex-start)/.test(b)))
          .map((s) => `${mq} ${s}`)
      : [],
  );
  assert.deepEqual(failures, []);
});

test('timeline loss amount uses its own line box so the digits stay vertically centered', () => {
  const rule = cssRules(allCss).find(([sel]) => sel === '.gt-unused-amount');
  assert.ok(rule);
  assert.match(rule[1], /display:\s*block/);
  assert.match(rule[1], /line-height:\s*22px/);
  assert.match(rule[1], /font-size:\s*var\(--fs-1\)/);
});

test('timeline “all” range keeps start and end markers whole at both track edges without shifting the axis', () => {
  const rule = (sel) => cssRules(allCss).find(([s]) => s === sel)?.[1] ?? '';
  const px = (body, prop) => body.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+);`))?.[1].trim();
  const [, gantt, ganttSource] = sources.find(([file]) => file === 'views/Gantt.tsx');
  let marked = false;
  visit(gantt, (node) => {
    if (node.type === 'TemplateLiteral' && text(node, ganttSource).startsWith('`gt ${pannable ?'))
      marked = /'pannable' : 'whole'/.test(text(node, ganttSource));
  });
  assert.ok(marked, 'non-pannable timelines (the “all” zoom and report snapshots) carry .whole');
  const bar = Number(ganttSource.match(/const BAR = (\d+);/)?.[1]);
  const dot = parseFloat(px(rule('.gt-lifetime'), 'width'));
  const reserve = parseFloat(px(rule('.gt-track'), 'margin-right'));
  const track = rule('.gt.whole .gt-body .gt-track');
  const [top, right, bottom, left] = px(track, 'padding').split(/\s+/).map(parseFloat);
  assert.deepEqual([top, bottom], [0, 0]);
  assert.equal(px(track, 'margin'), `0 0 0 -${left}px`);
  assert.equal(px(rule('.gt.whole .gt-body .gt-pan'), 'inset'), px(track, 'padding'));
  // 裁切框向外让出的空间盖得住停用标志（直径 = 条高）与买断圆点的一半；内容框与表头同宽，刻度和网格不移位
  assert.ok(left >= bar / 2 && left >= dot / 2, `left clip margin ${left}px`);
  assert.equal(right, reserve);
});

const styleFiles = readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.css'));
const styleSources = styleFiles.map((file) => [file, readUiSource(new URL(file, root)).replace(/\/\*[\s\S]*?\*\//g, '')]);
// 钱包卡面按用户要求与 main 第一版保持一致（实体卡模拟：卡面配色、投影、倾斜反光、随卡片缩放的字号），
// 不受全站视觉规范约束；其余样式仍按规范检查。
const walletRule = (selector) => selector.split(',').every((sel) => /(?:^|\s)\.(?:paycard|pc-[\w-]+|sim-[\w-]+)(?=[.:\s]|$)|^\.wallet-grid/.test(sel.trim()));
const withoutWallet = (css) =>
  cssRules(css)
    .map(([selector, body]) => (selector.startsWith('@') ? `${selector}{${withoutWallet(body)}}` : walletRule(selector) ? '' : `${selector}{${body}}`))
    .join('\n');

test('app and public CSS use only the shared type sizes, including font shorthands', async () => {
  const failures = [];
  for (const [file, css] of styleSources.map(([f, c]) => [f, withoutWallet(c)])) {
    for (const [, value] of css.matchAll(/font-size:\s*([^;]+);/g)) {
      if (!/^(?:var\(--fs-(?:[1-4]|metric)\)|12px|14px|17px|22px|28px)(?: !important)?$/.test(value)) failures.push(`${file}: ${value}`);
    }
    for (const [, value] of css.matchAll(/(?<![\w-])font:\s*([^;]+);/g)) {
      // 唯一例外：手机「更多」圆按钮里的短名，60px 圆内放图标加名称，比最小档再小一号
      if (value === '500 11px/1.1 var(--font)' && file === 'styles.css') continue;
      if (value !== 'inherit' && !/var\(--fs-[1-4]\)/.test(value)) failures.push(`${file}: font ${value}`);
    }
  }
  for (const file of readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.tsx'))) {
    const source = readUiSource(new URL(file, root));
    visit(await parsers.typescript.parse(source), (node) => {
      if (node.type !== 'ObjectProperty' || node.key.name !== 'fontSize') return;
      if (node.value.type !== 'StringLiteral' || !/^var\(--fs-[1-4]\)$/.test(node.value.value)) failures.push(`${file}: inline fontSize`);
    });
    if (/text-\[\d+(?:\.\d+)?(?:px|rem|em)\]/.test(source)) failures.push(`${file}: arbitrary text size`);
  }
  assert.deepEqual(failures, []);
});

test('colors come from Radix with both themes and package-provided P3 support', () => {
  const tokens = readFileSync(new URL('design-tokens.css', root), 'utf8');
  const families = ['gray', 'indigo', 'red', 'green', 'orange', 'purple', 'teal', 'pink', 'iris', 'gold', 'amber', 'bronze'];
  for (const family of families) {
    for (const suffix of ['', '-dark']) {
      assert.ok(tokens.includes(`@radix-ui/colors/${family}${suffix}.css`));
      const palette = readFileSync(new URL(`../../node_modules/@radix-ui/colors/${family}${suffix}.css`, root), 'utf8');
      assert.match(palette, /color\(display-p3/);
    }
  }
  assert.match(readFileSync(new URL('theme.tsx', root), 'utf8'), /classList.toggle\('dark', resolved === 'dark'\)/);
  for (const [file, css] of styleSources.map(([f, c]) => [f, withoutWallet(c)])) assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\(/i, file);
  for (const entry of ['styles.css', 'public/index.css']) assert.match(readFileSync(new URL(entry, root), 'utf8'), /import ['"]\.\.?\/design-tokens.css/);
});

test('borders use hairlines and keyboard focus uses only the shared ring', () => {
  const failures = [];
  for (const [file, css] of styleSources.map(([f, c]) => [f, withoutWallet(c)])) {
    for (const [, value] of css.matchAll(/(?:border(?:-(?:top|right|bottom|left|inline|block|width))?|outline)(?:-width)?:\s*([^;]+);/g)) {
      if (/\d+(?:\.\d+)?px/.test(value) && value !== '0.5px') failures.push(`${file}: ${value}`);
    }
    for (const [, value] of css.matchAll(/outline:\s*([^;]+);/g)) {
      if (!['none', 'none !important', '0'].includes(value) && !value.includes('var(--focus-ring)')) failures.push(`${file}: focus ${value}`);
    }
  }
  assert.deepEqual(failures, []);
});

// Only physical wallet-card surfaces may tilt, reflect light and cast material shadows.
const physicalCardSelector = (selector) => selector.split(',').every((sel) => /^(?:\.wallet-grid\.dragging )?\.paycard(?=[.:\s]|$)/.test(sel.trim()));
const leafRules = (css) => cssRules(css).flatMap(([selector, body]) => (selector.startsWith('@') ? leafRules(body) : [[selector, body]]));

test('remaining CSS transitions use 250ms ease-out and only physical cards lift on hover', () => {
  for (const [file, css] of styleSources.map(([f, c]) => [f, withoutWallet(c)])) {
    for (const [selector, body] of leafRules(css)) {
      for (const [, value] of body.matchAll(/transition:\s*([^;]+);/g)) {
        if (value.startsWith('none')) continue;
        // The phone dock's More arc is the one choreographed motion: springs, sweeps and staggered delays.
        if (/^\.(?:dock(?:-bar|-more)?|arc(?:-scrim|-slot|-item)?)(?![\w-])/.test(selector.trim()) && !selector.includes(':hover')) continue;
        // dnd-kit owns only translate timing; card transform/shadow still use the shared transition.
        const fixed = physicalCardSelector(selector) ? value.replace(/,\s*var\(--sort-t, translate 0s\)/, '') : value;
        for (const part of fixed.split(',')) assert.match(part.trim(), /^[\w-]+ var\(--duration\) var\(--ease\)$/, `${file}: ${value}`);
      }
      if (selector.includes(':hover') && !physicalCardSelector(selector))
        assert.doesNotMatch(body, /transform:\s*(?:translateY\(-|perspective)/, `${file}: ${selector}`);
    }
  }
  const css = readFileSync(new URL('components/ui.css', root), 'utf8');
  assert.match(css, /animation: rm-pop var\(--duration\) var\(--ease\)/);
  assert.match(readFileSync(new URL('styles.css', root), 'utf8'), /\.sc-glow \{[^{}]*opacity: 0\.18/);
  const assistant = readFileSync(new URL('views/assistant.css', root), 'utf8');
  assert.match(assistant, /\.as-card \{[^{}]*box-shadow:/);
  assert.match(assistant, /\.as-card::before \{[^{}]*linear-gradient/);
});

test('custom presentation colors map to Radix without changing stored color strings', async () => {
  const colors = await import('@radix-ui/colors');
  const source = readFileSync(new URL('derive.ts', root), 'utf8');
  const ast = await parsers.typescript.parse(source);
  let rgb;
  visit(ast, (node) => {
    if (node.type === 'VariableDeclaration' && node.declarations.some((d) => d.id.name === 'rgb')) rgb = text(node, source);
  });
  const range = functionRange(ast, 'paletteColor');
  const transformed = transformSync('palette.ts', `${rgb}\n${source.slice(...range)}`, { lang: 'ts' });
  assert.equal(transformed.fatal, false);
  const swatches = Object.fromEntries(
    ['indigo', 'red', 'purple', 'green', 'orange', 'teal', 'pink', 'iris', 'gray', 'gold', 'slate', 'blue'].map((name) => [name, colors[name]]),
  );
  const paletteColor = new Function('swatches', `const { slate, gray } = swatches; ${transformed.code}; return paletteColor;`)(swatches);
  const value = '#e5484d';
  assert.match(paletteColor(value), /var\(--red-9\)/);
  assert.equal(value, '#e5484d');
  assert.equal(paletteColor('var(--c4)'), 'var(--c4)');
  assert.equal(paletteColor('var(--indigo-9)'), 'var(--indigo-9)');
  assert.equal(paletteColor(undefined, 'var(--blue-9)'), 'var(--blue-9)');
  assert.equal(paletteColor('invalid', 'var(--c1)'), 'var(--c1)');
  assert.doesNotMatch(paletteColor('#abc'), /NaN|undefined/);
  assert.match(paletteColor('linear-gradient(135deg,#c8102e,#7a0a1c)'), /linear-gradient.*var\(--red-9\)/);
  assert.match(paletteColor('linear-gradient(135deg,#1c1c22,#0a0a0d)'), /var\(--(?:gray|slate)-9\)/);
});

test('copy separates facts into elements and preserves punctuation in user names', () => {
  const [, ast, source] = sources.find(([file]) => file === 'components/copy.tsx');
  const result = transformSync('copy.tsx', source.slice(...functionRange(ast, 'copyParts')), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  const copyParts = new Function('React', `${result.code}; return copyParts;`)(React);
  const name = 'Orbit · Family';
  assert.equal(copyParts(name), name);
  const markup = renderToStaticMarkup(copyParts(`${name}\n$12/month\nNext charge Oct 28`));
  assert.match(markup, /<span class="copy-parts"><span>Orbit · Family<\/span><span>\$12\/month<\/span><span>Next charge Oct 28<\/span><\/span>/);
  assert.equal(copyParts(0), 0);
  assert.equal(copyParts(null), null);
  // Leading/trailing boundaries still need spacing when a conditional fact follows existing text, but the gap
  // stays outside the wrapping group: a wrapped 「下次 12月1日」 starts flush, never with an empty indented item.
  assert.equal(
    renderToStaticMarkup(copyParts('\nNext charge Oct 28')),
    '<span class="copy-gap" aria-hidden="true"></span><span class="copy-parts"><span>Next charge Oct 28</span></span>',
  );
  assert.equal(renderToStaticMarkup(copyParts('\n')), '<span class="copy-gap" aria-hidden="true"></span>');
  // A leading word space survives (「4 发起」 like 「0 加入」); the trailing newline still separates the next fact.
  assert.equal(
    renderToStaticMarkup(copyParts(' 发起\n')),
    ' <span class="copy-parts"><span>发起</span></span><span class="copy-gap" aria-hidden="true"></span>',
  );
  assert.doesNotMatch(renderToStaticMarkup(copyParts('a\n\nb')), /<span><\/span>/);
});

test('wallet card face and card sheet count the same live subscriptions', () => {
  const [, , source] = sources.find(([file]) => file === 'views/Wallet.tsx');
  // 卡面「N 个订阅」与详情「关联订阅 N」同一口径：都只数这张卡正在付的
  assert.match(source, /const liveHere = live\.filter\(\(s\) => paysWith\(s, m, today\)\)/);
  assert.match(source, /t\('wallet\.sheet\.linked', \{ count: liveSubs\(state, today\)\.filter\(\(s\) => paysWith\(s, m, today\)\)\.length \}\)/);
  // 没设余额的卡也按卡的币种写每月支出，与角上的币种一致
  assert.match(source, /<FxAmount total=\{monthly\} direction=\{-1\} ccy=\{m\.currency\} \/>/);
});

test('UI copy and locale templates never introduce middle-dot separators', async () => {
  const failures = [];
  for (const file of readdirSync(root, { recursive: true }).filter((file) => file.endsWith('.tsx'))) {
    const source = readUiSource(new URL(file, root));
    const ast = await parsers.typescript.parse(source);
    visit(ast, (node) => {
      const value = node.type === 'JSXText' ? node.value : node.type === 'Literal' ? node.value : node.type === 'TemplateElement' ? node.value.raw : undefined;
      if (typeof value === 'string' && value.includes('\u00b7')) failures.push(file);
    });
  }
  const locales = new URL('../shared/locales/', import.meta.url);
  for (const file of readdirSync(locales, { recursive: true }).filter((file) => file.endsWith('.json'))) {
    if (readFileSync(new URL(file, locales), 'utf8').includes('\u00b7')) failures.push(`locales/${file}`);
  }
  assert.deepEqual(failures, []);
});

test('controls that sit in toolbars and rows share the pill shape instead of mixing pills and rectangles', () => {
  const css = allCss + readFileSync(new URL('views/assistant.css', root), 'utf8');
  const last = (sel) =>
    cssRules(css)
      .filter(([s]) => s.split(',').some((x) => x.trim() === sel))
      .map(([, body]) => /border-radius:\s*([^;]+)/.exec(body)?.[1])
      .filter(Boolean)
      .at(-1);
  for (const sel of ['.seg', '.seg button', '.as-suggest button', '.pk-btn.inline', '.mp-btn', '.ai-copy'])
    assert.match(last(sel) ?? '', /radius-pill|999px/, sel);
});

test('assistant tool output and its proposal have distinct stable sibling keys', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/Assistant.tsx');
  const result = transformSync('BotMessage.tsx', source.slice(...functionRange(ast, 'BotMessage')), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  const deps = { React, ToolCard: 'tool-card', Proposal: 'proposal', Reasoning: 'reasoning', Markdown: 'markdown' };
  const BotMessage = new Function(...Object.keys(deps), `${result.code}; return BotMessage;`)(...Object.values(deps));
  const id = 'call_00_fictional';
  const tool = { kind: 'tool', id, name: 'create_subscription', args: {}, status: 'done' };
  const proposal = { kind: 'proposal', id, tool: tool.name, args: {}, preview: {}, state: 'pending' };
  const render = (parts) => BotMessage({ turn: { parts, status: 'done' }, state: {}, last: false });
  const children = (tree) => tree.props.children.props.children[1];
  const initial = children(render([tool]));
  const paired = children(render([tool, proposal]));
  assert.equal(new Set(paired.map((el) => el.key)).size, 2);
  assert.equal(initial[0].key, paired[0].key);
  assert.equal(paired[0].props.part, tool);
  assert.equal(paired[1].props.part, proposal);
  assert.deepEqual(
    children(render([tool, { kind: 'text', text: 'Review draft' }, proposal]))
      .filter((el) => el.props.part)
      .map((el) => el.key),
    paired.map((el) => el.key),
  );
});

test('pages and panels hide scrollbars and never assign them accent colors', () => {
  for (const [file, css] of styleSources) {
    for (const [, property, value] of css.matchAll(/((?:--)?scrollbar-(?:color|thumb|track|width)|--scrollbar):\s*([^;]+);/g)) {
      assert.ok(property.endsWith('width') ? value === 'none' : value === 'auto', `${file}: ${property}: ${value}`);
    }
    for (const [, body] of css.matchAll(/[^{}]*::-webkit-scrollbar[^{}]*\{([^{}]*)\}/g)) {
      assert.doesNotMatch(body, /(?:background|color|box-shadow)\s*:/, file);
    }
  }
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const global = cssRules(css)
    .filter(([sel]) => sel === '*')
    .map(([, body]) => body)
    .join('\n');
  assert.match(global, /scrollbar-width:\s*none;/);
  assert.match(global, /scrollbar-color:\s*auto;/);
  assert.match(css, /\*::-webkit-scrollbar\s*\{[^}]*display:\s*none;/);
  const hero = readFileSync(new URL('heroui.css', root), 'utf8');
  assert.match(hero, /--scrollbar-width:\s*none;/);
  assert.match(hero, /--scrollbar-color:\s*auto;/);
});

test('glass is limited to sticky toolbars and sheet headers and footers', () => {
  const failures = [];
  const walk = (rules, file) => {
    for (const [selector, body] of rules) {
      if (selector.startsWith('@')) walk(cssRules(body), file);
      else if ([...body.matchAll(/(?:^|;)\s*(?:-webkit-)?backdrop-filter:\s*([^;]+);/g)].some((m) => m[1].trim() !== 'none')) {
        // The phone dock is the one floating glass surface: fixed, not sticky.
        if (selector.replace(/\s+/g, ' ') === '.dock-bar, .dock-more, .arc-item') continue;
        if (!['.toolbar', '.sheet-head', '.sheet-foot'].includes(selector)) failures.push(`${file}: ${selector}`);
        assert.match(body, /position:\s*sticky/, `${file}: ${selector}`);
      }
    }
  };
  for (const [file, css] of styleSources) walk(cssRules(css), file);
  assert.deepEqual(failures, []);
});

test('decorative spotlights and left-edge callouts do not return', () => {
  for (const [file, css] of styleSources) {
    for (const [selector, body] of leafRules(css)) {
      // Pointer reflections and material lighting are content on simulated physical cards only.
      if (physicalCardSelector(selector)) continue;
      assert.doesNotMatch(body, /--m[xy]\b/, `${file}: ${selector}`);
      if (!body.includes('radial-gradient')) continue;
      // The other remaining radial gradients cut functional receipt-paper edges.
      assert.match(body, /(?:-webkit-)?mask:\s*radial-gradient/, file);
      assert.doesNotMatch(body, /background(?:-image)?:[^;]*radial-gradient/, file);
    }
  }
  const detail = readFileSync(new URL('views/detail.css', root), 'utf8');
  assert.doesNotMatch(detail, /box-shadow:\s*inset\s+[1-9][\d.]*px\s+0\s+0/);
  const assistant = readFileSync(new URL('views/assistant.css', root), 'utf8');
  for (const sel of ['.as-md blockquote', '.as-reason-b']) {
    const body = cssRules(assistant).find(([selector]) => selector === sel)?.[1];
    assert.ok(body);
    assert.doesNotMatch(body, /border-left:/);
    assert.match(body, /padding:/);
  }
  for (const css of [detail, readFileSync(new URL('styles.css', root), 'utf8')]) {
    for (const [, body] of css.matchAll(/(?:\.dt-badge\.dot|\.ph-status)[^{}]*\bi\s*\{([^{}]*)\}/g)) {
      assert.doesNotMatch(body, /box-shadow:|filter:|animation:/);
    }
  }
});

test('normal settlement is silent while attention status pills retain their labels', () => {
  const [, ast, source] = sources.find(([file]) => file === 'components/ui.tsx');
  const result = transformSync('StatusPill.tsx', source.slice(...functionRange(ast, 'StatusPill')), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  const StatusPill = new Function('React', 'Icon', `${result.code}; return StatusPill;`)(React, 'icon');
  assert.equal(renderToStaticMarkup(React.createElement(StatusPill, { tone: 'ok' }, 'Settled')), '');
  for (const [tone, label] of [
    ['owe', 'Pending'],
    ['stop', 'Stopped'],
    ['notice', 'Paused'],
    ['done', 'Settled'],
  ]) {
    assert.match(renderToStaticMarkup(React.createElement(StatusPill, { tone }, label)), new RegExp(label));
  }
});

test('assistant welcome rotates every variant in every locale and renders a quiet title and body', () => {
  const source = sources.find(([file]) => file === 'views/Assistant.tsx')[2];
  const count = Number(/const WELCOME_COUNT = (\d+);/.exec(source)?.[1]);
  assert.ok(count > 1);
  assert.match(source, /<h2>\{t\(`assistant\.welcome\.variants\.v\$\{n\}\.title`\)\}<\/h2>/);
  assert.match(source, /<p>\{t\(`assistant\.welcome\.variants\.v\$\{n\}\.body`\)\}<\/p>/);
  const locales = new URL('../shared/locales/', import.meta.url);
  for (const { name: lang } of readdirSync(locales, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    const { welcome } = JSON.parse(readFileSync(new URL(`${lang}/assistant.json`, locales), 'utf8'));
    assert.equal(Object.keys(welcome.variants).length, count, lang);
    for (const { title, body } of Object.values(welcome.variants)) {
      assert.ok(title.trim() && body.trim(), lang);
    }
  }
});

test('subscription headings omit normal status badges and retain exceptional states', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/Detail.tsx');
  // 标题与角标交给共用的 DetailHead；这里取 badge 的表达式与名称一起渲染
  let badge;
  visit(ast, (node) => {
    if (node.type === 'JSXElement' && node.openingElement.name.name === 'DetailHead')
      badge = node.openingElement.attributes.find((a) => a.name?.name === 'badge')?.value.expression;
  });
  assert.ok(badge);
  const result = transformSync('DetailHeader.tsx', `function Header() { return (<h2>{sub.name}{${text(badge, source)}}</h2>); }`, {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  for (const st of ['active', 'lifetime', 'trial', 'paused', 'ending', 'ended', 'terminated', 'upcoming']) {
    const Header = new Function('React', 'sub', 'st', 'TONE', 't', `${result.code}; return Header;`)(React, { name: 'Orbit Notes' }, st, {}, (key) => key);
    const html = renderToStaticMarkup(React.createElement(Header));
    assert.match(html, /Orbit Notes/);
    if (['active', 'lifetime'].includes(st)) assert.doesNotMatch(html, /dt-badge/);
    else assert.ok(html.includes(`list.status.${st}`), st);
  }
});

test('wallet hides the shared-plans entry when there are no shared plans', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/Wallet.tsx');
  let entry;
  visit(ast, (node) => {
    if (node.type === 'JSXExpressionContainer' && text(node, source).includes("go('family')") && !text(node, source).includes('<DndContext'))
      entry ??= text(node, source);
  });
  assert.ok(entry);
  const result = transformSync('WalletFamily.tsx', `function Entry() { return (<>${entry}</>); }`, {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  const stub = (tag) => (props) => React.createElement(tag, null, props.label, props.children);
  for (const sharedCount of [0, 2]) {
    const Entry = new Function('React', 'Group', 'Cell', 'Icon', 'go', 't', 'sharedCount', `${result.code}; return Entry;`)(
      React,
      stub('section'),
      stub('div'),
      () => null,
      () => {},
      (key, vars) => `${key}${vars ? `:${vars.count}` : ''}`,
      sharedCount,
    );
    const html = renderToStaticMarkup(React.createElement(Entry));
    if (sharedCount) assert.match(html, /wallet\.familyCount:2/);
    else assert.equal(html, '');
  }
});

test('MCP connection headings only add a status badge when access is disabled', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/Ai.tsx');
  let header;
  visit(ast, (node) => {
    if (node.type === 'JSXElement' && node.openingElement.name.name === 'b' && text(node, source).includes('ai-badge')) header = text(node, source);
  });
  assert.ok(header);
  const result = transformSync('ConnectionHeader.tsx', `function Header() { return (${header}); }`, {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  for (const enabled of [true, false]) {
    const Header = new Function('React', 'enabled', 't', `${result.code}; return Header;`)(React, enabled, (key) => key);
    const html = renderToStaticMarkup(React.createElement(Header));
    if (enabled) assert.doesNotMatch(html, /ai-badge/);
    else assert.match(html, /settings.open.off/);
  }
});

test('subscription share posters omit normal status chips but keep attention states', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/SubShare.tsx');
  let chips;
  visit(ast, (node) => {
    if (node.type === 'JSXElement' && text(attr(node.openingElement, 'className')?.value, source) === '"sp-chips"') chips = text(node, source);
  });
  assert.ok(chips);
  const result = transformSync('ShareStatus.tsx', `function Chips() { return (${chips}); }`, {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  for (const status of ['active', 'lifetime', 'trial', 'paused', 'ending', 'ended', 'terminated', 'upcoming']) {
    const deps = { React, st: { status, gaps: [], vs: [], change: null }, statusText: (st) => st.status, t: (key) => key, changeText: () => '' };
    const Chips = new Function(...Object.keys(deps), `${result.code}; return Chips;`)(...Object.values(deps));
    const html = renderToStaticMarkup(React.createElement(Chips));
    if (['active', 'lifetime'].includes(status)) assert.doesNotMatch(html, /<span/);
    else assert.ok(html.includes(`<span>${status}</span>`), status);
  }
});

test('inline price Enter respects IME and its local boundary, without submitting the sheet', async () => {
  const h = await priceEditorHarness();
  h.open();
  const doc = { querySelector: () => null };
  const target = { tagName: 'INPUT', type: 'text', closest: () => null };
  let prevented = 0;
  let stopped = 0;
  const event = (extra = {}) => ({
    nativeEvent: { key: 'Enter', target, ...extra },
    currentTarget: { ownerDocument: doc },
    preventDefault: () => prevented++,
    stopPropagation: () => stopped++,
  });
  assert.equal(h.inline().props['data-submit'], '');
  h.inline().props.onKeyDown(event({ isComposing: true }));
  h.inline().props.onKeyDown(event({ keyCode: 229 }));
  assert.ok(h.inline());
  assert.equal(prevented, 0);
  h.inline().props.onKeyDown(event());
  assert.equal(h.inline(), undefined);
  assert.equal(prevented, 1);
  assert.equal(stopped, 1);
});

test('keyboard behavior stays in the shared Sheet and guards, with safe confirmation focus', () => {
  const ui = sources.find(([file]) => file === 'components/ui.tsx')[2];
  const app = sources.find(([file]) => file === 'app.tsx')[2];
  const calendar = sources.find(([file]) => file === 'views/Calendar.tsx')[2];
  assert.match(ui, /submitSheet\(e, dialog\.current\)/);
  assert.match(ui, /className="btn" autoFocus onClick=\{\(\) => done\(false\)\}/);
  assert.doesNotMatch(ui, /danger-solid" autoFocus/);
  assert.match(calendar, /if \(!canUseSingleKey\(e\)\) return/);
  assert.match(app, /const action = pageShortcut\(e, detail\)/);
  assert.match(app, /onEdit=\{editFromDetail\}/);
});

test('single-series charts share the monochrome chart ink and keep readable data-line widths', () => {
  const detail = readFileSync(new URL('views/detail.css', root), 'utf8');
  const charts = readFileSync(new URL('components/charts.tsx', root), 'utf8');
  // 扣款时间轴：实际扣款的柱用单色图表墨色，「今天」线不细到看不见
  const bar = cssRules(detail).find(([s]) => s === '.cc-bar')?.[1] ?? '';
  assert.match(bar, /var\(--chart-ink\)/);
  for (const sel of ['.cc-bar.future', '.cc-today']) {
    const body = cssRules(detail).find(([s]) => s === sel)?.[1] ?? '';
    assert.doesNotMatch(body, /var\(--(accent|orange|indigo-\d+)\)/, sel);
    assert.doesNotMatch(body, /stroke-width:\s*0\.5\b/, sel);
  }
  assert.doesNotMatch(charts, /var\(--(accent|orange|indigo-\d+)\)/);
  assert.doesNotMatch(charts, /<path[^>]*strokeWidth="0\.5"/);
  const pub = readFileSync(new URL('public/index.css', root), 'utf8');
  for (const n of [1, 2, 3, 4, 5]) assert.match(pub, new RegExp(`--chart-${n}:\\s*var\\(--gray-\\d+\\)`));
});

test('physical wallet cards keep bounded pointer tilt and reflection without taking over sort translation', () => {
  const [, ast, source] = sources.find(([file]) => file === 'views/Wallet.tsx');
  const result = transformSync('SortableCard.tsx', source.slice(...functionRange(ast, 'SortableCard')), {
    lang: 'tsx',
    jsx: { runtime: 'classic' },
    reactCompiler: false,
  });
  assert.equal(result.fatal, false);
  let dragging = false;
  const useSortable = () => ({ attributes: {}, listeners: {}, transform: { x: 24, y: 16 }, transition: 'transform 200ms ease', isDragging: dragging });
  const Card = new Function('React', 'useSortable', 'faceClass', 'paletteColor', 'KIND_BG', `${result.code}; return SortableCard;`)(
    React,
    useSortable,
    () => '',
    (_, fallback) => fallback,
    { debit: 'neutral' },
  );
  const props = { m: { id: 'fictional-card', kind: 'debit' }, onOpen() {}, children: null };
  const card = Card(props);
  assert.equal(card.props.style.translate, '24px 16px');
  assert.equal(card.props.style['--sort-t'], 'translate 200ms ease');
  const values = {};
  const currentTarget = {
    getBoundingClientRect: () => ({ left: 20, top: 30, width: 300, height: 180 }),
    style: {
      setProperty: (k, v) => {
        values[k] = v;
      },
    },
  };
  card.props.onMouseMove({ currentTarget, clientX: 320, clientY: 30 });
  assert.deepEqual(values, { '--mx': '300px', '--my': '0px', '--ry': '4.00deg', '--rx': '4.00deg' });
  card.props.onMouseMove({ currentTarget, clientX: -100, clientY: 900 });
  assert.equal(values['--rx'], '-4.00deg');
  assert.equal(values['--ry'], '-4.00deg');
  card.props.onMouseLeave({ currentTarget });
  assert.equal(values['--rx'], '0deg');
  assert.equal(values['--ry'], '0deg');
  dragging = true;
  Card(props).props.onMouseMove({ currentTarget, clientX: 320, clientY: 30 });
  assert.equal(values['--rx'], '0deg');
});

test('wallet cards keep the main-branch physical-card design with pointer tilt and reflection', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const rules = leafRules(css);
  const bodies = (sel) =>
    rules
      .filter(([s]) => s.split(',').some((x) => x.trim() === sel))
      .map(([, b]) => b.replace(/\s+/g, ' '))
      .join('\n');
  assert.match(bodies('.paycard'), /background: var\(--card-bg, linear-gradient\(135deg, #3b4a57, #1d2328\)\)/);
  assert.match(bodies('.paycard'), /box-shadow: 0 10px 30px/);
  assert.match(bodies('.paycard:hover'), /perspective\(900px\) rotateX\(var\(--rx, 0deg\)\) rotateY\(var\(--ry, 0deg\)\)/);
  assert.match(bodies('.paycard::before'), /radial-gradient/);
  assert.match(bodies('.paycard::after'), /var\(--mx, 50%\) var\(--my, 50%\)/);
  assert.match(bodies('.paycard:hover::after'), /opacity: 1/);
  assert.match(bodies('.wallet-grid.dragging .paycard::after'), /opacity: 0/);
  const wallet = sources.find(([file]) => file === 'views/Wallet.tsx')[2];
  assert.match(wallet, /'--card-bg': m\.color \|\| KIND_BG\[m\.kind\]/);
  assert.match(wallet, /setProperty\('--rx'/);
  assert.match(wallet, /setProperty\('--mx'/);
  // 银行卡芯片画出触点分区，而不是纯色块；卡面与芯片在钱包和订阅详情共用
  const face = sources.find(([file]) => file === 'components/PayCardFace.tsx')[2];
  assert.match(face, /function CardChip\(\)/);
  assert.match(face, /<rect x="12" y="8" width="12" height="11"/);
  assert.match(wallet, /from '\.\.\/components\/PayCardFace\.tsx'/);
});

test('connection terminals keep theme-independent dark surfaces and light text', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const rules = cssRules(css);
  for (const selector of ['.ai-code', '.ai-code-bar', '.ai-copy', '.ai-copy:hover']) {
    const body = rules.find(([sel]) => sel === selector)?.[1];
    assert.ok(body, selector);
    const colors = [...body.matchAll(/(?:^|;)\s*(?:background|color):\s*([^;]+);/g)].map((m) => m[1]);
    assert.ok(colors.length, selector);
    for (const color of colors) assert.match(color, /^var\(--(?:black|white)-a\d+\)$/, selector);
    if (selector === '.ai-code') {
      assert.match(body, /background:\s*var\(--black-a12\)/);
      assert.match(body, /color:\s*var\(--white-a12\)/);
    } else if (selector !== '.ai-copy:hover') assert.match(body, /color:\s*var\(--white-a(?:11|12)\)/);
  }
  const pre = rules.find(([sel]) => sel === '.ai-code pre')?.[1];
  assert.doesNotMatch(pre, /(?:^|;)\s*(?:background|color):/); // 代码继承终端前景，避免主题文字色覆盖
  for (const [selector, body] of rules) {
    if (/\.ai-(?:code|copy)\b/.test(selector)) assert.doesNotMatch(body, /var\(--(?:gray|slate|label|ink)/, selector);
  }
});

test('connection setup hint is removed in every locale', () => {
  for (const entry of readdirSync(new URL('../shared/locales/', import.meta.url), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const messages = JSON.parse(readFileSync(new URL(`../shared/locales/${entry.name}/ai.json`, import.meta.url), 'utf8'));
    assert.equal(messages.setupHint, undefined, entry.name);
  }
});

const nestedCssRules = (css) => cssRules(css).flatMap(([selector, body]) => (selector.startsWith('@') ? nestedCssRules(body) : [[selector, body]]));

function layoutChildren(children) {
  const elements = [];
  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement') {
      elements.push(node);
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(scan);
      else scan(value);
    }
  };
  children.forEach(scan);
  return elements;
}

function parallelMetricViolations(ast, source) {
  const failures = [];
  visit(ast, (node) => {
    if (node.type !== 'JSXElement') return;
    const opening = node.openingElement;
    const classes = text(attr(opening, 'className')?.value, source);
    if (/(?<![\w-])(?:stat|stat-value|stat-sub|[\w-]+-facts|[\w-]+-kpis|car-strip|stop-totals|mv-head|people-stats)(?![\w-])/.test(classes))
      failures.push(classes);
    const cells = layoutChildren(node.children).filter((child) => child.openingElement.name.name === 'div');
    const metricLike = cells.filter((cell) => {
      const tags = layoutChildren(cell.children).map((c) => c.openingElement.name.name);
      return tags.includes('b') && (tags.includes('small') || tags.includes('span'));
    });
    if (metricLike.length > 1 && opening.name.name !== 'MetricCards' && !classes.includes('metric-grid'))
      failures.push(`unshared metric cells: ${classes || opening.name.name} at ${node.range[0]}`);
  });
  return failures;
}

test('parallel metrics use the shared cards and slots, including previously independent page and sheet summaries', async () => {
  for (const [file, ast, source] of sources) assert.deepEqual(parallelMetricViolations(ast, source), [], file);
  const legacy = '<div className="custom-summary"><div><small>Paid</small><b>−10</b></div><div><small>Received</small><b>+20</b></div></div>';
  assert.ok(parallelMetricViolations(await parsers.typescript.parse(legacy), legacy).length > 0);
  const conditional = '<div><div><span>Saved</span><b>+10</b></div>{showLoss && <div><span>Loss</span><b>—</b></div>}</div>';
  assert.ok(parallelMetricViolations(await parsers.typescript.parse(conditional), conditional).length > 0);
  const shared = '<MetricCards><Metric label="Paid" value="−10" /><Metric label="Received" value="+20" /></MetricCards>';
  assert.deepEqual(parallelMetricViolations(await parsers.typescript.parse(shared), shared), []);
  for (const [file, css] of styleSources) {
    if (file.startsWith('public/')) continue;
    for (const [selector, body] of nestedCssRules(css)) {
      if (!selector.includes('.metric-') || !/font-|grid-template|padding|border-radius|background:/.test(body)) continue;
      assert.equal(file, 'components/ui.css', `${file}: metric presentation must have one owner`);
    }
  }
});

test('metric cards stay block containers even though their variant class matches the Tailwind inline utility', () => {
  const [, css] = styleSources.find(([file]) => file === 'components/ui.css');
  const body = cssRules(css).find(([selector]) => selector === '.metric-cards')?.[1] ?? '';
  // 行内元素不能作容器查询的容器：窄卡片里的两列与换行规则会全部失效
  assert.match(body, /display:\s*block/);
  assert.match(body, /container-type:\s*inline-size/);
});

test('metric slots retain negative, zero and unavailable amounts, notes and semantic colors without inventing data', () => {
  const [, ast, source] = sources.find(([file]) => file === 'components/ui.tsx');
  const functions = ['MetricCards', 'Metric'].map((name) => source.slice(...functionRange(ast, name))).join('\n');
  const result = transformSync('ui.tsx', functions, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  const { Metric, MetricCards } = new Function('React', 'Children', `${result.code}; return { Metric, MetricCards };`)(React, React.Children);
  assert.equal(renderToStaticMarkup(React.createElement(MetricCards, null, false, null)), '');
  const html = renderToStaticMarkup(
    React.createElement(
      MetricCards,
      null,
      React.createElement(Metric, { label: 'Cost', value: '−¥10.00', valueClassName: 'loss', note: 'Original period', 'aria-label': 'Historical cost' }),
      React.createElement(Metric, { label: 'Received', value: '+¥20.00', valueClassName: 'done' }),
      React.createElement(Metric, { label: 'Due', value: '¥0.00', valueClassName: 'warn' }),
      React.createElement(Metric, { label: 'Unavailable', value: '—', note: 'Missing FX' }),
    ),
  );
  for (const value of ['−¥10.00', '+¥20.00', '¥0.00', '—', 'Original period', 'Missing FX']) assert.ok(html.includes(value));
  assert.match(html, /aria-label="Historical cost"/);
  assert.match(html, /class="metric-value loss"/);
  assert.match(html, /class="metric-value done"/);
  assert.match(html, /class="metric-value warn"/);
  const css = readFileSync(new URL('components/ui.css', root), 'utf8');
  assert.match(css, /\.metric-value,[\s\S]*?font-weight:\s*650/);
  const rules = nestedCssRules(css);
  const frame = rules.find(([selector]) => selector === '.metric-cards')[1];
  const cell = rules.find(([selector]) => selector === '.metric-grid > div')[1];
  assert.doesNotMatch(frame, /background:|box-shadow:|border:/);
  assert.match(cell, /background:\s*var\(--card\)/);
  assert.match(cell, /border-radius:\s*var\(--radius-md\)/);
  assert.match(css, /repeat\(var\(--metric-columns\), minmax\(0, 1fr\)\)/);
  assert.doesNotMatch(css, /margin-inline-start:|inset var\(--hairline\) 0/);
  assert.match(css, /\.metric-grid > div > b:is\(\.done, \.gain, \.green\)\s*\{\s*color: var\(--gain\)/);
  for (const count of [1, 2, 3, 4, 5]) {
    const cards = renderToStaticMarkup(
      React.createElement(
        MetricCards,
        null,
        false,
        Array.from({ length: count }, (_, key) => React.createElement(Metric, { key, label: 'Due', value: '—' })),
      ),
    );
    assert.ok(cards.includes(`--metric-columns:${Math.min(4, count)}`));
  }
  const accessory = renderToStaticMarkup(React.createElement(Metric, { label: 'Monthly', value: '−10', accessory: React.createElement('span', null, '−5%') }));
  assert.match(accessory, /metric-top[\s\S]*?Monthly[\s\S]*?−5%[\s\S]*?metric-value[\s\S]*?−10/);

  assert.match(css, /@container \(max-width: 520px\)[\s\S]*?repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /@container \(max-width: 300px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);

  // 回归：数值只在空格处折行，「− / ¥4,843.18」「2027年4月10 / 日」这类从符号、末字中间断开的写法不再出现
  const tokens = renderToStaticMarkup(React.createElement(Metric, { label: 'Pending', value: '−¥4,843.18 2027年4月10日' }));
  assert.match(tokens, /<span class="nowrap">−¥4,843\.18<\/span> <span class="nowrap">2027年4月10日<\/span>/);
  const value = rules.find(([selector]) => selector === '.metric-value,\n.metric-grid > div > b')[1];
  assert.match(value, /overflow-wrap:\s*normal/);
  assert.match(value, /word-break:\s*keep-all/);
  assert.match(css, /\.metric-value \.amt,[^{]*\{\s*white-space:\s*nowrap/);
});

// Adjacent full-size action buttons differ from field controls, pickers, table rows
// and disclosure buttons. Look through conditional JSX, but never through a new layout container.
function sheetActionViolations(ast, source, sharedForm = false) {
  const failures = [];
  const scan = (node, inSheet = sharedForm) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'JSXElement') {
      inSheet ||= node.openingElement.name.name === 'Sheet';
      if (inSheet && ['div', 'span'].includes(node.openingElement.name.name)) {
        const buttons = [];
        const direct = (child) => {
          if (!child || typeof child !== 'object') return;
          if (child.type === 'JSXElement') {
            const o = child.openingElement;
            if (['button', 'a'].includes(o.name.name) && /(?<![\w-])btn(?![\w-])/.test(text(attr(o, 'className')?.value, source))) buttons.push(child);
            return;
          }
          for (const [key, value] of Object.entries(child)) {
            if (['loc', 'range', 'comments', 'tokens'].includes(key)) continue;
            if (Array.isArray(value)) value.forEach(direct);
            else direct(value);
          }
        };
        node.children.forEach(direct);
        if (
          buttons.filter((b) => !attr(b.openingElement, 'aria-pressed')).length > 1 &&
          !/\bsheet-actions\b/.test(text(attr(node.openingElement, 'className')?.value, source))
        )
          failures.push('action row missing sheet-actions');
        if (
          /\bsheet-actions\b/.test(text(attr(node.openingElement, 'className')?.value, source)) &&
          /justifyContent|flexDirection|flexWrap/.test(text(attr(node.openingElement, 'style'), source))
        )
          failures.push('local action alignment');
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'range', 'comments', 'tokens'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((child) => scan(child, inSheet));
      else scan(value, inSheet);
    }
  };
  scan(ast);
  return failures;
}

test('sheet and embedded form action rows use one right-aligned container with the primary action last', async () => {
  for (const [file, ast, source] of sources) {
    assert.deepEqual(sheetActionViolations(ast, source, ['components/ChangePanel.tsx', 'components/StopPanel.tsx'].includes(file)), [], file);
  }
  const bad = '<Sheet><div className="row"><button className="btn">Edit</button><button className="btn primary">Save</button></div></Sheet>';
  assert.deepEqual(sheetActionViolations(await parsers.typescript.parse(bad), bad), ['action row missing sheet-actions']);
  const good = bad.replace('className="row"', 'className="sheet-actions"');
  assert.deepEqual(sheetActionViolations(await parsers.typescript.parse(good), good), []);
  const ui = readUiSource(new URL('components/ui.tsx', root));
  assert.match(ui, /className="sheet-foot sheet-actions"/);
  const kit = readFileSync(new URL('components/DetailKit.tsx', root), 'utf8');
  assert.match(kit, /className="sheet-actions dt-actions"/);
  const css = readFileSync(new URL('components/ui.css', root), 'utf8');
  assert.match(css, /\.sheet-actions\s*\{[^}]*justify-content:\s*flex-end/);
  assert.match(css, /\.sheet-actions > :is\(\.primary, \.danger-solid\)\s*\{\s*order:\s*1/);
  assert.match(css, /\.sheet-foot > \.confirm-btn:first-child\s*\{\s*margin-right:\s*auto/);
  for (const [file, css] of styleSources) {
    if (file.startsWith('public/')) continue;
    for (const [selector, body] of nestedCssRules(css)) {
      if (/\.(?:dt-actions|sheet-foot|copy-actions|change-actions|stop-actions|pubs-acts)(?![\w-])/.test(selector))
        assert.doesNotMatch(body, /justify-content:\s*|flex-wrap:\s*|grid-template-columns:\s*/, `${file}: local action layout ${selector}`);
    }
  }
});

test('image clipboard construction has one owner and Sheet actions precede Close in every header mode', () => {
  for (const file of readdirSync(root, { recursive: true }).filter((file) => /\.tsx?$/.test(file))) {
    const source = readUiSource(new URL(file, root));
    if (file === 'components/CopyImageButton.tsx') assert.match(source, /new ClipboardItem/);
    else assert.doesNotMatch(source, /new ClipboardItem/, file);
  }
  const ui = sources.find(([file]) => file === 'components/ui.tsx')[2];
  assert.match(ui, /actions\?: ComponentChildren/);
  assert.match(ui, /sheet-head-actions[\s\S]*?\{props.actions\}[\s\S]*?onClick=\{props.onClose\}/);
  for (const file of ['views/Carpool.tsx', 'components/ShareSheet.tsx']) {
    const [, ast, source] = sources.find(([path]) => path === file);
    let slotted = false;
    visit(ast, (node) => {
      // 合租详情用共用的 DetailHead，操作同样排在关闭按钮之前
      if (node.type !== 'JSXElement' || !['Sheet', 'DetailHead'].includes(node.openingElement.name.name)) return;
      const actions = attr(node.openingElement, 'actions');
      if (actions && text(actions, source).includes('CopyImageButton')) slotted = true;
    });
    assert.ok(slotted, file);
  }
  // 详情类弹窗共用一个吸顶头部，自带关闭按钮，排在操作之后
  const kit = sources.find(([file]) => file === 'components/DetailKit.tsx')[2];
  assert.match(kit, /<Sheet[^>]*header=\{null\}/);
  assert.match(kit, /\{actions && <div className="sheet-actions dt-actions">[\s\S]*?className="dt-close"[\s\S]*?onClick=\{onClose\}/);
  const detail = sources.find(([file]) => file === 'views/Detail.tsx')[2];
  assert.match(detail, /<DetailSheet/);
  assert.match(detail, /<CopyImageButton/);
  const review = sources.find(([file]) => file === 'views/Review.tsx')[2];
  assert.match(review, /<ShareSheet/);
});

test('table headers share one light header style; only framed full-width tables get a gray band', () => {
  const tsx = sources.map(([file, , text]) => [file, text]);
  const failures = [];
  for (const [file, text] of tsx) {
    for (const m of text.matchAll(/className="([^"]*\b(?:ld-th|people-head|lt-head)\b[^"]*)"/g))
      if (!m[1].split(' ').includes('table-head')) failures.push(`${file}: ${m[1]}`);
    if (/<thead[\s>]/.test(text) && !/<thead[^>]*>\s*<tr[^>]*className="table-head"/.test(text)) failures.push(`${file}: thead row without table-head`);
  }
  for (const [file, css] of styleSources) {
    for (const m of css.matchAll(/([^{}]*(?:\.ld-th|\.lt-head|\.people-head)[^{}]*)\{([^}]*)\}/g)) {
      const selector = m[1].replace(/:not\([^)]*\)/g, '');
      // 带外框的整宽表（.ltable）表头是浅灰底带；放在卡片里的表仍然无底色
      if (selector.trim() === '.ltable > .lt-head.table-head') continue;
      if (/\.ld-th|\.lt-head|\.people-head/.test(selector) && /background\s*:(?!\s*none)/.test(m[2]))
        failures.push(`${file}: ${m[1].trim()} has a filled background`);
    }
  }
  assert.deepEqual(failures, []);
});

test('叠在成员弹窗上的收款表单在成员弹窗挂上之后才打开，不能同一刻挂载（否则层级反了、被遮住且点不动）', () => {
  const source = readFileSync(new URL('views/member/useMemberForm.ts', root), 'utf8');
  assert.match(source, /useState<\{ edit\?: string; preset\?: string\[\] \} \| null>\(null\)/);
  assert.doesNotMatch(source, /useState<[^>]*>\(initialReceipt/);
  assert.match(source, /useEffect\(\(\) => \{[\s\S]*?if \(initialReceipt\) setReceipt\(initialReceipt\)/);
});

test('登录页隐藏的固定账号字段不继承输入框内边距，裁切后实际只占 1×1', () => {
  const rule = allCss.match(/\.login-card input\.login-account\s*\{([^}]*)\}/)?.[1] ?? '';
  for (const decl of ['width: 1px', 'height: 1px', 'padding: 0', 'clip-path: inset(50%)']) assert.ok(rule.includes(decl), decl);
});

/** 某个选择器（含 @media 内）的全部声明，按出现顺序拼在一起 */
const rulesFor = (selector) => {
  const out = [];
  const walk = (rules) => {
    for (const [sel, body] of rules) {
      if (sel.startsWith('@media')) walk(cssRules(body));
      else if (sel.split(',').some((s) => s.trim() === selector)) out.push(body);
    }
  };
  walk(cssRules(allCss));
  return out.join('\n');
};

test('手机底栏当前项只换文字与图标颜色，不画灰色底', () => {
  for (const sel of ['.tab.on', '.dock-more.on']) assert.doesNotMatch(rulesFor(sel), /background/, sel);
  for (const sel of ['.dock-more.on::after', '.dock.open .dock-more::after']) assert.equal(rulesFor(sel), '', sel);
});

test('手机「更多」圆按钮与底栏用短名，不用侧栏全称', () => {
  const nav = readFileSync(new URL('components/MobileNav.tsx', root), 'utf8');
  const label = [...nav.matchAll(/className="arc-label">\{t\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(label.length >= 3);
  for (const key of label) assert.match(key, /^app\.navShort\./);
  assert.match(readFileSync(new URL('app.tsx', root), 'utf8'), /label: t\(`app\.navShort\.\$\{/);
  // 11px 只给圆按钮里的短名用，别处仍走统一字号
  assert.match(rulesFor('.arc-label'), /font: 500 11px\/1\.1 var\(--font\)/);
  assert.equal(allCss.match(/(?<![\w-])font:[^;]*\b11px/g)?.length, 1);
  const locales = new URL('../../shared/locales/', root);
  for (const loc of readdirSync(locales, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    const short = JSON.parse(readFileSync(new URL(`${loc}/app.json`, locales), 'utf8')).navShort;
    for (const [key, value] of Object.entries(short)) assert.ok([...value].length <= 9, `${loc} ${key}: ${value}`);
  }
});

test('筛选胶囊的底色比点按区矮，手机上选中的「全部」不会是 40px 高的大胶囊', () => {
  assert.doesNotMatch(rulesFor('.facet.on'), /background/);
  assert.match(rulesFor('.facet.on::before'), /background:\s*var\(--ink\)/);
  assert.match(rulesFor('.facet::before'), /inset:\s*calc\(\(var\(--ctl-h-sm\) - var\(--facet-pill\)\) \/ 2\) 0/);
  const pills = [...rulesFor('.facet').matchAll(/--facet-pill:\s*(\d+)px/g)].map((m) => +m[1]);
  assert.deepEqual(pills, [26, 30]);
});

test('桌面工具栏操作区不在组内折行，排序等控件不被压缩截断', () => {
  const desk = cssRules(allCss).find(([sel, body]) => sel === '@media (min-width: 861px)' && body.includes('.tb-actions'))?.[1] ?? '';
  assert.match(desk, /\.tb-actions\s*\{\s*flex-wrap:\s*nowrap/);
  assert.match(desk, /\.tb-actions > :not\(\.tb-search\)\s*\{\s*flex-shrink:\s*0/);
});

test('新建令牌的权限选项选中时圆点实心，接入步骤里的无底色按钮与内容同列', () => {
  assert.match(rulesFor('.ai-scope-card.on .ai-radio'), /inset 0 0 0 5px/);
  assert.match(rulesFor('.ai-step-actions > .btn.plain:first-child'), /margin-inline-start:\s*-6px/);
  assert.match(rulesFor('.btn.plain'), /padding:\s*0 6px/);
});

test('手机排序没有单独的升降序按钮：下拉选中项右侧标方向，再点同一项即反转', () => {
  const src = readFileSync(new URL('components/SortControl.tsx', root), 'utf8');
  const narrow = src.slice(src.indexOf('if (narrow)'), src.indexOf('  return (\n    <>'));
  assert.match(src, /useMedia\('\(max-width: 860px\)'\)/);
  assert.doesNotMatch(narrow, /IconButton/);
  assert.match(narrow, /onChange=\{\(v\) => \(v === value \? flip\(\) : onSort\(v\)\)\}/);
  assert.match(narrow, /mark=\{[\s\S]*aria-label=\{label\}/);
  const picker = readFileSync(new URL('components/Picker.tsx', root), 'utf8');
  assert.match(picker, /o\.value === value && \(mark \?\? <Icon name="check" \/>\)/);
  // 选中项再点也要回调，方向切换靠它
  assert.match(picker, /const pick = \(v: T\) => \{\s*onChange\(v\);/);
});

test('行尾删除与弹窗删除共用同一个确认态，紧跟着的双击都不会删除', () => {
  const row = readFileSync(new URL('components/RowActions.tsx', root), 'utf8');
  assert.match(row, /useArmed\(\)/);
  assert.match(row, /if \(!armed\) return arm\(\);\s*if \(!ready\(\)\) return;/);
  assert.doesNotMatch(row, /useState\(false\);\s*const \[done/);
});

test('助手页内标题写全称「AI 助手」，与「连接 AI 助手」对应；底栏短名才写「助手」', () => {
  const locales = new URL('../../shared/locales/', root);
  const read = (loc, ns) => JSON.parse(readFileSync(new URL(`${loc}/${ns}.json`, locales), 'utf8'));
  for (const loc of ['zh-CN', 'zh-HK', 'zh-TW', 'ja', 'ko', 'en']) assert.match(read(loc, 'assistant').title, /^AI /, loc);
  assert.equal(read('zh-CN', 'app').navShort.assistant, '助手');
});

test('phone report years stay at the left edge when touch exposes the copy action', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const phone = css.match(/@media \(max-width: 860px\)\s*\{\s*\.report-share\s*\{([^}]+)\}\s*\.report-share > \.year-step\s*\{([^}]+)\}/);
  assert.ok(phone, 'phone report needs its own row and year alignment');
  assert.match(phone[1], /flex-wrap:\s*nowrap/);
  assert.match(phone[2], /order:\s*-1/);
  assert.match(phone[2], /margin-right:\s*auto/);
});

// 某个 @media 块里某选择器的规则体（同一媒体条件可能出现多次，全部合并）
const mediaRule = (css, media, selector) =>
  cssRules(css)
    .filter(([sel]) => sel === media)
    .flatMap(([, body]) => cssRules(body))
    .filter(([sel]) => sel.split(',').some((s) => s.trim() === selector))
    .map(([, body]) => body)
    .join('\n');

test('展示的订阅：胶囊里的移除按钮不画自己的描边，贴在胶囊右端', () => {
  const css = readFileSync(new URL('views/public-subs.css', root), 'utf8');
  const rule = (sel) => cssRules(css).find(([s]) => s.trim() === sel)?.[1] ?? '';
  assert.match(rule('.icon-btn.pubs-x'), /box-shadow:\s*none/);
  assert.match(rule('.pubs-chip:has(> .pubs-x)'), /padding-right:\s*0/);
});

test('图标加文字的标签用共用的 icon-text 居中，不靠行内基线对齐', () => {
  const failures = [];
  for (const [file, ast, source] of sources) {
    visit(ast, (node) => {
      if (node.type !== 'JSXElement' || node.openingElement.name.name !== 'span') return;
      const kids = node.children.filter((c) => !(c.type === 'JSXText' && !c.value.trim()));
      const hasIcon = kids.some((c) => c.type === 'JSXElement' && c.openingElement.name.name === 'Icon');
      const hasText = kids.some((c) => c.type === 'JSXExpressionContainer' || (c.type === 'JSXText' && c.value.trim()));
      const classes = text(attr(node.openingElement, 'className')?.value, source);
      if (hasIcon && hasText && !/(?<![\w-])(?:icon-text|row)(?![\w-])/.test(classes))
        failures.push(`${file}:${node.loc?.start.line ?? ''} ${source.slice(...node.range).slice(0, 80)}`);
    });
  }
  assert.deepEqual(failures, []);
});

test('按钮里不再嵌套按钮：日期选择器的「打开月历」与「手动输入」是并排的两个按钮', () => {
  const failures = [];
  for (const [file, ast, source] of sources) {
    visit(ast, (node) => {
      if (node.type !== 'JSXElement') return;
      const open = node.openingElement;
      if (open.name.name !== 'button' && open.name.name !== 'IconButton') return;
      visit({ children: node.children }, (inner) => {
        if (inner.type === 'JSXOpeningElement' && ['button', 'IconButton'].includes(inner.name.name))
          failures.push(`${file}: ${source.slice(...open.range).slice(0, 60)}`);
      });
    });
  }
  assert.deepEqual(failures, []);
  const dp = readFileSync(new URL('components/DatePicker.tsx', root), 'utf8');
  assert.doesNotMatch(dp, /role="button"/);
  // 进入输入模式沿用显示时的宽度，不跳宽
  assert.match(dp, /setEditWidth\(trigger\.current\?\.offsetWidth/);
  assert.match(dp, /style=\{editWidth \? \{ width: editWidth \} : undefined\}/);
});

test('修改密码：「至少 8 位」只出现在下方说明里，输入框不放占位提示', () => {
  const src = readFileSync(new URL('views/Security.tsx', root), 'utf8');
  const sheet = src.slice(src.indexOf('function PasswordSheet'));
  assert.doesNotMatch(sheet, /placeholder/);
  const locales = new URL('../../shared/locales/', root);
  for (const loc of readdirSync(locales, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    const sec = JSON.parse(readFileSync(new URL(`${loc}/settings.json`, locales), 'utf8')).security;
    assert.equal(sec.minLength, undefined, loc);
    assert.match(sec.passwordFoot, /8/, loc);
  }
});

test('手机上分组标题旁的文字操作保留点按区，但标题行与普通分组标题同高', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  assert.match(rulesFor('.group-title.with-action > .btn.plain'), /height:\s*auto/);
  assert.match(
    mediaRule(css, '@media (max-width: 860px)', '.group-title.with-action > .btn.plain'),
    /margin-block:\s*calc\(\(1lh - var\(--ctl-h-md\)\) \/ 2\)/,
  );
});

test('手机上「更多选项」的摘要折行读完，不用省略号截断', () => {
  const css = readFileSync(new URL('styles.css', root), 'utf8');
  const phone = mediaRule(css, '@media (max-width: 860px)', '.ed-more small');
  assert.match(phone, /white-space:\s*normal/);
  assert.match(phone, /text-overflow:\s*clip/);
});

test('弹窗里的支付方式弹层自己选方向并限高，翻上去也不盖住弹窗标题栏', () => {
  const pop = readFileSync(new URL('components/Pop.tsx', root), 'utf8');
  assert.match(pop, /closest\('\.sheet-dlg'\)\?\.querySelector\('\.sheet-head'\)/);
  assert.match(pop, /shouldFlip=\{!fit\}/);
  const mp = readFileSync(new URL('components/MethodPicker.tsx', root), 'utf8');
  assert.match(mp, /setFit\(fitBelowSheetHead\(btn\.current, 420\)\)/);
  assert.match(mp, /maxHeight=\{fit\?\.maxHeight\}/);
  assert.match(rulesFor('.pop-shell > .dp-pop.fit:not(.mobile)'), /max-height:\s*inherit/);
});

test('合租成员行的欠款缺汇率时写出原币部分，不悄悄少算', () => {
  const src = readFileSync(new URL('views/carpool/Members.tsx', root), 'utf8');
  assert.match(src, /formatTotal\(dueTotal\(state, d\), state\.settings\.baseCurrency\)/);
});

test('包在 label 里的日期选择器点空白处只开一次月历', () => {
  const src = readFileSync(new URL('components/DatePicker.tsx', root), 'utf8');
  assert.match(src, /if \(e\.target !== e\.currentTarget\) return;\s*\/\/[^\n]*\n\s*e\.preventDefault\(\);\s*toggle\(\);/);
});

test('扣款图的整价判断看全部扣款，不随所选范围变化', () => {
  const src = readFileSync(new URL('views/detail/ChargeTimeline.tsx', root), 'utf8');
  assert.match(src, /wholeCurrencies\(\s*\[\.\.\.reg, \.\.\.future\]/);
});

test('同一天合成的用量柱点开最后一条读数', () => {
  const src = readFileSync(new URL('views/detail/Meters.tsx', root), 'utf8');
  assert.match(src, /new Set\(idx\.map\(\(i\) => barDate\(trend\[i\]\)\)\)\.size === 1/);
});

test('时间线提示与柱图、说明提示同一套白底卡片，不再是深色块', () => {
  const css = readFileSync(new URL('components/timeline.css', root), 'utf8');
  const rule = css.match(/\.tl-tip \{[^}]*\}/)?.[0] ?? '';
  assert.match(rule, /background: var\(--card\)/);
  assert.match(rule, /box-shadow: var\(--shadow-lg\)/);
  assert.doesNotMatch(rule, /background: var\(--label\)/);
});

test('换方案时旧方案默认用到下一次扣款的前一天，不在扣款日再多扣一期', () => {
  const src = readFileSync(new URL('components/ChangePanel.tsx', root), 'utf8');
  assert.match(src, /addDays\(nextCharge\(last, addDays\(at, 2\)\) \?\? addMonths\(at, 1\), -1\)/);
});

test('#12 盈亏配色：金额语义色走 gain/loss，红盈绿亏时整体对调', () => {
  const tokens = readFileSync(new URL('../app/src/design-tokens.css', import.meta.url), 'utf8');
  assert.match(tokens, /--gain: var\(--green\);[\s\S]*--loss: var\(--red\);/);
  assert.match(
    tokens,
    /:root\[data-gain='red'\] \{\s*--gain: var\(--red\);\s*--gain-3: var\(--red-3\);\s*--loss: var\(--green\);\s*--loss-3: var\(--green-3\);/,
  );
  const pub = readFileSync(new URL('../app/src/public/index.css', import.meta.url), 'utf8');
  assert.match(pub, /--up: var\(--loss\);\s*--down: var\(--gain\);/);
  // 同一行的圆点、进度条、标签要和金额同色，否则红盈绿亏时一行两种颜色
  const styles = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  const detail = readFileSync(new URL('../app/src/views/detail.css', import.meta.url), 'utf8');
  for (const [css, rule] of [
    [styles, /\.log-dot\.up \{\s*background: var\(--loss\)/],
    [styles, /\.log-dot\.down \{\s*background: var\(--gain\)/],
    [styles, /\.stop-bar > i \{[^}]*background: var\(--loss\)/],
    [styles, /\.gt-unused-amount \{[^}]*color: var\(--loss\)/],
    [styles, /\.topup-rate em\.up \{\s*color: var\(--loss\)/],
    [styles, /\.topup-rate em\.down \{\s*color: var\(--gain\)/],
    [detail, /\.dt-kind\.refund,\s*\.dt-kind\.sell \{\s*background: var\(--gain-3\);\s*color: var\(--gain\)/],
    [detail, /\.dt-outcome\.lossy \{\s*background: color-mix\(in srgb, var\(--loss\)/],
  ])
    assert.match(css, rule);
  // 透支是状态色，不随涨跌配色对调
  assert.match(readFileSync(new URL('../app/src/views/Wallet.tsx', import.meta.url), 'utf8'), /balanceAfter < 0 \? 'var\(--red\)'/);
});

test('#12 公开页语言包加载失败仍渲染账本，不把分包错误显示给访客', () => {
  const page = readFileSync(new URL('../app/src/public/page.tsx', import.meta.url), 'utf8');
  assert.match(page, /await loadLocale\(preferredLocale\(body\.settings\.language\)\)\.catch\(\(\) => undefined\)/);
});

test('bars meet the axis with square bottoms and every forecast area uses the one hatch', () => {
  const tokens = readFileSync(new URL('design-tokens.css', root), 'utf8');
  const styles = readFileSync(new URL('styles.css', root), 'utf8');
  const detail = readFileSync(new URL('views/detail.css', root), 'utf8');
  const report = readFileSync(new URL('components/scope-report.css', root), 'utf8');
  const chart = readFileSync(new URL('views/DetailChart.tsx', root), 'utf8');
  const pub = readFileSync(new URL('public/page.tsx', root), 'utf8');
  const body = (css, sel) => cssRules(css).find(([s]) => s === sel)?.[1] ?? '';

  // SVG 柱与 HTML 柱同一比例、同一圆角，顶部圆、底部直角
  assert.match(tokens, /--bar-ratio:\s*50%/);
  assert.match(tokens, /--bar-max:\s*24px/);
  assert.match(tokens, /--bar-radius:\s*6px/);
  assert.match(readFileSync(new URL('components/charts.tsx', root), 'utf8'), /BAR = \{ ratio: 0\.5, max: 24, radius: 6 \}/);
  assert.match(body(styles, '.bl-col i'), /border-radius:\s*var\(--bar-radius\) var\(--bar-radius\) 0 0/);
  assert.match(body(styles, '.act-stack'), /border-radius:\s*var\(--bar-radius\) var\(--bar-radius\) 0 0/);
  assert.doesNotMatch(chart, /<rect\b[^>]*cc-bar/);
  assert.match(pub, /radius=\{\[radius, radius, 0, 0\]\}/);
  // Recharts 的 barCategoryGap 是每一侧的留白：25% 让柱子占格宽一半，50% 柱宽为 0、整张图没有柱子
  assert.match(pub, /barCategoryGap="25%"/);
  assert.match(body(styles, '.sy-col i'), /border-radius:\s*var\(--bar-radius\) var\(--bar-radius\) 0 0/);
  // 金额图、用量图同一条灰色平均线
  // 汇总后取各柱合计的均值画一条平线，不把每笔均值累加成台阶
  assert.match(chart, /bucket \? bucketRef : Math\.max/);
  assert.match(body(detail, '.cc-ref'), /stroke:\s*var\(--gray-9\)/);
  assert.match(readFileSync(new URL('views/detail/ChargeTimeline.tsx', root), 'utf8'), /ref: r\.future \? undefined : average/);

  // 预计的面状标记只有一种斜纹；虚线遮罩已退役，免收豁免不再用斜纹
  assert.doesNotMatch(tokens + styles + detail, /--unpaid-dash/);
  for (const [css, sel] of [
    [styles, '.gt-seg.planned'],
    [styles, '.gt-legend .lg-planned'],
    [styles, '.mt-seg.future'],
    [styles, '.rv-cell.upcoming'],
    [detail, '.dt-legend i.k-f'],
    [detail, '.cc-tip-r i.k-f'],
    [report, '.cal-mini-bars .forecast'],
  ])
    assert.match(body(css, sel), /var\(--unpaid-hatch\)/, sel);
  assert.doesNotMatch(body(detail, '.cc-bar.future'), /dasharray/);
  assert.match(pub, /url\(#pub-hatch\)/);
  for (const sel of ['.mt-seg.waived', '.rv-cell.waived,\n.rv-cell.free']) assert.doesNotMatch(body(styles, sel), /gradient/, sel);

  // 够宽才有纵轴，窄屏才有柱顶数值
  assert.match(chart, /\{!axis && peak >= 0 && \(/);
  const legend = readFileSync(new URL('views/detail/ChargeTimeline.tsx', root), 'utf8');
  assert.doesNotMatch(legend, /detail\.timeline\.paid/);
});

test('表单底栏压住内容里抬高的时间线圆点，手机上滚动时不从底栏露出', () => {
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  const layer = (selector) => Number(css.match(new RegExp(`${selector}\\s*\\{[^}]*z-index:\\s*(\\d+)`))?.[1] ?? 0);
  assert.ok(layer('\\.sheet-foot') > layer('\\.h-phase::before'));
});

test('标签和分段控件一行放不下时换行，控件不盖住标签；指标表单的类型不再占标签位', () => {
  const css = readFileSync(new URL('../app/src/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.cell:has\(> \.cell-r > \.seg\) \{ ?\s*flex-wrap: wrap;/);
  const meters = readFileSync(new URL('../app/src/views/detail/Meters.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(meters, /detail\.meters\.kindLabel/);
});

test('导入边界提示只在扣款记录为空时出现一次，指标卡不重复', () => {
  const detail = (file) => readFileSync(new URL(`../app/src/views/detail/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(detail('Kpis.tsx'), /settings\.import\.history/);
  assert.match(detail('Ledgers.tsx'), /sub\.estimateFrom && !history\.length && <p className="muted dt-import-note">/);
});

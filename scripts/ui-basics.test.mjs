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
  const block = css.slice(start, css.indexOf('.grabber', start));
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
  // Leading/trailing boundaries still need spacing when a conditional fact follows existing text.
  assert.match(renderToStaticMarkup(copyParts('\nNext charge Oct 28')), /<span><\/span><span>Next charge Oct 28<\/span>/);
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
  assert.match(css, /\.metric-grid > div > b:is\(\.done, \.gain, \.green\)\s*\{\s*color: var\(--green\)/);
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

test('table headers share one light header style without filled bands', () => {
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

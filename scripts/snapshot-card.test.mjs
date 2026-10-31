import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'oxc-transform-react';

class Element {
  children = [];
  style = {};
  attrs = new Map();
  parentElement = null;
  scrollLeft = 0;
  scrollTop = 0;
  width = 390;
  height = 240;
  className = '';
  nodeType = 1;
  childNodes = [];
  rects = [];
  scrollWidth = 0;
  clientWidth = 0;
  ownerDocument = {
    createRange: () => {
      let target;
      return { selectNodeContents: (node) => (target = node), getClientRects: () => target.rects };
    },
  };
  getClientRects() {
    return this.rects;
  }
  css = { backgroundColor: 'rgba(0, 0, 0, 0)', borderRadius: '0px', transform: 'none' };
  get attributes() {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }
  get offsetWidth() {
    return Number.parseFloat(this.style.width) || this.width;
  }
  get offsetHeight() {
    return this.height;
  }
  get isConnected() {
    return !this.removed && (!this.parentElement || this.parentElement.isConnected);
  }
  get classList() {
    return {
      add: (name) => {
        this.className += ` ${name}`;
      },
      contains: (name) => this.className.split(' ').includes(name),
    };
  }
  appendChild(child) {
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  querySelectorAll(selector) {
    const all = this.children.flatMap((child) => [child, ...child.querySelectorAll('*')]);
    return selector === '*' ? all : all.filter((node) => node.matches(selector));
  }
  cloneNode(deep) {
    const copy = Object.assign(new this.constructor(), this, {
      style: { ...this.style },
      attrs: new Map(this.attrs),
      parentElement: null,
      children: [],
      scrollLeft: 0,
      scrollTop: 0,
    });
    if (deep) this.children.forEach((child) => copy.appendChild(child.cloneNode(true)));
    return copy;
  }
  setAttribute(key, value) {
    this.attrs.set(key, value);
  }
  hasAttribute(key) {
    return this.attrs.has(key);
  }
  getAttribute(key) {
    return this.attrs.get(key) ?? null;
  }
  removeAttribute(key) {
    this.attrs.delete(key);
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      return part.startsWith('[') ? this.hasAttribute(part.slice(1, -1)) : part === 'img' ? this instanceof Image : this.classList.contains(part.slice(1));
    });
  }
  remove() {
    this.removed = true;
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
}
class Image extends Element {
  src = 'https://images.example.invalid/icon.png';
  decode() {
    return Promise.resolve();
  }
}

function harness(fail = false) {
  const source = readFileSync(new URL('../app/src/snapshot.ts', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  const compiled = transformSync('snapshot.ts', source, { lang: 'ts', reactCompiler: false });
  assert.equal(compiled.fatal, false);
  let captured;
  let frame;
  let disposed = 0;
  const document = {
    fonts: { ready: Promise.resolve() },
    documentElement: new Element(),
    body: new Element(),
    head: new Element(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => {
      frame = new Element();
      frame.contentDocument = { documentElement: new Element(), body: new Element(), head: new Element(), fonts: { ready: Promise.resolve() } };
      return frame;
    },
  };
  const deps = {
    Element,
    HTMLElement: Element,
    SVGElement: Element,
    HTMLImageElement: Image,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    requestAnimationFrame: (fn) => fn(),
    location: { origin: 'https://ledger.example.invalid' },
    base: (path) => path,
    document,
    getComputedStyle: (node) => ({ ...node.css, getPropertyValue: () => '#fcfcfc' }),
    renderSnapshotCharts: (_copies, clone) => ({
      clone,
      dispose() {
        disposed++;
      },
    }),
    toBlob: async (clone, options) => {
      captured = { clone, options };
      if (fail) throw new Error('render failed');
      return new Blob(['PNG']);
    },
  };
  const api = new Function(...Object.keys(deps), `${compiled.code.replace(/export /g, '')}; return { snapshot, snapshotCard, holdLines };`)(
    ...Object.values(deps),
  );
  return { ...api, document, frame: () => frame, capture: () => captured, disposed: () => disposed };
}

test('card PNG uses a desktop layout, preserves chart pan and proxies images without changing the page', async () => {
  const root = new Element();
  const control = root.appendChild(new Element());
  control.className = 'seg';
  const viewport = root.appendChild(new Element());
  viewport.scrollLeft = 420;
  const track = viewport.appendChild(new Element());
  track.css.transform = 'matrix(1, 0, 0, 1, 10, 0)';
  root.appendChild(new Image());
  const h = harness();
  assert.ok((await h.snapshotCard(root)) instanceof Blob);
  const { clone, options } = h.capture();
  assert.equal(options.width, 760);
  assert.equal(clone.style.height, 'auto');
  assert.equal(clone.style.borderRadius, 'var(--radius-lg)');
  assert.equal(clone.style.backgroundColor, '#fcfcfc');
  assert.equal(clone.children[0].children[0].style.transform, 'translate(-420px, 0px) matrix(1, 0, 0, 1, 10, 0)');
  assert.equal(viewport.scrollLeft, 420);
  assert.deepEqual(track.style, {}, 'the visible chart is never moved');
  assert.equal(clone.children[1].src, '/api/img?u=https%3A%2F%2Fimages.example.invalid%2Ficon.png');
  assert.equal(root.children.length, 3);
  assert.equal(h.frame().removed, true);
  assert.equal(h.disposed(), 1);
});

test('hidden notes/actions are removed before measurement and transfer explanations survive', async () => {
  const root = new Element();
  for (const cls of ['note', 'hint', 'action']) {
    const child = root.appendChild(new Element());
    child.className = cls;
    if (cls !== 'hint') child.setAttribute('data-snapshot-hide', '');
  }
  const transfer = root.appendChild(new Element());
  transfer.textContent = '从他人处收购';
  const h = harness();
  let prepared = false;
  await h.snapshot(root, {
    prepare: (clone) => {
      assert.equal(clone.children.length, 1);
      prepared = true;
    },
  });
  assert.equal(prepared, true);
  assert.equal(h.capture().clone.children[0].textContent, '从他人处收购');
  assert.equal(root.children.length, 4);
});

test('desktop and phone sources export at the same width, retaining named ancestors and theme', async () => {
  for (const width of [390, 1280]) {
    const h = harness();
    h.document.documentElement.setAttribute('data-theme', 'dark');
    const sheet = h.document.body.appendChild(new Element());
    sheet.className = 'sheet bare';
    const root = sheet.appendChild(new Element());
    root.width = width;
    await h.snapshot(root);
    assert.equal(h.capture().options.width, 760);
    assert.equal(h.capture().clone.parentElement.className, 'sheet bare');
    assert.equal(h.frame().contentDocument.documentElement.getAttribute('data-theme'), 'dark');
    assert.equal(h.frame().style.width, '1280px');
    assert.equal(h.frame().removed, true);
    assert.equal(h.disposed(), 1);
  }
});

test('failed rendering removes its isolated document and leaves the source alone', async () => {
  const source = new Element();
  const h = harness(true);
  await assert.rejects(h.snapshotCard(source), /render failed/);
  assert.equal(h.frame().removed, true);
  assert.equal(h.disposed(), 1);
  assert.equal(source.removed, undefined);
});

test('text that fits one line on the page cannot wrap or gain an ellipsis when the image re-lays out its glyphs', () => {
  const line = (top, height = 18) => ({ top, bottom: top + height });
  const text = (textContent, ...rects) => ({ nodeType: 3, textContent, rects });
  const inline = (...rects) => Object.assign(new Element(), { rects, css: { display: 'inline' } });
  const block = (whiteSpace) => Object.assign(new Element(), { css: { display: 'block', whiteSpace } });
  const root = new Element();
  // 「10月28日 到期不续」：日期、行内标记、说明在同一行，导出时字宽稍大也不能把「续」挤到下一行
  const meta = root.appendChild(new Element());
  meta.childNodes = [text('10月28日 ', line(0)), inline(line(1)), text(' 到期不续', line(0))];
  const wrapped = root.appendChild(new Element());
  wrapped.childNodes = [text('一段在页面上本来就折成两行的说明', line(0), line(20))];
  // 先放一个高图标，再放折成两行的文字：两行都与图标重叠，但文字本身不是一行
  const iconFirst = root.appendChild(new Element());
  iconFirst.childNodes = [inline(line(0, 40)), text('Long label that wraps', line(2), line(22))];
  // 行内子元素落到第二行：整段不是一行
  const spill = root.appendChild(new Element());
  spill.childNodes = [text('Hello ', line(0)), inline(line(20))];
  // 短文字 + 多行块级子块：父级锁一行，子块写回原本的 white-space，不继承 nowrap
  const mixed = root.appendChild(new Element());
  const sub = mixed.appendChild(block('normal'));
  mixed.childNodes = [text('标题', line(10)), sub];
  const name = root.appendChild(new Element());
  name.childNodes = [text('Surge Mac', line(0))];
  name.css = { ...name.css, textOverflow: 'ellipsis' };
  name.scrollWidth = name.clientWidth = 80;
  const cut = root.appendChild(new Element());
  cut.childNodes = [text('A very long subscription name', line(0))];
  cut.css = { ...cut.css, textOverflow: 'ellipsis' };
  cut.scrollWidth = 200;
  cut.clientWidth = 80;
  const box = root.appendChild(new Element());
  box.childNodes = [new Element()];
  harness().holdLines(root);
  assert.equal(meta.style.whiteSpace, 'nowrap');
  assert.equal(wrapped.style.whiteSpace, undefined);
  assert.equal(iconFirst.style.whiteSpace, undefined, 'a tall leading icon does not make wrapped text count as one line');
  assert.equal(spill.style.whiteSpace, undefined);
  assert.equal(mixed.style.whiteSpace, 'nowrap');
  assert.equal(sub.style.whiteSpace, 'normal', 'block children keep their own wrapping');
  assert.deepEqual([name.style.textOverflow, name.style.overflow], ['clip', 'visible']);
  assert.equal(cut.style.textOverflow, undefined, 'names already shortened on the page keep their ellipsis');
  assert.deepEqual(box.style, {});
});

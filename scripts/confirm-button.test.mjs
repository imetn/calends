import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'oxc-transform-react';

function driver() {
  const source = readFileSync(new URL('../app/src/components/ConfirmButton.tsx', import.meta.url), 'utf8').replace(/^import[\s\S]*?;\n/gm, '');
  const result = transformSync('ConfirmButton.tsx', source, { lang: 'tsx', jsx: { runtime: 'classic' }, reactCompiler: false });
  assert.equal(result.fatal, false);
  let armed = false;
  let previous;
  let cleanup;
  let timer;
  let delay;
  let calls = 0;
  let now = 0;
  const ref = { current: 0 };
  const deps = {
    React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    CircleHelp: 'CircleHelp',
    t: (key) => key,
    useState: () => [armed, (value) => (armed = value)],
    useRef: () => ref,
    Date: { now: () => now },
    useEffect(effect, [value]) {
      if (previous === value) return;
      cleanup?.();
      previous = value;
      cleanup = effect();
    },
    setTimeout(fn, ms) {
      timer = fn;
      delay = ms;
      return 1;
    },
    clearTimeout() {
      timer = undefined;
    },
  };
  const ConfirmButton = new Function(...Object.keys(deps), `${result.code.replace(/export /g, '')}; return ConfirmButton;`)(...Object.values(deps));
  return {
    render: (props = {}) => ConfirmButton({ children: 'Remove', hint: 'Fictional consequence', onConfirm: () => calls++, ...props }).props,
    calls: () => calls,
    wait: (ms) => (now += ms),
    timeout() {
      assert.equal(delay, 4000);
      assert.equal(typeof timer, 'function');
      timer();
    },
  };
}

test('capsule exposes its consequence only while armed; Escape consumes the key and preserves the surrounding dialog', () => {
  const d = driver();
  assert.equal(d.render().type, 'button');
  assert.equal(d.render().title, undefined);
  d.render().onClick();
  assert.equal(d.calls(), 0);
  assert.equal(d.render().title, 'Fictional consequence');
  assert.match(d.render()['aria-label'], /Fictional consequence/);
  let stopped = 0;
  d.render().onKeyDown({ key: 'Escape', stopPropagation: () => stopped++ });
  assert.equal(stopped, 1);
  assert.equal(d.render().title, undefined);
  d.render().onKeyDown({ key: 'Escape', stopPropagation: () => stopped++ });
  assert.equal(stopped, 1, 'unarmed Escape remains available to the surrounding dialog');
  assert.equal(d.calls(), 0);
});

test('blur and four seconds cancel confirmation; only a second click within the armed state executes', () => {
  const d = driver();
  d.render().onClick();
  d.render().onBlur();
  assert.equal(d.render().title, undefined);
  d.render().onClick();
  d.render();
  d.timeout();
  assert.equal(d.render().title, undefined);
  assert.equal(d.calls(), 0);
  d.render().onClick();
  d.wait(600);
  d.render().onClick();
  assert.equal(d.calls(), 1);
  assert.equal(d.render().title, undefined);
  assert.equal(d.render({ disabled: true }).disabled, true);
});

test('手滑双击不会删除：进入确认态 600ms 内的第二次点击被忽略，确认态保留，之后再点才执行', () => {
  const d = driver();
  d.render().onClick();
  d.wait(250);
  d.render().onClick();
  assert.equal(d.calls(), 0);
  assert.equal(d.render().title, 'Fictional consequence', 'still armed after the ignored click');
  d.wait(349);
  d.render().onClick();
  assert.equal(d.calls(), 0);
  d.wait(1);
  d.render().onClick();
  assert.equal(d.calls(), 1);
});

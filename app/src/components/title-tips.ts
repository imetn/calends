import './title-tips.css';
import { tooltipPosition } from './tooltip-position.ts';

const DELAY = 300;

/**
 * 全站接管 title：鼠标悬停或键盘聚焦时显示自绘提示，不出现系统提示框。
 * 显示期间把 title 置空，离开时放回：空 title 不弹系统提示，也挡住外层元素的 title；
 * 属性还在，组件之后改或删它都观察得到，组件照常写 title 即可。
 */
export function installTitleTips() {
  const tip = document.createElement('div');
  tip.className = 'info-tip title-tip';
  tip.setAttribute('role', 'tooltip');
  let owner: Element | null = null;
  let via: 'pointer' | 'focus' = 'pointer';
  let hover: Element | null = null;
  let text = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  const place = () => {
    if (!owner) return;
    tip.textContent = text;
    document.body.appendChild(tip);
    const a = owner.getBoundingClientRect();
    const { left, top } = tooltipPosition(
      { x: a.left + a.width / 2, top: a.top, bottom: a.bottom },
      { width: tip.offsetWidth, height: tip.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };
  // 只收起提示、不放回 title：指针还在元素上，放回去系统提示会接着弹
  const dismiss = () => {
    clearTimeout(timer);
    tip.remove();
  };
  // 最近的 title 说了算，和浏览器的规则一样；iframe 的事件进了子文档，接管了就收不回来
  const titled = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return null;
    const el = target.closest('[title]');
    return el && el.tagName !== 'IFRAME' && (el === owner || el.getAttribute('title')) ? el : null;
  };
  const release = () => {
    dismiss();
    // 还是空的才放回；组件已经改掉或删掉，就以组件为准
    if (owner?.getAttribute('title') === '') owner.setAttribute('title', text);
    owner?.removeAttribute('aria-description');
    owner = null;
  };
  const take = (el: Element, from: typeof via) => {
    release();
    owner = el;
    via = from;
    text = el.getAttribute('title') ?? '';
    el.setAttribute('title', '');
    // title 空着时读屏读不到这段说明，由它代读
    el.setAttribute('aria-description', text);
    timer = setTimeout(() => {
      if (owner?.isConnected) place();
    }, DELAY);
  };
  // 组件改了 title（主题按钮换文案、确认按钮进入确认态又退出）：显示中的提示跟着变，新出现的接管，删掉的收起
  const sync = () => {
    if (hover && !hover.isConnected) hover = null;
    // 元素被卸载（点返回、点移除）不一定有 focusout，提示不能留在新页面上
    const current = owner?.isConnected ? owner.getAttribute('title') : null;
    if (owner && current === null) {
      dismiss();
      owner.removeAttribute('aria-description');
      owner = null;
    } else if (current) {
      text = current;
      owner?.setAttribute('title', '');
      owner?.setAttribute('aria-description', text);
      if (tip.isConnected) place();
    }
    const el = titled(hover);
    if (el && el !== owner) take(el, 'pointer');
  };
  new MutationObserver(sync).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    hover = e.target instanceof Element ? e.target : null;
    const el = titled(hover);
    if (el && el !== owner) take(el, 'pointer');
    else if (!el && via === 'pointer') release();
  });
  document.documentElement.addEventListener('pointerleave', () => {
    hover = null;
    if (via === 'pointer') release();
  });
  document.addEventListener('focusin', (e) => {
    const el = titled(e.target);
    // 指针正停在某个元素上时不抢：放回它的 title，系统提示会弹出来
    if (el && el !== owner && !(owner && via === 'pointer') && e.target instanceof Element && e.target.matches(':focus-visible')) take(el, 'focus');
  });
  document.addEventListener('focusout', () => via === 'focus' && release());
  document.addEventListener('pointerdown', dismiss, true);
  // 只有带着这个元素一起滚才收起：时间线等区域自己滚动时，不打断别处的提示
  document.addEventListener(
    'scroll',
    (e) => {
      if (owner && e.target instanceof Node && e.target.contains(owner)) dismiss();
    },
    true,
  );
  document.addEventListener('keydown', (e) => e.key === 'Escape' && dismiss());
}

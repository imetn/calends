import { toBlob } from 'html-to-image';
import { t } from '../../shared/i18n.ts';
import { base } from './base.ts';
import { renderSnapshotCharts } from './snapshot-render.tsx';
import './components/copy.css';

// 截图在独立的 SVG 里渲染，用不到页面加载的字体：把 data-font 样式表里的字体转成 data URL 内嵌（只取一次）
let fonts: Promise<string> | undefined;
async function inlineFonts(href: string): Promise<string> {
  const css = await (await fetch(href)).text();
  const urls = [...new Set([...css.matchAll(/url\(['"]?([^'")]+)['"]?\)/g)].map((m) => m[1]))];
  const data = await Promise.all(
    urls.map(async (u) => {
      const b = await (await fetch(new URL(u, href))).blob();
      return new Promise<string>((r) => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result as string);
        fr.readAsDataURL(b);
      });
    }),
  );
  return urls.reduce((s, u, i) => s.replaceAll(u, data[i]), css);
}
function fontCSS(): Promise<string> {
  fonts ??= Promise.all(
    [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][data-font]')].map((l) => inlineFonts(l.href).catch(() => '')),
  ).then((css) => css.join('\n'));
  return fonts;
}

// SVG descendants retain their stylesheet paint when embedded in a standalone image.
const SVG_PROPS = ['stroke', 'fill', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'fill-opacity', 'opacity', 'stop-color', 'stop-opacity'];
function inlineSvg(el: HTMLElement) {
  el.querySelectorAll('svg *').forEach((n) => {
    const cs = getComputedStyle(n);
    for (const p of SVG_PROPS) {
      n.setAttribute(p, cs.getPropertyValue(p));
    }
  });
}

/**
 * 导出图在 SVG 里重新排字，字形宽度与页面量出的冻结宽度稍有出入，就会多折一行或冒出省略号。
 * 页面上排成一行的文字锁定不折行；页面上没被截断的省略号文字改为不截断。
 * 「一行」只看直属文字和行内子元素的矩形，以第一段文字为准，图标和块级子元素不算；
 * 块级子元素写回原本的 white-space，不让 nowrap 继承下去。先全部量完再统一写，避免逐个触发重排。
 */
export function holdLines(root: HTMLElement) {
  const range = root.ownerDocument.createRange();
  const hasText = (c: ChildNode) => c.nodeType === Node.TEXT_NODE && !!c.textContent?.trim();
  const plans = [...root.querySelectorAll<HTMLElement>('*')].flatMap((node) => {
    if (![...node.childNodes].some(hasText)) return [];
    let line: DOMRect | undefined;
    const rects = [...node.childNodes].flatMap((c) => {
      if (hasText(c)) {
        range.selectNodeContents(c);
        const r = [...range.getClientRects()];
        line ??= r[0];
        return r;
      }
      return c.nodeType === Node.ELEMENT_NODE && getComputedStyle(c as Element).display.startsWith('inline') ? [...(c as Element).getClientRects()] : [];
    });
    const hold = !!line && rects.every((r) => r.top < line!.bottom && r.bottom > line!.top);
    const style = getComputedStyle(node);
    const blocks = hold
      ? [...(node.children as HTMLCollectionOf<HTMLElement>)].flatMap((c) => {
          const cs = getComputedStyle(c);
          return cs.display.startsWith('inline') ? [] : [[c, cs.whiteSpace] as const];
        })
      : [];
    return [{ node, hold, blocks, unclip: style.textOverflow === 'ellipsis' && node.scrollWidth <= node.clientWidth }];
  });
  for (const { blocks } of plans) for (const [c, ws] of blocks) c.style.whiteSpace ||= ws;
  for (const { node, hold, unclip } of plans) {
    if (hold) node.style.whiteSpace = 'nowrap';
    if (unclip) {
      node.style.textOverflow = 'clip';
      node.style.overflow = 'visible';
    }
  }
}

/** Desktop detail width; independent of the caller's viewport and disclosure controls. */
export const SNAPSHOT_WIDTH = 760;

/** Card exports drop every control; content rendered as a button opts back in with data-snapshot-keep. */
const CONTROLS = 'button, [role="button"], .btn, .icon-btn, .seg, details';
/** Rows kept from a data-snapshot-list before the remainder collapses into one muted line. */
export const SNAPSHOT_LIST_ROWS = 5;

/** Cap marked lists: data-snapshot-list may name the row selector, data-snapshot-total the full count. */
function capLists(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>('[data-snapshot-list]').forEach((list) => {
    // A bare JSX attribute renders as "true": every child is a row.
    const selector = list.dataset.snapshotList;
    const children = [...list.children];
    const rows = selector && selector !== 'true' ? children.filter((child) => child.matches(selector)) : children;
    const kept = Math.min(rows.length, SNAPSHOT_LIST_ROWS);
    const rest = Math.max(rows.length, Number(list.dataset.snapshotTotal) || 0) - kept;
    if (rest <= 0 || !kept) return;
    children.slice(children.indexOf(rows[kept - 1]) + 1).forEach((child) => child.remove());
    const more = list.ownerDocument.createElement('p');
    more.className = 'snapshot-more';
    more.textContent = t('detail.snapshotRest', { count: rest });
    list.insertAdjacentElement('afterend', more);
  });
}

type SnapshotOptions = {
  /** Card export: single column, no controls, long lists capped. */
  card?: boolean;
  radius?: string;
  width?: number;
  pixelRatio?: number;
  style?: Partial<CSSStyleDeclaration>;
  filter?: (n: HTMLElement) => boolean;
  prepare?: (clone: HTMLElement, copies: ReadonlyMap<Element, HTMLElement>) => void;
};

/** Lay out a private copy before html-to-image freezes computed widths and heights. */
export async function snapshot(el: HTMLElement, opts: SnapshotOptions = {}) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  Object.assign(frame.style, { position: 'fixed', left: '-100000px', top: '0', width: '1280px', height: '900px', borderWidth: '0', pointerEvents: 'none' });
  document.body.appendChild(frame);
  let disposeCharts: (() => void) | undefined;
  try {
    const doc = frame.contentDocument!;
    for (const attr of document.documentElement.attributes) doc.documentElement.setAttribute(attr.name, attr.value);
    for (const attr of document.body.attributes) doc.body.setAttribute(attr.name, attr.value);
    if (opts.card) doc.documentElement.setAttribute('data-snapshot', 'card');
    // Keep media queries desktop-sized and named ancestor containers intact. Only the
    // copied wrappers lose their page positioning, padding and viewport height caps.
    const styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((node) => {
      const copy = node.cloneNode(true) as HTMLLinkElement;
      const ready =
        copy.tagName === 'LINK'
          ? new Promise<void>((resolve, reject) => {
              copy.onload = () => resolve();
              copy.onerror = () => reject(new Error('Snapshot stylesheet'));
            })
          : Promise.resolve();
      doc.head.appendChild(copy);
      return ready;
    });
    const ancestors: HTMLElement[] = [];
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) ancestors.unshift(node);
    Object.assign(doc.body.style, { margin: '0', padding: '0', width: `${opts.width ?? SNAPSHOT_WIDTH}px` });
    let parent = doc.body;
    for (const node of ancestors) {
      const wrapper = node.cloneNode(false) as HTMLElement;
      Object.assign(wrapper.style, {
        position: 'static',
        display: 'block',
        width: '100%',
        minWidth: '0',
        maxWidth: 'none',
        height: 'auto',
        minHeight: '0',
        maxHeight: 'none',
        overflow: 'visible',
        margin: '0',
        padding: '0',
        transform: 'none',
      });
      parent.appendChild(wrapper);
      parent = wrapper;
    }
    let clone = el.cloneNode(true) as HTMLElement;
    const originals = [el, ...el.querySelectorAll('*')];
    const copied = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
    const copies = new Map(originals.map((node, i) => [node, copied[i]]));
    const exportStyle: Partial<CSSStyleDeclaration> = {
      position: 'static',
      width: `${opts.width ?? SNAPSHOT_WIDTH}px`,
      maxWidth: 'none',
      height: 'auto',
      maxHeight: 'none',
      margin: '0',
      boxSizing: 'border-box',
      borderRadius: opts.radius ?? '0',
      overflow: 'hidden',
      animation: 'none',
      transition: 'none',
      ...opts.style,
    };
    Object.assign(clone.style, exportStyle);
    parent.appendChild(clone);
    await Promise.all(styles);
    const rendered = renderSnapshotCharts(copies, clone);
    clone = rendered.clone;
    disposeCharts = rendered.dispose;
    Object.assign(clone.style, exportStyle);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const allowed = (node: HTMLElement) =>
      !node.hasAttribute('data-snapshot-hide') &&
      !node.matches('.hint') &&
      !(opts.card && node.matches(CONTROLS) && !node.hasAttribute('data-snapshot-keep')) &&
      (opts.filter?.(node) ?? true);
    // Remove before measuring, so notes and action rows leave no reserved space.
    clone.querySelectorAll<HTMLElement>('*').forEach((node) => {
      if (!allowed(node)) node.remove();
      else {
        node.style.animation = 'none';
        node.style.transition = 'none';
      }
    });
    if (opts.card) capLists(clone);
    const images = [...clone.querySelectorAll<HTMLImageElement>('img')];
    images.forEach((image) => {
      image.loading = 'eager';
      if (/^https?:/.test(image.src) && new URL(image.src).origin !== location.origin) {
        image.src = base(`/api/img?u=${encodeURIComponent(image.src)}`);
        image.removeAttribute('srcset');
      }
    });
    // Flush stylesheet layout so FontFaceSet tracks the faces actually in use.
    void clone.offsetWidth;
    await doc.fonts.ready;
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
    opts.prepare?.(clone, copies);
    holdLines(clone);
    const fontEmbedCSS = await fontCSS();
    inlineSvg(clone);
    return await toBlob(clone, {
      pixelRatio: opts.pixelRatio ?? 2,
      fontEmbedCSS,
      cacheBust: false,
      includeQueryParams: true,
      width: clone.offsetWidth,
      height: clone.offsetHeight,
    });
  } finally {
    try {
      disposeCharts?.();
    } finally {
      frame.remove();
    }
  }
}

/** Capture a desktop card, retaining the selected chart viewport without touching it. */
export async function snapshotCard(source: HTMLElement) {
  const style = getComputedStyle(source);
  const sourceNodes = [source, ...source.querySelectorAll<HTMLElement>('*')];
  return snapshot(source, {
    card: true,
    radius: style.borderRadius === '0px' ? 'var(--radius-lg)' : style.borderRadius,
    style: { backgroundColor: style.backgroundColor === 'rgba(0, 0, 0, 0)' ? style.getPropertyValue('--bg') : style.backgroundColor },
    prepare: (_clone, copies) => {
      sourceNodes.forEach((node) => {
        const copy = copies.get(node);
        if (!copy?.isConnected || (!node.scrollLeft && !node.scrollTop)) return;
        copy.style.overflow = 'hidden';
        [...node.children].forEach((child) => {
          const target = copies.get(child);
          if (!target?.isConnected) return;
          const transform = getComputedStyle(child).transform;
          target.style.transform = `translate(${-node.scrollLeft}px, ${-node.scrollTop}px) ${transform === 'none' ? '' : transform}`;
        });
      });
    },
    filter: (node) => !node.matches('.tl-home, .log-actions, .copy-controls > :not(.copy-hover)'),
  });
}

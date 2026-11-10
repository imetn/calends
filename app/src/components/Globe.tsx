import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { COUNTRY_POINTS } from './country-points.ts';
import { LAND_MASK } from './globe-land.ts';
import { FlagImg } from './marks.tsx';

export interface GlobePoint {
  cc: string;
  /** 0–1，决定标记大小 */
  weight: number;
  /** 标在标记上方的短文字（如占比），旁边带国旗；背面时隐藏 */
  tag?: string;
}

/** 球面上均匀分布的点数（斐波那契球）；陆地点深、海洋点浅 */
const DOTS = 16000;
const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
/** 让 (lat, lng) 转到正中的视角 */
const toView = (lat: number, lng: number) => ({ phi: -lng * RAD, theta: lat * RAD });
/** 把 a 调到离 b 最近的同角度，转动时走短路 */
const near = (a: number, b: number) => a + Math.round((b - a) / TAU) * TAU;
const clampTheta = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/** 斐波那契球上的点，按陆地掩膜分成陆地、海洋两组；每组是 [lat, lng] 弧度对 */
let dotsCache: Promise<{ land: Float32Array; sea: Float32Array }> | undefined;
function loadDots() {
  dotsCache ??= new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, c.width, c.height).data;
      const land: number[] = [];
      const sea: number[] = [];
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < DOTS; i++) {
        const y = 1 - (2 * (i + 0.5)) / DOTS;
        const lat = Math.asin(y);
        const lng = ((((i * golden) % TAU) + TAU) % TAU) - Math.PI;
        const u = Math.min(c.width - 1, Math.floor(((lng / RAD + 180) / 360) * c.width));
        const v = Math.min(c.height - 1, Math.floor((0.5 - lat / Math.PI) * c.height));
        (px[(v * c.width + u) * 4] > 127 ? land : sea).push(lat, lng);
      }
      resolve({ land: new Float32Array(land), sea: new Float32Array(sea) });
    };
    img.onerror = reject;
    img.src = LAND_MASK;
  });
  return dotsCache;
}

/**
 * 点阵地球：平面单色，颜色跟随所在元素的文字色（暗色模式自动反过来）；
 * 可拖动旋转，focus 变化时转到那个国家，空闲时缓慢自转（减少动态效果时不转）
 */
export function Globe({ points, focus, label, className = 'globe-canvas' }: { points: GlobePoint[]; focus?: string; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, HTMLElement>());
  const live = useRef({ points, focus, kick: () => {} });
  live.current = { ...live.current, points, focus };
  // 静止时循环已停，focus 或数据变了要重新画
  useEffect(() => live.current.kick(), [points, focus]);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const first = points.find((p) => COUNTRY_POINTS[p.cc]);
    const start = first ? toView(...COUNTRY_POINTS[first.cc]) : { phi: 0, theta: 0.3 };
    const view = { phi: start.phi, theta: clampTheta(start.theta, 0.6) };
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let alive = true;
    let raf = 0;
    let visible = true;
    let drag: { x: number; y: number; phi: number; theta: number } | undefined;
    let dots: { land: Float32Array; sea: Float32Array } | undefined;
    let ink = '0,0,0';
    let size = 0;

    const draw = () => {
      const r = size / 2 - 1;
      const c = size / 2;
      const sp = Math.sin(view.phi);
      const cp = Math.cos(view.phi);
      const st = Math.sin(view.theta);
      const ct = Math.cos(view.theta);
      // 经纬度 → 屏幕；z ≤ 0 在背面
      const project = (lat: number, lng: number) => {
        const cl = Math.cos(lat);
        const x0 = cl * Math.sin(lng);
        const z0 = cl * Math.cos(lng);
        const x = x0 * cp + z0 * sp;
        const z1 = z0 * cp - x0 * sp;
        const y0 = Math.sin(lat);
        return { x: c + x * r, y: c - (y0 * ct - z1 * st) * r, z: y0 * st + z1 * ct };
      };
      ctx.clearRect(0, 0, size, size);
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TAU);
      ctx.fillStyle = `rgba(${ink},0.03)`;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = `rgba(${ink},0.1)`;
      ctx.stroke();
      if (dots) {
        const dot = Math.max(0.55, r * 0.0058);
        for (const [set, alpha] of [
          [dots.sea, 0.06],
          [dots.land, 0.5],
        ] as const) {
          ctx.beginPath();
          for (let i = 0; i < set.length; i += 2) {
            const p = project(set[i], set[i + 1]);
            if (p.z <= 0) continue;
            ctx.moveTo(p.x + dot, p.y);
            ctx.arc(p.x, p.y, dot, 0, TAU);
          }
          ctx.fillStyle = `rgba(${ink},${alpha})`;
          ctx.fill();
        }
      }
      const { points: ps, focus: f } = live.current;
      for (const p of ps) {
        const at = COUNTRY_POINTS[p.cc];
        if (!at) continue;
        const q = project(at[0] * RAD, at[1] * RAD);
        const m = r * (0.018 + 0.03 * Math.sqrt(p.weight));
        const tag = tags.current.get(p.cc);
        if (tag) {
          // 转到边缘时淡出，背面隐藏
          tag.style.opacity = String(Math.max(0, Math.min(1, (q.z - 0.2) / 0.25)));
          tag.style.transform = `translate(${q.x}px, ${q.y - m - 3}px) translate(-50%, -100%)`;
        }
        if (q.z <= 0.05) continue;
        ctx.beginPath();
        ctx.arc(q.x, q.y, m, 0, TAU);
        ctx.fillStyle = `rgba(${ink},0.85)`;
        ctx.fill();
        if (p.cc === f) {
          ctx.beginPath();
          ctx.arc(q.x, q.y, m + Math.max(3, r * 0.025), 0, TAU);
          ctx.lineWidth = 1.25;
          ctx.strokeStyle = `rgba(${ink},0.6)`;
          ctx.stroke();
        }
      }
    };

    const frame = () => {
      raf = 0;
      if (!alive || !visible || !size) return;
      const { focus: f } = live.current;
      const at = f ? COUNTRY_POINTS[f] : undefined;
      // 静止：减少动态效果且没有目标，或已转到目标；画完这一帧就停，等拖动、focus 或数据变化再 kick
      let idle = false;
      if (drag) {
        // 拖动中：跟手
      } else if (at) {
        const t = toView(...at);
        const phi = near(t.phi, view.phi);
        const theta = clampTheta(t.theta, 0.6);
        view.phi += (phi - view.phi) * (still ? 1 : 0.08);
        view.theta += (theta - view.theta) * (still ? 1 : 0.08);
        idle = Math.abs(phi - view.phi) < 1e-3 && Math.abs(theta - view.theta) < 1e-3;
      } else if (!still) {
        view.phi -= 0.0025;
      } else {
        idle = true;
      }
      draw();
      if (!idle || drag) raf = requestAnimationFrame(frame);
    };
    const kick = () => {
      if (!raf && alive) raf = requestAnimationFrame(frame);
    };
    live.current.kick = kick;

    const recolor = () => {
      const m = getComputedStyle(canvas).color.match(/\d+(\.\d+)?/g);
      ink = m ? m.slice(0, 3).join(',') : '0,0,0';
      kick();
    };
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      size = canvas.clientWidth;
      canvas.width = canvas.height = Math.round(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      kick();
    };
    void loadDots().then((d) => {
      dots = d;
      kick();
    });
    recolor();
    resize();

    // 主题切换（类名、data-theme 或系统深浅色）后重新取色
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', recolor);
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    // 滚出视野就停
    const io = new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) kick();
    });
    io.observe(canvas);

    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, phi: view.phi, theta: view.theta };
      canvas.setPointerCapture(e.pointerId);
      kick();
    };
    const move = (e: PointerEvent) => {
      if (!drag) return;
      const k = (Math.PI / canvas.clientWidth) * 1.2;
      view.phi = drag.phi + (e.clientX - drag.x) * k;
      view.theta = clampTheta(drag.theta + (e.clientY - drag.y) * k, 0.8);
      kick();
    };
    const up = () => {
      drag = undefined;
      kick();
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      live.current.kick = () => {};
      mo.disconnect();
      ro.disconnect();
      io.disconnect();
      mq.removeEventListener('change', recolor);
      canvas.removeEventListener('pointerdown', down);
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
    };
    // 只在挂载时建一次；points、focus 走 live 引用
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 外层始终保留：结构不变，画布才不会被换掉（绘制只绑在挂载时的那块画布上）
  const tagged = points.filter((p) => p.tag && COUNTRY_POINTS[p.cc]);
  return (
    <div className="globe-wrap">
      <canvas ref={ref} className={className} role="img" aria-label={label} />
      {tagged.map((p) => (
        <span
          key={p.cc}
          className="globe-tag"
          aria-hidden="true"
          ref={(el) => {
            if (el) tags.current.set(p.cc, el);
            else tags.current.delete(p.cc);
          }}
        >
          <FlagImg cc={p.cc} />
          <b className="num">{p.tag}</b>
        </span>
      ))}
    </div>
  );
}

/**
 * 地区列表与地球联动：鼠标悬停、键盘聚焦、点按都会转到那一行；
 * 触屏没有移出事件，再点一次同一行才放开
 */
export function useGlobeFocus() {
  const [focus, setFocus] = useState<string>();
  const was = useRef<string | undefined>(undefined);
  const mouse = (e: ReactPointerEvent) => e.pointerType === 'mouse';
  return {
    focus,
    list: { onPointerLeave: (e: ReactPointerEvent) => mouse(e) && setFocus(undefined) },
    row: (cc: string) => ({
      onPointerEnter: (e: ReactPointerEvent) => mouse(e) && setFocus(cc),
      onPointerDown: (e: ReactPointerEvent) => {
        was.current = mouse(e) ? undefined : focus;
      },
      onFocus: (e: { currentTarget: HTMLElement }) => e.currentTarget.matches(':focus-visible') && setFocus(cc),
      onClick: () => {
        setFocus(was.current === cc ? undefined : cc);
        was.current = undefined;
      },
    }),
  };
}

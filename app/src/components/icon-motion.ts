// Kubai Icons line-style SVG markup & damped-spring motion runtime (MIT License, Copyright Kubai087).
// Supports 4 icon states: outline rest, outline hover motion, solid fill rest, and solid fill click/hover motion.

export interface LineCut {
  d: string;
  w: number;
}

export interface LineLayer {
  d: string;
  k?: string;
  key: string;
  part?: string;
  on?: string;
  gap?: boolean;
  occ?: boolean;
  cutD?: string;
  cut?: LineCut;
  tf?: string;
  sc?: number;
  cap?: string;
  ghost?: boolean;
  vc?: number;
}

export interface LineSnapshot {
  o: LineLayer[];
  f: LineLayer[];
}

export interface LineEffectSpec {
  t: string;
  on?: string | Array<string | string[]>;
  by?: boolean;
  stagger?: number;
  amp?: number;
  dir?: string;
  delay?: number;
  hz?: number;
  z?: number;
  deg?: number;
  dip?: number;
  ms?: number;
  x?: number | number[];
  y?: number | number[];
  r?: number | number[];
  s?: number | number[];
  sx?: number | number[];
  sy?: number | number[];
  gx?: number | number[];
  gy?: number | number[];
  a?: number | number[];
  ghost?: boolean;
  turns?: number;
  R?: number;
  step?: number;
  mode?: string;
  at?: number[];
  edge?: [number, number];
  axis?: string;
  hold?: number;
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  o?: [number, number];
  oBadge?: boolean;
  fill?: Partial<LineEffectSpec>;
}

export type LineFx = LineEffectSpec | LineEffectSpec[];

export interface KubaiLineDef {
  w: LineSnapshot;
  fx?: LineFx;
  /** True when native `w.f` fills a closed silhouette cleanly; false uses SF-style solid squircle knockout. */
  nf: boolean;
}

export interface IconMotionController {
  playOnce: () => void;
  hover: (on: boolean) => void;
  destroy: () => void;
}

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const round = (v: number) => +v.toFixed(3);
const gapOf = (s: number) => round(0.5 * s + 0.75);

let uidSeq = 0;
export function nextIconId(): string {
  uidSeq += 1;
  return `ki${uidSeq.toString(36)}`;
}

/** Builds inner SVG markup for Kubai line `outline` or `fill` variant (monochrome `currentColor`). */
function buildLineInner(snap: LineSnapshot, s: number, fill: boolean, id: string): string {
  const layers = fill ? snap.f : snap.o;
  const byName: Record<string, LineLayer> = {};
  for (const l of layers) if (!/^\d+$/.test(l.key)) byName[l.key] = l;

  const depth = (j: LineLayer, target: LineLayer): number | null => {
    if (!fill) return null;
    let d = 0;
    let cur: LineLayer | undefined = j;
    while (cur && cur.on && d < 8) {
      d += 1;
      cur = byName[cur.on];
      if (cur === target) return d;
    }
    return null;
  };

  const solidForm = (l: LineLayer) => l.k === 'solid' || (l.k === 'shell' && fill);
  const shape = (l: LineLayer, c: string, extra = 0, filled = solidForm(l)) => {
    const t = l.tf ? ` transform="${l.tf}"` : '';
    const sw = round((s + extra) / (l.sc ?? 1));
    const cap = l.cap === 'butt' && !extra ? 'butt' : 'round';
    if (!filled) {
      return `<path d="${l.d}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linecap="${cap}" stroke-linejoin="round" pathLength="1"${t}/>`;
    }
    if (l.k === 'solid' && !extra) return `<path d="${l.d}" fill="${c}"${t}/>`;
    const w = l.k === 'solid' ? round(extra / (l.sc ?? 1)) : sw;
    return `<path d="${l.d}" fill="${c}" stroke="${c}" stroke-width="${w}" stroke-linejoin="round" pathLength="1"${t}/>`;
  };

  const tagged = (l: LineLayer, svg: string) => `<g data-l="${l.key}"${l.ghost ? ' opacity="0"' : ''}>${svg}</g>`;
  const box = 'maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36"><rect x="-6" y="-6" width="36" height="36" fill="#fff"/>';

  const bands = (i: number, ink: string): string[] => {
    const l = layers[i];
    const out: string[] = [];
    layers.forEach((m, j) => {
      if (j <= i || m.part === l.part || depth(m, l)) return;
      if (m.cutD) out.push(tagged(m, `<path d="${m.cutD}" fill="${ink}"${m.tf ? ` transform="${m.tf}"` : ''}/>`));
      else if (m.cut)
        out.push(tagged(m, `<path d="${m.cut.d}" fill="none" stroke="${ink}" stroke-width="${round(m.cut.w)}" stroke-linecap="round" pathLength="1"/>`));
      else if (m.gap || m.occ) out.push(tagged(m, shape(m, ink, 2 * gapOf(s), m.occ ? true : solidForm(m))));
    });
    return out;
  };

  const defs: string[] = [];
  const pieces: string[] = [];

  layers.forEach((l, i) => {
    const host = fill && l.on ? byName[l.on] : null;
    const cuts: string[] = [];
    layers.forEach((m, j) => {
      if (j <= i) return;
      const d = depth(m, l);
      if (d) cuts.push(tagged(m, shape(m, d % 2 ? '#000' : '#fff')));
    });
    cuts.push(...bands(i, '#000'));
    if (host) return;

    let piece = `<g data-l="${l.key}"${l.ghost ? ' opacity="0"' : ''}${l.vc != null ? ` data-vc="${l.vc}"` : ''}>${shape(l, 'currentColor')}</g>`;
    if (cuts.length) {
      defs.push(`<mask id="${id}-m${i}" ${box}${cuts.join('')}</mask>`);
      piece = `<g mask="url(#${id}-m${i})">${piece}</g>`;
    }
    pieces.push(piece);
  });

  return `${defs.length ? `<defs>${defs.join('')}</defs>` : ''}<g data-l="all">${pieces.join('')}</g>`;
}

/** Renders inner SVG markup for either outline or solid state (native fill or SF-squircle knockout). */
export function renderKubaiLineInner(
  def: KubaiLineDef,
  { id, strokeWidth = 1.8, solid = false }: { id: string; strokeWidth?: number; solid?: boolean },
): string {
  if (!solid) return buildLineInner(def.w, strokeWidth, false, id);
  if (def.nf) return buildLineInner(def.w, strokeWidth, true, id);
  const rawInner = buildLineInner(def.w, Math.min(2.6, strokeWidth + 0.45), false, `${id}k`).replace(/data-l="all"/g, 'data-ko-inner="1"');
  const koMaskId = `${id}-ko`;
  return (
    `<defs><mask id="${koMaskId}" maskUnits="userSpaceOnUse" x="-6" y="-6" width="36" height="36">` +
    `<rect x="-6" y="-6" width="36" height="36" fill="#fff"/>` +
    `<g transform="translate(12 12) scale(0.72) translate(-12 -12)" style="color:#000">${rawInner}</g>` +
    `</mask></defs>` +
    `<g data-l="all"><rect x="2.25" y="2.25" width="19.5" height="19.5" rx="5.5" fill="currentColor" mask="url(#${koMaskId})"/></g>`
  );
}

// ---------- Motion Engine ----------

interface Pose {
  x?: number;
  y?: number;
  r?: number;
  s?: number;
  sx?: number;
  sy?: number;
  gx?: number;
  gy?: number;
  a?: number;
  w?: number;
  clip?: number;
  clipY?: number;
  o?: [number, number];
}

function impulse(t: number, hz = 1.8, z = 0.42): number {
  if (t <= 0) return 0;
  const w = TAU * hz;
  const wd = w * Math.sqrt(1 - z * z);
  const tp = Math.atan(wd / (z * w)) / wd;
  const peak = Math.exp(-z * w * tp) * Math.sin(wd * tp);
  return (Math.exp(-z * w * t) * Math.sin(wd * t)) / peak;
}

function settle(t: number, hz = 2.2, z = 0.55): number {
  if (t <= 0) return 1;
  const w = TAU * hz;
  const wd = w * Math.sqrt(1 - z * z);
  return Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u), 3);
const inOut = (u: number) => {
  const c = clamp(u);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
};

const PATH_ARGS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };

function scalePath(d: string, kx = 1, ky = 1, ox = 12, oy = 12): string {
  const tok = d.match(/[a-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  const X = (v: number, rel: boolean) => round(rel ? v * kx : ox + (v - ox) * kx);
  const Y = (v: number, rel: boolean) => round(rel ? v * ky : oy + (v - oy) * ky);
  let out = '';
  let cmd = '';
  let i = 0;
  while (i < tok.length) {
    if (/[a-z]/i.test(tok[i])) {
      cmd = tok[i++];
      out += cmd;
      if (!PATH_ARGS[cmd.toLowerCase()]) continue;
    }
    const c = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const argc = PATH_ARGS[c] ?? 0;
    const a = tok.slice(i, i + argc).map(Number);
    i += argc;
    let v: number[];
    if (c === 'h') v = [X(a[0], rel)];
    else if (c === 'v') v = [Y(a[0], rel)];
    else if (c === 'a') v = [round(Math.abs(a[0] * kx)), round(Math.abs(a[1] * ky)), a[2], a[3], kx * ky < 0 ? 1 - a[4] : a[4], X(a[5], rel), Y(a[6], rel)];
    else v = a.map((q, j) => (j % 2 ? Y(q, rel) : X(q, rel)));
    out += (/[a-z]$/i.test(out) ? '' : ' ') + v.join(' ');
  }
  return out;
}

const REST: Record<string, number> = { x: 0, y: 0, r: 0, s: 1, sx: 1, sy: 1, gx: 1, gy: 1, a: 1, w: 1 };
const SEG = 150;
const HOME = 0.42;

interface EffectImpl {
  loop?: boolean;
  len: (p: LineEffectSpec, n: number) => number;
  pose: (p: LineEffectSpec, t: number, i: number, n: number) => Pose;
}

const EFFECTS: Record<string, EffectImpl> = {
  bounce: {
    len: (p, n) => 720 + (p.by ? (n - 1) * (p.stagger ?? 90) : 0),
    pose(p, t, i) {
      const u = (t - (p.by ? i * (p.stagger ?? 90) : 0)) / 1000;
      const amp = p.amp ?? 1.6;
      const lift = impulse(u - 0.07, 1.9, 0.45);
      const pre = u > 0 && u < 0.07 ? Math.sin((Math.PI * u) / 0.07) : 0;
      const land = impulse(u - 0.07, 3.8, 0.5);
      return {
        y: p.dir === 'down' ? amp * lift : -amp * Math.max(lift, -0.35),
        sy: 1 - 0.07 * pre + 0.03 * Math.max(land, -0.6),
        sx: 1 + 0.04 * pre,
      };
    },
  },
  beat: {
    len: () => 760,
    pose(p, t) {
      const b = (c: number) => {
        const u = (t - c) / 200;
        return u > 0 && u < 1 ? Math.sin(Math.PI * u) ** 2 : 0;
      };
      const tail = impulse((t - 420) / 1000, 3, 0.5);
      const amp = p.amp ?? 0.12;
      return { s: 1 + amp * b(0) + amp * 0.7 * b(240) + 0.015 * Math.max(0, tail) };
    },
  },
  wiggle: {
    len: (p) => 1000 + (p.delay ?? 0),
    pose(p, t) {
      const u = (t - (p.delay ?? 0)) / 1000;
      if (u <= 0) return {};
      const hz = p.hz ?? 3;
      const env = Math.exp(-u * 3.6) * clamp(u / 0.05);
      return { r: (p.deg ?? 10) * env * Math.sin(TAU * hz * u) };
    },
  },
  shake: {
    len: (p) => p.ms ?? 520,
    pose(p, t) {
      const L = p.ms ?? 520;
      const u = t / L;
      const amp = typeof p.x === 'number' ? p.x : 0.7;
      return { x: amp * Math.sin(TAU * 7 * u) * Math.sin(Math.PI * clamp(u)) };
    },
  },
  rotate: {
    len: (p) => (Math.abs(p.deg ?? 360) >= 180 ? 1050 : 820),
    pose(p, t) {
      const u = t / 1000;
      const deg = p.deg ?? 360;
      const big = Math.abs(deg) >= 180;
      const L = big ? 1050 : 820;
      const out: Pose = { r: deg * (1 - settle(u, big ? 1.25 : 1.9, big ? 0.62 : 0.5)) };
      if (p.dip) out.s = 1 - p.dip * clamp(t / 50) * clamp((L - t) / 260);
      return out;
    },
  },
  flip: {
    len: (p) => 820 * (p.turns ?? 1),
    pose(p, t) {
      const L = 820 * (p.turns ?? 1);
      return { sx: Math.cos(TAU * (p.turns ?? 1) * inOut(t / L)) };
    },
  },
  orbit: {
    len: (p) => 700 * (p.turns ?? 1),
    pose(p, t) {
      const L = 700 * (p.turns ?? 1);
      const q = TAU * (p.turns ?? 1) * inOut(t / L);
      const R = p.R ?? 0.9;
      return { x: R * Math.sin(q), y: R * (Math.cos(q) - 1) * 0.9 };
    },
  },
  draw: {
    len: (p, n) => 380 + (n - 1) * (p.stagger ?? 150) + 40,
    pose(p, t, i) {
      const u = (t - i * (p.stagger ?? 150)) / 380;
      return { w: easeOut(u) };
    },
  },
  variable: {
    loop: true,
    len: (p, n) => 120 + n * (p.step ?? 160) + 460,
    pose(p, t, i, n) {
      const step = p.step ?? 160;
      const P = 120 + n * step + 460;
      const q = t % P;
      const DIM = 0.25;
      const fade = (v: number) => clamp(v / 120);
      if (q < 120) return { a: 1 - (1 - DIM) * fade(q) };
      const on = q - 120 - i * step;
      if (p.mode !== 'iterative') return { a: on < 0 ? DIM : DIM + (1 - DIM) * fade(on) };
      const lit = on < 0 ? 0 : on < step * 1.5 ? fade(on) : 1 - fade(on - step * 1.5);
      const end = P - 140;
      return { a: DIM + (1 - DIM) * Math.max(lit, q > end ? fade(q - end) : 0) };
    },
  },
  from: {
    len: (p, n) => 760 + (p.delay ?? 0) + (p.by ? (n - 1) * (p.stagger ?? 80) : 0),
    pose(p, t, i) {
      const u = (t - (p.delay ?? 0) - (p.by ? i * (p.stagger ?? 80) : 0)) / 1000;
      const k = settle(Math.max(u, 0), p.hz ?? 2.2, p.z ?? 0.55);
      const out: Pose = {};
      for (const key of ['x', 'y', 'r', 's', 'sx', 'sy', 'gx', 'gy'] as const) {
        const val = p[key];
        if (typeof val === 'number') out[key] = REST[key] + (val - REST[key]) * k;
      }
      if (typeof p.a === 'number') out.a = p.a + (1 - p.a) * easeOut(u / 0.18);
      return out;
    },
  },
  keys: {
    len(p) {
      if (p.ms) return p.ms + HOME * 1000;
      const k = Math.max(1, ...(['x', 'y', 'r', 's', 'sx', 'sy', 'gx', 'gy', 'a'] as const).map((key) => (Array.isArray(p[key]) ? p[key].length : 0)));
      return 190 + (k - 1) * SEG + HOME * 1000 + (p.by ? 70 : 0);
    },
    pose(p, t, i) {
      const keys = (['x', 'y', 'r', 's', 'sx', 'sy', 'gx', 'gy', 'a'] as const).filter((k) => p[k] != null);
      const k = Math.max(1, ...keys.map((key) => (Array.isArray(p[key]) ? p[key].length : 1)));
      const localT = t - (p.by ? i * (p.stagger ?? 70) : 0);
      const out: Pose = {};
      const go = p.ms ? p.ms : 190 + (k - 1) * SEG;
      for (const key of keys) {
        const raw = p[key]!;
        const v = Array.isArray(raw) ? raw : [raw];
        const rest = REST[key];
        const home = key === 'a' && p.ghost ? 0 : rest;
        const pts = [home, ...v];
        const last = v[v.length - 1];
        if (localT <= 0) {
          out[key] = home;
          continue;
        }
        if (localT < go) {
          const seg = go / v.length;
          const j = Math.min(v.length - 1, Math.floor(localT / seg));
          const u = (localT - j * seg) / seg;
          out[key] = pts[j] + (pts[j + 1] - pts[j]) * (j === 0 ? easeOut(u) : inOut(u));
        } else {
          out[key] = key === 'a' ? last + (home - last) * easeOut((localT - go) / (HOME * 600)) : rest + (last - rest) * settle((localT - go) / 1000);
        }
      }
      return out;
    },
  },
  turn: {
    loop: true,
    len: (p) => p.ms ?? 1100,
    pose(p, t, i) {
      const L = p.ms ?? 1100;
      const rad = Math.PI / 180;
      const at = (p.at ?? [0])[i] ?? 0;
      const q = at + (p.step ?? 30) * ((t % L) / L);
      const [e0, e1] = p.edge ?? [70, 90];
      const off = Math.abs(((q + 540) % 360) - 180);
      return { gx: Math.sin(q * rad) / (Math.sin(at * rad) || 1), a: 1 - clamp((off - e0) / (e1 - e0)) };
    },
  },
  leaf: {
    len: (p, n) => (p.ms ?? 560) + (n - 1) * (p.stagger ?? 200),
    pose(p, t, i) {
      const u = (t - i * (p.stagger ?? 200)) / (p.ms ?? 560);
      if (u <= 0 || u >= 1) return { a: 0 };
      const c = Math.cos(Math.PI * inOut(u));
      return p.axis === 'y' ? { gy: c, a: 1 } : { gx: c, a: 1 };
    },
  },
  scan: {
    len: (p) => 2 * (p.ms ?? 460) + (p.hold ?? 200) + 120,
    pose(p, t, i) {
      const S = p.ms ?? 460;
      const H = p.hold ?? 200;
      const F = 90;
      const Y = p.axis === 'y';
      const p0 = (Y ? p.y0 : p.x0) ?? 3;
      const p1 = (Y ? p.y1 : p.x1) ?? 21;
      const back = t >= S + H;
      const u = back ? (t - S - H) / S : t / S;
      const pos = t < S ? p1 + (p0 - p1) * inOut(u) : back ? p0 + (p1 - p0) * inOut(u) : p0;
      if (i > 0) return Y ? { clipY: pos } : { clip: pos };
      const a = back ? clamp((t - S - H) / F) * (1 - clamp((t - 2 * S - H) / 120)) : clamp(t / 60) * (1 - clamp((t - S + F) / F));
      return Y ? { y: pos - 12, a } : { x: pos - 12, a };
    },
  },
};

const mergePose = (a: Pose, b: Pose): Pose => ({
  x: (a.x ?? 0) + (b.x ?? 0),
  y: (a.y ?? 0) + (b.y ?? 0),
  r: (a.r ?? 0) + (b.r ?? 0),
  s: (a.s ?? 1) * (b.s ?? 1),
  sx: (a.sx ?? 1) * (b.sx ?? 1),
  sy: (a.sy ?? 1) * (b.sy ?? 1),
  a: a.a == null ? b.a : b.a == null ? a.a : a.a * b.a,
  w: a.w == null ? b.w : b.w == null ? a.w : Math.min(a.w, b.w),
  gx: a.gx == null ? b.gx : b.gx == null ? a.gx : a.gx * b.gx,
  gy: a.gy == null ? b.gy : b.gy == null ? a.gy : a.gy * b.gy,
  clip: a.clip == null ? b.clip : b.clip == null ? a.clip : Math.min(a.clip, b.clip),
  clipY: a.clipY == null ? b.clipY : b.clipY == null ? a.clipY : Math.min(a.clipY, b.clipY),
  o: b.o ?? a.o,
});

function poseTransform(p: Pose): string {
  const [ox, oy] = p.o || [12, 12];
  const s = p.s ?? 1;
  const sx = s * (p.sx ?? 1);
  const sy = s * (p.sy ?? 1);
  return `translate(${round((p.x ?? 0) + ox)} ${round((p.y ?? 0) + oy)}) rotate(${round(p.r ?? 0)}) scale(${round(sx)} ${round(sy)}) translate(${-ox} ${-oy})`;
}

function groupsOf(spec: LineEffectSpec): string[][] {
  if (!spec.on || spec.on === 'all') return [['all']];
  const arr = Array.isArray(spec.on) ? spec.on : [spec.on];
  const list = arr.map((g) => (Array.isArray(g) ? g : [g]));
  return spec.by || ['draw', 'variable', 'turn', 'leaf', 'scan'].includes(spec.t) ? list : [list.flat()];
}

let motionQuery: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  motionQuery ??= matchMedia('(prefers-reduced-motion: reduce)');
  return motionQuery.matches;
}

/** Attaches Kubai line spring motion to an existing `<svg>` element. */
export function attachIconMotion(svg: SVGSVGElement, fx: LineFx | undefined, nativeFill: boolean): IconMotionController {
  const list = fx ? (Array.isArray(fx) ? fx : [fx]) : [];
  if (!list.length) {
    return { playOnce() {}, hover() {}, destroy() {} };
  }

  const find = (name: string) => [...svg.querySelectorAll<SVGElement>(`[data-l="${name}"]`)];
  const centre = (name: string): [number, number] => {
    const el = find(name).find((e) => !e.closest('mask'));
    if (!el || typeof (el as SVGGraphicsElement).getBBox !== 'function') return [12, 12];
    const b = (el as SVGGraphicsElement).getBBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };

  const parts = list
    .map((given) => {
      const spec: LineEffectSpec = nativeFill && given.fill ? { ...given, ...given.fill } : given;
      const impl = EFFECTS[spec.t];
      if (!impl) return null;
      const gs = groupsOf(spec);
      return { spec, gs, impl, len: impl.len(spec, gs.length), o: spec.oBadge ? centre(gs[0][0]) : spec.o };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null);

  if (!parts.length) {
    return { playOnce() {}, hover() {}, destroy() {} };
  }

  const names = [...new Set(parts.flatMap((p) => p.gs.flat()))];
  const nodes: Record<string, SVGElement[]> = Object.fromEntries(names.map((n) => [n, find(n)]));
  const ghost: Record<string, boolean> = Object.fromEntries(names.map((n) => [n, nodes[n].some((e) => e.getAttribute('opacity') === '0')]));
  const loops = parts.some((p) => p.impl.loop);
  const span = Math.max(...parts.map((p) => p.len));
  const restPaths = new Map<Element, string>();
  let clipRect: SVGRectElement | null = null;

  const clipTo = (x: number | undefined, y: number | undefined): string => {
    if (!clipRect) {
      const NS = 'http://www.w3.org/2000/svg';
      const cp = svg.ownerDocument.createElementNS(NS, 'clipPath');
      cp.setAttribute('id', `klc-${nextIconId()}`);
      cp.setAttribute('clipPathUnits', 'userSpaceOnUse');
      clipRect = svg.ownerDocument.createElementNS(NS, 'rect');
      clipRect.setAttribute('x', '-6');
      clipRect.setAttribute('y', '-6');
      cp.appendChild(clipRect);
      let defs = svg.querySelector('defs');
      if (!defs) {
        defs = svg.ownerDocument.createElementNS(NS, 'defs');
        svg.insertBefore(defs, svg.firstChild);
      }
      defs.appendChild(cp);
    }
    clipRect.setAttribute('width', x == null ? '36' : String(round(Math.max(0, x + 6))));
    clipRect.setAttribute('height', y == null ? '36' : String(round(Math.max(0, y + 6))));
    return (clipRect.parentNode as Element).getAttribute('id') ?? '';
  };

  function paint(t: number, done: boolean) {
    const pose: Record<string, Pose> = {};
    for (const p of parts) {
      p.gs.forEach((grp, i) => {
        let q: Pose = done ? {} : p.impl.pose(p.spec, t, i, p.gs.length) || {};
        if (q.w != null && nativeFill) q = { a: q.w, s: 0.7 + 0.3 * q.w };
        for (const n of grp) pose[n] = mergePose(pose[n] || {}, { ...q, o: p.o });
      });
    }
    for (const n of names) {
      const q = pose[n] || {};
      for (const el of nodes[n]) {
        el.setAttribute('transform', poseTransform(q));
        if (q.a != null || ghost[n]) el.setAttribute('opacity', String(round(clamp(q.a ?? 0))));
        else el.removeAttribute('opacity');
        if (q.w != null && !nativeFill) {
          el.setAttribute('stroke-dasharray', `${round(clamp(q.w))} 2`);
          el.setAttribute('stroke-opacity', q.w < 0.01 ? '0' : '1');
        } else {
          el.removeAttribute('stroke-dasharray');
          el.removeAttribute('stroke-opacity');
        }
        const gx = q.gx ?? 1;
        const gy = q.gy ?? 1;
        const bent = Math.abs(gx - 1) > 1e-6 || Math.abs(gy - 1) > 1e-6;
        if (bent || restPaths.size) {
          const paths = el.tagName === 'path' ? [el] : [...el.querySelectorAll('path')];
          for (const path of paths) {
            if (!bent && !restPaths.has(path)) continue;
            if (!restPaths.has(path)) restPaths.set(path, path.getAttribute('d') || '');
            const [ox, oy] = q.o || [12, 12];
            const d = bent ? scalePath(restPaths.get(path)!, gx, gy, ox, oy) : restPaths.get(path)!;
            if (path.getAttribute('d') !== d) path.setAttribute('d', d);
          }
        }
        if (q.clip != null || q.clipY != null) el.setAttribute('clip-path', `url(#${clipTo(q.clip, q.clipY)})`);
        else el.removeAttribute('clip-path');
      }
    }
  }

  let frame = 0;
  let t0 = 0;
  let running = false;
  let hovered = false;
  let onceTimer: ReturnType<typeof setTimeout> | undefined;

  const stop = () => {
    cancelAnimationFrame(frame);
    running = false;
    paint(0, true);
  };

  const tick = (now: number) => {
    const t = now - t0;
    if (loops) {
      if (!hovered && t >= Math.ceil(Math.max(t, 1) / span) * span - 16) {
        stop();
        return;
      }
      paint(t, false);
    } else {
      if (t >= span) {
        stop();
        return;
      }
      paint(t, false);
    }
    frame = requestAnimationFrame(tick);
  };

  const play = () => {
    if (prefersReducedMotion()) return;
    if (running && loops) return;
    cancelAnimationFrame(frame);
    running = true;
    t0 = performance.now();
    frame = requestAnimationFrame(tick);
  };

  return {
    playOnce() {
      clearTimeout(onceTimer);
      if (prefersReducedMotion()) return;
      if (loops) {
        hovered = true;
        play();
        onceTimer = setTimeout(
          () => {
            hovered = false;
          },
          Math.min(900, span),
        );
      } else {
        play();
      }
    },
    hover(on: boolean) {
      clearTimeout(onceTimer);
      hovered = Boolean(on);
      if (hovered) play();
    },
    destroy() {
      clearTimeout(onceTimer);
      hovered = false;
      stop();
    },
  };
}

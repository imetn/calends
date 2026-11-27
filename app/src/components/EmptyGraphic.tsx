import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import './empty-graphic.css';

export type EmptyKind =
  'overview' | 'files' | 'subscriptions' | 'wallet' | 'calendar' | 'report' | 'carpool' | 'people' | 'proxy' | 'due' | 'tokens' | 'search';

export type EmptySize = 'sm' | 'md' | 'lg' | 'hero';

const SIZE_WIDTH: Record<EmptySize, number> = {
  sm: 74,
  md: 96,
  lg: 120,
  hero: 184,
};

// ---------- Physics helpers (damped spring, shared language with icon-motion.ts) ----------

const TAU = Math.PI * 2;
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const round = (v: number) => +v.toFixed(3);

function settle(t: number, hz = 2.0, z = 0.56): number {
  if (t <= 0) return 1;
  const w = TAU * hz;
  const wd = w * Math.sqrt(1 - z * z);
  return Math.exp(-z * w * t) * (Math.cos(wd * t) + ((z * w) / wd) * Math.sin(wd * t));
}

function impulse(t: number, hz = 1.9, z = 0.46): number {
  if (t <= 0) return 0;
  const w = TAU * hz;
  const wd = w * Math.sqrt(1 - z * z);
  const tp = Math.atan(wd / (z * w)) / wd;
  const peak = Math.exp(-z * w * tp) * Math.sin(wd * tp);
  return (Math.exp(-z * w * t) * Math.sin(wd * t)) / peak;
}

const easeOut = (u: number) => 1 - Math.pow(1 - clamp(u), 3);

let reducedQuery: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  if (typeof matchMedia !== 'function') return false;
  reducedQuery ??= matchMedia('(prefers-reduced-motion: reduce)');
  return reducedQuery.matches;
}

interface LayerPose {
  x?: number;
  y?: number;
  r?: number;
  sx?: number;
  sy?: number;
  a?: number;
  draw?: number;
  ox?: number;
  oy?: number;
}

interface SceneChoreography {
  duration: number;
  frame: (ms: number) => Record<string, LayerPose>;
}

const fromSpring = (ms: number, delay: number, hz = 1.9, z = 0.54) => settle(Math.max(0, ms - delay) / 1000, hz, z);
const hitImpulse = (ms: number, delay: number, hz = 2.2, z = 0.48) => impulse(Math.max(0, ms - delay) / 1000, hz, z);

const CHOREO: Record<EmptyKind, SceneChoreography> = {
  overview: {
    duration: 1080,
    frame(ms) {
      const kBack = fromSpring(ms, 40, 1.9, 0.54);
      const kCard = fromSpring(ms, 0, 2.0, 0.54);
      const kDot = fromSpring(ms, 260, 2.2, 0.46);
      const kSp = fromSpring(ms, 210, 2.2, 0.48);
      return {
        back: { x: -7 * kBack, y: 7 * kBack, r: -6 * kBack, ox: 56, oy: 52 },
        card: { y: -9 * kCard, ox: 60, oy: 52 },
        wave: { draw: easeOut((ms - 140) / 420) },
        dot: { sx: 1 - 0.85 * kDot, sy: 1 - 0.85 * kDot, a: easeOut((ms - 240) / 140), ox: 84, oy: 45 },
        spark: { sx: 1 - 0.8 * kSp, sy: 1 - 0.8 * kSp, r: -45 * kSp, a: easeOut((ms - 190) / 160), ox: 98, oy: 22 },
      };
    },
  },
  files: {
    duration: 1150,
    frame(ms) {
      const kBack = fromSpring(ms, 0, 1.85, 0.54);
      const kFront = fromSpring(ms, 85, 1.8, 0.52);
      const kCatch = hitImpulse(ms, 120, 2.3, 0.46);
      const kSp1 = fromSpring(ms, 190, 2.2, 0.48);
      const kSp2 = fromSpring(ms, 260, 2.2, 0.48);
      return {
        back: { x: -4 * kBack, y: -17 * kBack, r: -8 * kBack, ox: 74, oy: 92 },
        front: { x: 4 * kFront, y: -23 * kFront, r: 9 * kFront, ox: 108, oy: 84 },
        folder: { y: 2.8 * kCatch, sx: 1 + 0.03 * kCatch, sy: 1 - 0.045 * kCatch, ox: 90, oy: 118 },
        shadow: { sx: 1 + 0.07 * kCatch, ox: 90, oy: 124 },
        sp1: { sx: 1 - 0.85 * kSp1, sy: 1 - 0.85 * kSp1, r: -45 * kSp1, a: easeOut((ms - 160) / 180), ox: 146, oy: 24 },
        sp2: { sx: 1 - 0.85 * kSp2, sy: 1 - 0.85 * kSp2, a: easeOut((ms - 230) / 180), ox: 34, oy: 42 },
      };
    },
  },
  subscriptions: {
    duration: 1050,
    frame(ms) {
      const kBack = fromSpring(ms, 40, 1.9, 0.52);
      const kMid = fromSpring(ms, 95, 1.9, 0.52);
      const kFront = fromSpring(ms, 0, 2.0, 0.54);
      const kBadge = fromSpring(ms, 170, 2.1, 0.46);
      return {
        back: { x: 9 * kBack, y: 10 * kBack, r: 8 * kBack, ox: 56, oy: 56 },
        mid: { x: -8 * kMid, y: 9 * kMid, r: -7 * kMid, ox: 66, oy: 56 },
        front: { y: -11 * kFront, sx: 1 - 0.06 * kFront, sy: 1 - 0.06 * kFront, ox: 60, oy: 58 },
        badge: { sx: 1 - 0.8 * kBadge, sy: 1 - 0.8 * kBadge, r: -90 * kBadge, a: easeOut((ms - 150) / 170), ox: 96, oy: 22 },
      };
    },
  },
  wallet: {
    duration: 1050,
    frame(ms) {
      const kBody = fromSpring(ms, 0, 2.0, 0.52);
      const kCard = fromSpring(ms, 90, 1.85, 0.5);
      const kClasp = fromSpring(ms, 150, 2.2, 0.46);
      const kSpark = fromSpring(ms, 210, 2.2, 0.48);
      return {
        wallet: { y: -7 * kBody, r: -7 * kBody, ox: 60, oy: 60 },
        card: { x: -5 * kCard, y: 16 * kCard, r: 9 * kCard, ox: 58, oy: 50 },
        clasp: { x: 7 * kClasp, ox: 84, oy: 57 },
        spark: { sx: 1 - 0.8 * kSpark, sy: 1 - 0.8 * kSpark, r: -40 * kSpark, a: easeOut((ms - 180) / 160), ox: 98, oy: 24 },
      };
    },
  },
  calendar: {
    duration: 1080,
    frame(ms) {
      const kBody = fromSpring(ms, 0, 2.0, 0.54);
      const kBack = fromSpring(ms, 60, 1.9, 0.52);
      const out: Record<string, LayerPose> = {
        back: { x: -6 * kBack, y: 6 * kBack, r: -6 * kBack, ox: 60, oy: 54 },
        body: { y: -9 * kBody, r: 5 * kBody, ox: 60, oy: 54 },
      };
      const dotCenters: Array<[number, number]> = [
        [43, 52],
        [60, 52],
        [77, 52],
        [43, 66],
        [60, 66],
        [77, 66],
      ];
      dotCenters.forEach(([ox, oy], i) => {
        const k = fromSpring(ms, 110 + i * 52, 2.4, 0.46);
        out[`d${i}`] = { sx: 1 - 0.82 * k, sy: 1 - 0.82 * k, a: easeOut((ms - (90 + i * 52)) / 140), ox, oy };
      });
      return out;
    },
  },
  report: {
    duration: 1080,
    frame(ms) {
      const kFrame = fromSpring(ms, 0, 2.1, 0.56);
      const k0 = fromSpring(ms, 60, 2.0, 0.52);
      const k1 = fromSpring(ms, 130, 2.0, 0.52);
      const k2 = fromSpring(ms, 200, 1.95, 0.5);
      const kDot = fromSpring(ms, 310, 2.2, 0.45);
      return {
        frame: { y: -5 * kFrame, ox: 60, oy: 54 },
        b0: { sy: 1 - 0.78 * k0, ox: 42, oy: 74 },
        b1: { sy: 1 - 0.8 * k1, ox: 60, oy: 74 },
        b2: { sy: 1 - 0.82 * k2, ox: 78, oy: 74 },
        trend: { draw: easeOut((ms - 180) / 380) },
        peak: { sx: 1 - 0.85 * kDot, sy: 1 - 0.85 * kDot, a: easeOut((ms - 290) / 140), ox: 88, oy: 24 },
      };
    },
  },
  carpool: {
    duration: 1080,
    frame(ms) {
      const kMain = fromSpring(ms, 0, 2.0, 0.52);
      const kL = fromSpring(ms, 85, 1.9, 0.5);
      const kR = fromSpring(ms, 145, 1.9, 0.5);
      return {
        center: { y: -11 * kMain, sx: 1 - 0.08 * kMain, sy: 1 - 0.08 * kMain, ox: 60, oy: 56 },
        left: { x: 14 * kL, y: -6 * kL, r: 8 * kL, ox: 33, oy: 58 },
        right: { x: -14 * kR, y: -6 * kR, r: -8 * kR, ox: 87, oy: 58 },
        arc: { draw: easeOut((ms - 150) / 360) },
      };
    },
  },
  people: {
    duration: 1040,
    frame(ms) {
      const kBack = fromSpring(ms, 65, 1.9, 0.52);
      const kFront = fromSpring(ms, 0, 1.95, 0.52);
      const kBadge = fromSpring(ms, 175, 2.2, 0.46);
      return {
        back: { x: -10 * kBack, y: 7 * kBack, r: -9 * kBack, ox: 74, oy: 54 },
        front: { x: 6 * kFront, y: -10 * kFront, r: 7 * kFront, ox: 50, oy: 54 },
        badge: { sx: 1 - 0.8 * kBadge, sy: 1 - 0.8 * kBadge, a: easeOut((ms - 155) / 150), ox: 98, oy: 21 },
      };
    },
  },
  proxy: {
    duration: 1040,
    frame(ms) {
      const kL = fromSpring(ms, 0, 2.0, 0.54);
      const kR = fromSpring(ms, 70, 2.0, 0.54);
      const kHub = fromSpring(ms, 100, 2.1, 0.5);
      const kA1 = fromSpring(ms, 140, 2.0, 0.48);
      const kA2 = fromSpring(ms, 190, 2.0, 0.48);
      return {
        left: { x: -10 * kL, y: -5 * kL, r: -6 * kL, ox: 36, oy: 50 },
        right: { x: 10 * kR, y: 5 * kR, r: 6 * kR, ox: 84, oy: 50 },
        hub: { sx: 1 - 0.22 * kHub, sy: 1 - 0.22 * kHub, ox: 60, oy: 50 },
        a1: { x: -7 * kA1, ox: 60, oy: 45 },
        a2: { x: 7 * kA2, ox: 60, oy: 55 },
      };
    },
  },
  due: {
    duration: 1060,
    frame(ms) {
      const kDial = fromSpring(ms, 0, 2.0, 0.54);
      const kMin = fromSpring(ms, 70, 1.8, 0.48);
      const kHour = fromSpring(ms, 110, 1.9, 0.52);
      const kCheck = fromSpring(ms, 185, 2.2, 0.46);
      return {
        dial: { y: -8 * kDial, sx: 1 - 0.08 * kDial, sy: 1 - 0.08 * kDial, ox: 58, oy: 49 },
        min: { r: -110 * kMin, ox: 58, oy: 49 },
        hour: { r: -40 * kHour, ox: 58, oy: 49 },
        badge: { sx: 1 - 0.85 * kCheck, sy: 1 - 0.85 * kCheck, r: -18 * kCheck, a: easeOut((ms - 160) / 160), ox: 81, oy: 65 },
      };
    },
  },
  tokens: {
    duration: 1060,
    frame(ms) {
      const kCard = fromSpring(ms, 0, 2.1, 0.56);
      const kKey = fromSpring(ms, 50, 1.9, 0.48);
      const kW1 = fromSpring(ms, 150, 2.1, 0.5);
      const kW2 = fromSpring(ms, 230, 2.1, 0.5);
      return {
        frame: { y: -5 * kCard, ox: 60, oy: 52 },
        key: { r: -28 * kKey, x: -5 * kKey, ox: 52, oy: 52 },
        w1: { sx: 1 - 0.45 * kW1, sy: 1 - 0.45 * kW1, a: easeOut((ms - 140) / 180), ox: 82, oy: 36 },
        w2: { sx: 1 - 0.5 * kW2, sy: 1 - 0.5 * kW2, a: easeOut((ms - 220) / 180), ox: 88, oy: 32 },
      };
    },
  },
  search: {
    duration: 1040,
    frame(ms) {
      const kDoc = fromSpring(ms, 0, 2.1, 0.55);
      const kLens = fromSpring(ms, 70, 1.8, 0.48);
      const kSpark = fromSpring(ms, 190, 2.2, 0.48);
      return {
        doc: { y: -6 * kDoc, ox: 54, oy: 50 },
        lens: { x: -11 * kLens, y: -6 * kLens, r: -22 * kLens, ox: 68, oy: 54 },
        spark: { sx: 1 - 0.8 * kSpark, sy: 1 - 0.8 * kSpark, a: easeOut((ms - 170) / 150), ox: 94, oy: 26 },
      };
    },
  },
};

function applyPose(el: SVGElement, p: LayerPose) {
  const ox = p.ox ?? 60;
  const oy = p.oy ?? 48;
  const x = p.x ?? 0;
  const y = p.y ?? 0;
  const r = p.r ?? 0;
  const sx = p.sx ?? 1;
  const sy = p.sy ?? 1;
  if (x || y || r || sx !== 1 || sy !== 1) {
    el.setAttribute('transform', `translate(${round(x + ox)} ${round(y + oy)}) rotate(${round(r)}) scale(${round(sx)} ${round(sy)}) translate(${-ox} ${-oy})`);
  } else {
    el.removeAttribute('transform');
  }
  if (p.a != null) el.setAttribute('opacity', String(round(clamp(p.a))));
  else el.removeAttribute('opacity');
  if (p.draw != null) {
    el.setAttribute('stroke-dasharray', `${round(clamp(p.draw))} 2`);
    el.setAttribute('stroke-opacity', p.draw < 0.01 ? '0' : '1');
  } else {
    el.removeAttribute('stroke-dasharray');
    el.removeAttribute('stroke-opacity');
  }
}

function clearPose(el: SVGElement) {
  el.removeAttribute('transform');
  el.removeAttribute('opacity');
  el.removeAttribute('stroke-dasharray');
  el.removeAttribute('stroke-opacity');
}

function renderScene(kind: EmptyKind) {
  switch (kind) {
    case 'overview':
      return (
        <>
          <ellipse cx="60" cy="86" rx="44" ry="5" className="eg-shadow" />
          <g data-eg="back">
            <g transform="rotate(-6 56 52)">
              <rect x="24" y="22" width="70" height="54" rx="10" className="eg-surface-muted" />
            </g>
          </g>
          <g className="eg-float-slow">
            <g data-eg="card">
              <rect x="22" y="25" width="76" height="54" rx="11" className="eg-surface" />
              <circle cx="34" cy="37" r="3" className="eg-fill-ink" />
              <path d="M42 37h18" className="eg-stroke-rule" />
              <path d="M32 64 C42 64, 46 53, 56 55 C66 57, 72 45, 84 45" pathLength="1" className="eg-stroke-ink" data-eg="wave" />
              <g data-eg="dot">
                <circle cx="84" cy="45" r="3.8" className="eg-fill-ink" />
                <circle cx="84" cy="45" r="1.5" className="eg-fill-card" />
              </g>
              <path d="M32 71h56" className="eg-dash" />
            </g>
          </g>
          <g className="eg-twinkle">
            <g data-eg="spark">
              <path d="M98 17v10M93 22h10" className="eg-stroke-soft" />
            </g>
          </g>
        </>
      );

    case 'files':
      return (
        <>
          <g data-eg="shadow">
            <ellipse cx="90" cy="124" rx="64" ry="6.5" className="eg-shadow" />
          </g>
          {/* Folder back plate & inner pocket */}
          <path d="M28 56a9 9 0 0 1 9-9h30l11 11h65a9 9 0 0 1 9 9v44a9 9 0 0 1-9 9H37a9 9 0 0 1-9-9Z" className="eg-surface-muted" />
          {/* Floating receipts tucked into the folder */}
          <g className="eg-float-slow">
            <g data-eg="back">
              <g transform="rotate(-7.5 74 88)">
                <rect x="44" y="22" width="60" height="76" rx="8" className="eg-surface-soft" />
                <path d="M55 38h26M55 48h36M55 58h24" className="eg-stroke-rule" />
              </g>
            </g>
          </g>
          <g className="eg-float">
            <g data-eg="front">
              <g transform="rotate(5.5 108 82)">
                <rect x="76" y="13" width="62" height="78" rx="8" className="eg-surface" />
                <circle cx="91" cy="28" r="4.2" className="eg-fill-ink" />
                <path d="M101 26h24M101 32h16" className="eg-stroke-rule" />
                <path d="M88 45h38M88 55h28" className="eg-stroke-rule" />
                <path d="M88 66h38" className="eg-dash" />
                <path d="M88 76h14M114 76h12" className="eg-stroke-soft" />
              </g>
            </g>
          </g>
          {/* Folder front flap with crisp foreground ink */}
          <g data-eg="folder">
            <path d="M24 72a9 9 0 0 1 9-9h114a9 9 0 0 1 9 9l-5 40a9 9 0 0 1-9 8H38a9 9 0 0 1-9-8Z" className="eg-surface" />
            <path d="M74 75h32" className="eg-stroke-soft" />
            <circle cx="42" cy="106" r="2.6" className="eg-fill-ink" />
            <path d="M50 106h24" className="eg-stroke-rule" />
          </g>
          {/* Delicate floating sparkles */}
          <g className="eg-twinkle">
            <g data-eg="sp1">
              <path d="M146 18v12M140 24h12" className="eg-stroke-mid" />
            </g>
          </g>
          <g className="eg-twinkle-delay">
            <g data-eg="sp2">
              <circle cx="34" cy="42" r="2.4" className="eg-fill-soft" />
            </g>
          </g>
        </>
      );

    case 'subscriptions':
      return (
        <>
          <ellipse cx="60" cy="86" rx="44" ry="5" className="eg-shadow" />
          <g className="eg-float-slow">
            <g data-eg="back">
              <g transform="rotate(-7 54 52)">
                <rect x="24" y="24" width="68" height="44" rx="9" className="eg-surface-muted" />
              </g>
            </g>
          </g>
          <g data-eg="mid">
            <g transform="rotate(4.5 64 54)">
              <rect x="28" y="28" width="68" height="44" rx="9" className="eg-surface-soft" />
            </g>
          </g>
          <g className="eg-float">
            <g data-eg="front">
              <rect x="22" y="34" width="76" height="44" rx="10" className="eg-surface" />
              <rect x="31" y="45" width="18" height="18" rx="5.5" className="eg-fill-ink" />
              <rect x="36.5" y="50.5" width="7" height="7" rx="2" className="eg-fill-card" />
              <path d="M56 50h18M56 59h11" className="eg-stroke-bar" />
              <rect x="78" y="49" width="12" height="10" rx="5" className="eg-fill-muted" />
            </g>
          </g>
          <g data-eg="badge">
            <circle cx="96" cy="22" r="9.5" className="eg-surface" />
            <path d="M96 18v8M92 22h8" className="eg-stroke-ink" />
          </g>
        </>
      );

    case 'wallet':
      return (
        <>
          <ellipse cx="60" cy="86" rx="43" ry="5" className="eg-shadow" />
          <g className="eg-float">
            <g data-eg="card">
              <g transform="rotate(-8 58 46)">
                <rect x="28" y="19" width="62" height="40" rx="8" className="eg-surface-soft" />
                <rect x="36" y="27" width="11" height="8" rx="2" className="eg-fill-ink" />
                <path d="M53 31h27" className="eg-stroke-rule" />
              </g>
            </g>
          </g>
          <g data-eg="wallet">
            <rect x="22" y="34" width="74" height="46" rx="11" className="eg-surface" />
            <path d="M31 42h56" className="eg-dash" />
            <g data-eg="clasp">
              <path d="M74 49h24a4 4 0 0 1 4 4v8a4 4 0 0 1-4 4H74a8 8 0 0 1 0-16Z" className="eg-surface" />
              <circle cx="81" cy="57" r="3.1" className="eg-fill-ink" />
            </g>
          </g>
          <g className="eg-twinkle">
            <g data-eg="spark">
              <path d="M98 19v10M93 24h10" className="eg-stroke-soft" />
            </g>
          </g>
        </>
      );

    case 'calendar':
      return (
        <>
          <ellipse cx="60" cy="86" rx="40" ry="5" className="eg-shadow" />
          <g data-eg="back">
            <g transform="rotate(6 64 52)">
              <rect x="28" y="23" width="64" height="59" rx="11" className="eg-surface-muted" />
            </g>
          </g>
          <g className="eg-float-slow">
            <g data-eg="body">
              <rect x="26" y="23" width="68" height="59" rx="11" className="eg-surface" />
              {/* Solid dark calendar header with binding pins, matching fixed calendar icon */}
              <path d="M26 34a11 11 0 0 1 11-11h46a11 11 0 0 1 11 11v6.5H26Z" className="eg-fill-ink" />
              <rect x="42" y="17.5" width="4.4" height="10.5" rx="2.2" className="eg-surface" />
              <rect x="73.6" y="17.5" width="4.4" height="10.5" rx="2.2" className="eg-surface" />
              <g data-eg="d0">
                <circle cx="43" cy="52.5" r="3.4" className="eg-fill-soft" />
              </g>
              <g data-eg="d1">
                <circle cx="60" cy="52.5" r="3.4" className="eg-fill-soft" />
              </g>
              <g data-eg="d2">
                <circle cx="77" cy="52.5" r="3.4" className="eg-fill-ink" />
              </g>
              <g data-eg="d3">
                <circle cx="43" cy="66.5" r="3.4" className="eg-fill-soft" />
              </g>
              <g data-eg="d4">
                <circle cx="60" cy="66.5" r="3.4" className="eg-fill-soft" />
              </g>
              <g data-eg="d5">
                <circle cx="77" cy="66.5" r="3.4" className="eg-fill-soft" />
              </g>
            </g>
          </g>
        </>
      );

    case 'report':
      return (
        <>
          <ellipse cx="60" cy="86" rx="43" ry="5" className="eg-shadow" />
          <g data-eg="frame">
            <rect x="22" y="22" width="76" height="60" rx="11" className="eg-surface-soft" />
            <path d="M32 74h56" className="eg-stroke-soft" />
          </g>
          <g data-eg="b0">
            <rect x="35" y="54" width="13" height="20" rx="4" className="eg-surface-muted" />
          </g>
          <g data-eg="b1">
            <rect x="53.5" y="42" width="13" height="32" rx="4" className="eg-surface" />
          </g>
          <g data-eg="b2">
            <rect x="72" y="34" width="13" height="40" rx="4" className="eg-fill-ink" />
          </g>
          <path d="M36 45 C48 44, 58 32, 86 24" pathLength="1" className="eg-stroke-mid" data-eg="trend" />
          <g data-eg="peak">
            <circle cx="88" cy="24" r="4.5" className="eg-fill-ink" />
            <circle cx="88" cy="24" r="1.8" className="eg-fill-card" />
          </g>
        </>
      );

    case 'carpool':
      return (
        <>
          <ellipse cx="60" cy="86" rx="46" ry="5" className="eg-shadow" />
          {/* Delicate connecting bridge arc */}
          <path d="M33 35 C45 19, 75 19, 87 35" pathLength="1" className="eg-dash" data-eg="arc" />
          {/* Left member seat */}
          <g data-eg="left">
            <circle cx="32" cy="45" r="7.2" className="eg-surface-muted" />
            <path d="M19 72c0-7.2 5.8-12.5 13-12.5S45 64.8 45 72Z" className="eg-surface-muted" />
          </g>
          {/* Right member seat */}
          <g data-eg="right">
            <circle cx="88" cy="45" r="7.2" className="eg-surface-muted" />
            <path d="M75 72c0-7.2 5.8-12.5 13-12.5S101 64.8 101 72Z" className="eg-surface-muted" />
          </g>
          {/* Foreground host seat */}
          <g className="eg-float-slow">
            <g data-eg="center">
              <circle cx="60" cy="39" r="9.5" className="eg-fill-ink" />
              <path d="M41.5 76c0-10 8.2-17 18.5-17s18.5 7 18.5 17Z" className="eg-surface" />
              <path d="M52 68.5h16" className="eg-stroke-soft" />
            </g>
          </g>
        </>
      );

    case 'people':
      return (
        <>
          <ellipse cx="60" cy="86" rx="43" ry="5" className="eg-shadow" />
          <g className="eg-float-slow">
            <g data-eg="back">
              <g transform="rotate(8 74 52)">
                <rect x="48" y="24" width="46" height="54" rx="9" className="eg-surface-muted" />
                <circle cx="71" cy="43" r="6.5" className="eg-fill-card" />
                <path d="M60 59h22M64 66h14" className="eg-stroke-rule" />
              </g>
            </g>
          </g>
          <g className="eg-float">
            <g data-eg="front">
              <g transform="rotate(-4.5 50 52)">
                <rect x="26" y="24" width="50" height="56" rx="10" className="eg-surface" />
                <circle cx="51" cy="42" r="7.5" className="eg-fill-ink" />
                <path d="M38 61c2.2-5 7-7.5 13-7.5s10.8 2.5 13 7.5" className="eg-stroke-ink" />
                <path d="M39 69h24" className="eg-stroke-rule" />
              </g>
            </g>
          </g>
          <g className="eg-twinkle">
            <g data-eg="badge">
              <circle cx="98" cy="21" r="3" className="eg-fill-soft" />
            </g>
          </g>
        </>
      );

    case 'proxy':
      return (
        <>
          <ellipse cx="60" cy="86" rx="46" ry="5" className="eg-shadow" />
          <g data-eg="left">
            <rect x="16" y="29" width="38" height="46" rx="9" className="eg-surface-soft" />
            <path d="M25 43h18M25 52h13M25 61h16" className="eg-stroke-rule" />
          </g>
          <g data-eg="right">
            <rect x="66" y="29" width="38" height="46" rx="9" className="eg-surface" />
            <circle cx="92" cy="41" r="3.4" className="eg-fill-ink" />
            <path d="M77 52h18M77 61h13" className="eg-stroke-rule" />
          </g>
          <g className="eg-float-slow">
            <g data-eg="hub">
              <circle cx="60" cy="52" r="15.5" className="eg-surface" />
              <g data-eg="a1">
                <path d="M52 47.5h15m-4-3.8 4 3.8-4 3.8" className="eg-stroke-ink" />
              </g>
              <g data-eg="a2">
                <path d="M68 56.5H53m4-3.8-4 3.8 4 3.8" className="eg-stroke-ink" />
              </g>
            </g>
          </g>
        </>
      );

    case 'due':
      return (
        <>
          <ellipse cx="60" cy="86" rx="40" ry="5" className="eg-shadow" />
          <g className="eg-float-slow">
            <g data-eg="dial">
              <circle cx="58" cy="49" r="28.5" className="eg-surface" />
              <circle cx="58" cy="49" r="22.5" className="eg-surface-muted" />
              <path d="M58 30.5v3M58 64.5v3M39.5 49h3M73.5 49h3" className="eg-stroke-soft" />
              <g data-eg="hour">
                <path d="M58 49 48.5 42.5" className="eg-stroke-ink" />
              </g>
              <g data-eg="min">
                <path d="M58 49V35.5" className="eg-stroke-ink" />
              </g>
              <circle cx="58" cy="49" r="2.7" className="eg-fill-ink" />
            </g>
          </g>
          <g data-eg="badge">
            <circle cx="81" cy="65" r="12" className="eg-fill-card" />
            <circle cx="81" cy="65" r="10.2" className="eg-fill-ink" />
            <path d="M76.5 65.2 79.6 68.3 85.8 62" className="eg-stroke-card" />
          </g>
        </>
      );

    case 'tokens':
      return (
        <>
          <ellipse cx="60" cy="86" rx="43" ry="5" className="eg-shadow" />
          <g data-eg="frame">
            <rect x="20" y="28" width="80" height="48" rx="11" className="eg-surface-soft" />
            <path d="M78 44h13M78 52h10M78 60h13" className="eg-stroke-rule" />
          </g>
          <g className="eg-float-slow">
            <g data-eg="key">
              <circle cx="42" cy="52" r="11.5" className="eg-surface" />
              <circle cx="42" cy="52" r="4.2" className="eg-fill-ink" />
              <path d="M53.5 52H71m-6 0v6.5m6-6.5v5" className="eg-stroke-ink" />
            </g>
          </g>
          <g className="eg-twinkle">
            <g data-eg="w1">
              <path d="M81 24a12 12 0 0 1 12 12" className="eg-stroke-mid" />
            </g>
          </g>
          <g className="eg-twinkle-delay">
            <g data-eg="w2">
              <path d="M84 17a19 19 0 0 1 19 19" className="eg-stroke-soft" />
            </g>
          </g>
        </>
      );

    case 'search':
      return (
        <>
          <ellipse cx="60" cy="86" rx="40" ry="5" className="eg-shadow" />
          <g data-eg="doc">
            <rect x="26" y="20" width="54" height="60" rx="10" className="eg-surface-muted" />
            <path d="M36 35h26M36 45h32M36 55h18M36 65h22" className="eg-stroke-rule" />
          </g>
          <g className="eg-float">
            <g data-eg="lens">
              <circle cx="65" cy="49" r="16" className="eg-surface" />
              <path d="M59 42a9.5 9.5 0 0 1 10.5-1.2" className="eg-stroke-soft" />
              <path d="M77 61l11 11" className="eg-stroke-ink" style={{ strokeWidth: 3.4 }} />
            </g>
          </g>
          <g className="eg-twinkle">
            <g data-eg="spark">
              <path d="M94 21v10M89 26h10" className="eg-stroke-soft" />
            </g>
          </g>
        </>
      );
  }
}

/**
 * Animated monochrome empty-state hero graphic.
 * Plays damped-spring multi-layer entrance on mount and replays on hover or tap/click.
 */
export function EmptyGraphic({ kind, size = 'lg', className }: { kind: EmptyKind; size?: EmptySize; className?: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const rafRef = useRef(0);

  const play = useCallback(() => {
    const svg = svgRef.current;
    if (!svg || prefersReducedMotion()) return;
    const spec = CHOREO[kind];
    const layers = [...svg.querySelectorAll<SVGElement>('[data-eg]')];
    if (!layers.length) return;

    cancelAnimationFrame(rafRef.current);
    const t0 = performance.now();

    const tick = (now: number) => {
      const ms = now - t0;
      if (ms >= spec.duration) {
        for (const el of layers) clearPose(el);
        return;
      }
      const poses = spec.frame(ms);
      for (const el of layers) {
        const key = el.getAttribute('data-eg');
        if (key && poses[key]) applyPose(el, poses[key]);
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [kind]);

  useEffect(() => {
    play();
    return () => cancelAnimationFrame(rafRef.current);
  }, [play]);

  const isFiles = kind === 'files';
  const width = size === 'hero' ? (isFiles ? 184 : 164) : SIZE_WIDTH[size];
  const height = isFiles ? Math.round((width * 136) / 180) : Math.round((width * 96) / 120);

  return (
    <span
      className={className ? `eg-wrap ${className}` : 'eg-wrap'}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') play();
      }}
      onClick={() => play()}
    >
      <svg
        ref={svgRef}
        className={size === 'hero' ? 'eg-svg eg-hero' : 'eg-svg'}
        viewBox={isFiles ? '0 0 180 136' : '0 0 120 96'}
        width={width}
        height={height}
        aria-hidden="true"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {renderScene(kind)}
      </svg>
    </span>
  );
}

/** Shared empty-state block with animated hero icon, title, and optional muted description. */
export function EmptyState({
  kind,
  size = 'hero',
  title,
  body,
  className,
}: {
  kind: EmptyKind;
  size?: EmptySize;
  title?: ReactNode;
  body?: ReactNode;
  className?: string;
}) {
  const tone = size === 'hero' ? 'hero' : size === 'sm' || size === 'md' ? 'compact' : '';
  const cls = ['empty-state', tone, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <EmptyGraphic kind={kind} size={size} />
      {title && <b>{title}</b>}
      {body && <p>{body}</p>}
    </div>
  );
}

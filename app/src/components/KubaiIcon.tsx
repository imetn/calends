import { useEffect, useId, useRef, type CSSProperties } from 'react';
import { attachIconMotion, renderKubaiLineInner } from './icon-motion.ts';
import { KUBAI_LINE } from './kubai-line.gen.ts';

export interface KubaiIconProps {
  iconKey: string;
  size?: number;
  strokeWidth?: number;
  /** True renders the solid filled state; flipping false -> true plays the solid entrance motion immediately. */
  active?: boolean;
  /** Re-trigger one-shot motion when incremented (e.g. theme cycle). */
  pulseKey?: string | number;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
}

const TRIGGER_SELECTOR = 'a, button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], summary, .side-item, .tab, .arc-item, .facet';

/**
 * 4-state monochrome animated SVG icon (Kubai line engine, MIT):
 * 1. Outline rest   2. Outline hover motion   3. Solid rest (active)   4. Solid click/hover motion
 */
export function KubaiIcon({ iconKey, size, strokeWidth = 1.8, active = false, pulseKey, className, style, 'aria-hidden': ariaHidden = true }: KubaiIconProps) {
  const rawId = useId();
  const maskId = `k${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const svgRef = useRef<SVGSVGElement>(null);
  const prevActive = useRef(active);
  const prevPulse = useRef(pulseKey);
  const def = KUBAI_LINE[iconKey];

  const inner = def ? renderKubaiLineInner(def, { id: maskId, strokeWidth, solid: active }) : '';

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !def) return;
    const ctl = attachIconMotion(svg, def.fx, active && def.nf);

    const becameActive = !prevActive.current && active;
    const pulsed = prevPulse.current !== pulseKey;
    prevActive.current = active;
    prevPulse.current = pulseKey;

    if (becameActive || pulsed) ctl.playOnce();

    const host: Element = svg.closest<HTMLElement>(TRIGGER_SELECTOR) ?? svg;
    let pointerHover = false;

    const onEnter = (e: Event) => {
      const ptr = (e as PointerEvent).pointerType;
      if (ptr && ptr !== 'mouse') return;
      pointerHover = true;
      ctl.hover(true);
    };
    const onLeave = (e: Event) => {
      const ptr = (e as PointerEvent).pointerType;
      if (ptr && ptr !== 'mouse') return;
      pointerHover = false;
      ctl.hover(false);
    };
    const onFocusIn = (e: Event) => {
      const target = e.target as Element | null;
      try {
        if (target && !target.matches(':focus-visible')) return;
      } catch {
        // Older browsers without :focus-visible
      }
      ctl.playOnce();
    };
    const onFocusOut = () => {
      if (!pointerHover) ctl.hover(false);
    };
    const onClick = (e: Event) => {
      // Touch taps have no hover; clicking an already-active tab or action button gives tactile feedback.
      const ptr = (e as PointerEvent).pointerType;
      if (active || (ptr && ptr !== 'mouse')) ctl.playOnce();
    };

    host.addEventListener('pointerenter', onEnter);
    host.addEventListener('pointerleave', onLeave);
    host.addEventListener('focusin', onFocusIn);
    host.addEventListener('focusout', onFocusOut);
    host.addEventListener('click', onClick);

    return () => {
      host.removeEventListener('pointerenter', onEnter);
      host.removeEventListener('pointerleave', onLeave);
      host.removeEventListener('focusin', onFocusIn);
      host.removeEventListener('focusout', onFocusOut);
      host.removeEventListener('click', onClick);
      ctl.destroy();
    };
  }, [iconKey, active, strokeWidth, pulseKey, def]);

  return (
    <svg
      ref={svgRef}
      viewBox="0 0 24 24"
      fill="none"
      overflow="visible"
      width={size}
      height={size}
      aria-hidden={ariaHidden}
      className={className}
      style={style}
      dangerouslySetInnerHTML={{ __html: inner }}
    />
  );
}

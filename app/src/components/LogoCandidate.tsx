import { useEffect, useRef, useState } from 'react';
import { base } from '../base.ts';
import { IconButton } from './ui.tsx';
import { loadLogoImage } from './logo-image.ts';

export interface LogoHit {
  url: string;
  thumb: string;
  source: 'site' | 'selfhst' | 'dashboard' | 'web';
  name: string;
  width?: number;
  height?: number;
}

const proxyImage = (url: string) => base(`/api/img?u=${encodeURIComponent(url)}`);

export function LogoCandidate({ hit, onPick, onUnavailable }: { hit: LogoHit; onPick: (url: string) => void; onUnavailable: () => void }) {
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const live = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const choose = async () => {
    if (!ready || pending.current) return;
    pending.current = true;
    setChecking(true);
    try {
      // The thumbnail is not the saved icon. Check the real image for both SubIcon and canvas exports.
      await Promise.all([loadLogoImage(hit.url), ...(hit.thumb !== hit.url ? [loadLogoImage(proxyImage(hit.url))] : [])]);
      if (live.current) onPick(hit.url);
    } catch {
      if (live.current) onUnavailable();
    } finally {
      pending.current = false;
      if (live.current) setChecking(false);
    }
  };
  return (
    <IconButton className="logo-cell" aria-label={hit.name} title={hit.name} disabled={!ready || checking} aria-busy={!ready || checking} onClick={choose}>
      <img
        src={proxyImage(hit.thumb)}
        alt=""
        loading="lazy"
        style={{ visibility: ready ? undefined : 'hidden' }}
        onLoad={() => setReady(true)}
        onError={onUnavailable}
        ref={(el) => {
          // Cached failures may happen before React attaches event handlers.
          if (el?.complete)
            queueMicrotask(() => {
              if (!live.current) return;
              if (el.naturalWidth > 0) setReady(true);
              else onUnavailable();
            });
        }}
      />
    </IconButton>
  );
}

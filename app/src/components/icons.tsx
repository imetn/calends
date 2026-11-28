import './ui.css';
import type { CSSProperties } from 'react';
import { KubaiIcon } from './KubaiIcon.tsx';

// ---------- 4-state Kubai line icons (monochrome currentColor) ----------
export const P: Record<string, string> = {
  key: 'key-round',
  chart: 'chart-histogram',
  cal: 'calendar',
  list: 'list-view',
  wallet: 'wallet',
  car: 'car',
  gear: 'settings',
  plus: 'plus',
  minus: 'minus',
  menu: 'menu',
  more: 'more-horizontal',
  compose: 'square-pen',
  home: 'home',
  x: 'x',
  search: 'search',
  grip: 'grip',
  chat: 'message-circle',
  bot: 'bot',
  users: 'users',
  globe: 'globe',
  swap: 'arrow-left-right',
  left: 'chevron-left',
  'sort-asc': 'sort',
  'sort-desc': 'list-ordered',
  updown: 'arrow-up-down',
  'arrow-up': 'arrow-up',
  'arrow-down': 'arrow-down',
  right: 'chevron-right',
  down: 'chevron-down',
  ban: 'ban',
  receipt: 'receipt',
  external: 'external-link',
  link: 'link',
  check: 'check',
  download: 'download',
  edit: 'pencil',
  bell: 'bell',
  leaf: 'leaf',
  sidebar: 'sidebar',
  coins: 'coins',
  copy: 'copy',
  share: 'share',
  info: 'info',
  folder: 'folder',
  upload: 'upload',
  clip: 'paperclip',
  trash: 'trash',
  file: 'file',
  infinity: 'infinity',
};

export function Icon({
  name,
  size,
  active,
  className,
  strokeWidth,
  style,
}: {
  name: keyof typeof P | string;
  size?: number;
  active?: boolean;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}) {
  const iconKey = P[name] ?? name;
  return <KubaiIcon iconKey={iconKey} size={size} active={active} strokeWidth={strokeWidth} className={className ? `i ${className}` : 'i'} style={style} />;
}

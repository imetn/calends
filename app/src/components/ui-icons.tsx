import type { CSSProperties, JSX } from 'react';
import { KubaiIcon } from './KubaiIcon.tsx';

export interface UiIconProps {
  size?: number;
  strokeWidth?: number;
  active?: boolean;
  fill?: string;
  className?: string;
  style?: CSSProperties;
  'aria-hidden'?: boolean | 'true' | 'false';
}

export type IconComponent = (props: UiIconProps) => JSX.Element;
export type LucideIcon = IconComponent;

function makeIcon(iconKey: string): IconComponent {
  return function AnimatedIcon({ size = 24, strokeWidth = 1.8, active, fill, className, style, 'aria-hidden': ariaHidden = true }: UiIconProps) {
    return (
      <KubaiIcon
        iconKey={iconKey}
        size={size}
        strokeWidth={strokeWidth}
        active={active ?? (Boolean(fill) && fill !== 'none')}
        className={className}
        style={style}
        aria-hidden={ariaHidden}
      />
    );
  };
}

export const ArrowDown = makeIcon('arrow-down');
export const ArrowDownToLine = makeIcon('import');
export const ArrowLeft = makeIcon('arrow-left');
export const ArrowRight = makeIcon('arrow-right');
export const ArrowUp = makeIcon('arrow-up');
export const ArrowUpFromLine = makeIcon('export');
export const ArrowUpRight = makeIcon('arrow-up-right');
export const Ban = makeIcon('ban');
export const Brain = makeIcon('brain');
export const CalendarClock = makeIcon('calendar-clock');
export const ChartColumnStacked = makeIcon('chart-column-stacked');
export const ChartPie = makeIcon('chart-pie');
export const Check = makeIcon('check');
export const ChevronDown = makeIcon('chevron-down');
export const ChevronLeft = makeIcon('chevron-left');
export const ChevronRight = makeIcon('chevron-right');
export const ChevronUp = makeIcon('chevron-up');
export const CircleAlert = makeIcon('circle-alert');
export const CircleCheck = makeIcon('circle-check');
export const CircleStop = makeIcon('stop');
export const CircleX = makeIcon('circle-x');
export const Clock = makeIcon('clock');
export const Copy = makeIcon('copy');
export const Eye = makeIcon('eye');
export const EyeOff = makeIcon('eye-off');
export const Flag = makeIcon('flag');
export const Hourglass = makeIcon('hourglass');
export const Image = makeIcon('image');
export const ImagePlus = makeIcon('image-plus');
export const KeyRound = makeIcon('key-round');
export const Layers = makeIcon('layers');
export const Loader2 = makeIcon('loader');
export const Maximize2 = makeIcon('maximize');
export const Minimize2 = makeIcon('minimize');
export const Paperclip = makeIcon('paperclip');
export const Pause = makeIcon('pause');
export const Pencil = makeIcon('pencil');
export const PencilLine = makeIcon('pencil-line');
export const Play = makeIcon('play');
export const Plus = makeIcon('plus');
export const ReceiptText = makeIcon('receipt');
export const Repeat2 = makeIcon('repeat');
export const RotateCcw = makeIcon('rotate-ccw');
export const ScrollText = makeIcon('scroll');
export const Settings2 = makeIcon('sliders');
export const Shapes = makeIcon('shapes');
export const Share = makeIcon('share');
export const Square = makeIcon('stop');
export const SquarePen = makeIcon('square-pen');
export const StickyNote = makeIcon('sticky-note');
export const Tag = makeIcon('tag');
export const Tags = makeIcon('tags');
export const TrendingDown = makeIcon('trending-down');
export const TrendingUp = makeIcon('trending-up');
export const Undo2 = makeIcon('undo');
export const Unlink = makeIcon('unlink');
export const Users = makeIcon('users');
export const Wallet = makeIcon('wallet');
export const Waves = makeIcon('waves');
export const Wrench = makeIcon('wrench');
export const X = makeIcon('x');

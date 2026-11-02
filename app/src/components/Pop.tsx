import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useState } from 'react';
import { Dialog, Modal, ModalOverlay, Popover } from 'react-aria-components';

/** 窄屏时弹层贴底显示（与之前的选择器一致） */
const MOBILE = 560;
const OFFSET = 6;
const PADDING = 8;

/**
 * 可滚动的弹层在弹窗里自己选上下方向：上方只算到弹窗标题栏下沿，翻上去也不会盖住标题和关闭按钮。
 * 下方放得下最大高度、或比上方宽裕就朝下，否则朝上；高度收到所选一侧放得下的范围。
 */
export function fitBelowSheetHead(trigger: HTMLElement | null, max: number) {
  if (!trigger) return { placement: 'bottom end' as const, maxHeight: max };
  const rect = trigger.getBoundingClientRect();
  const head = trigger.closest('.sheet-dlg')?.querySelector('.sheet-head');
  const top = head ? head.getBoundingClientRect().bottom : 0;
  const viewport = window.visualViewport?.height ?? window.innerHeight;
  const below = viewport - rect.bottom - OFFSET - PADDING;
  const above = rect.top - top - OFFSET - PADDING;
  return below >= max || below >= above
    ? { placement: 'bottom end' as const, maxHeight: Math.min(max, below) }
    : { placement: 'top end' as const, maxHeight: Math.min(max, above) };
}

/**
 * 选择器共用的弹出层（react-aria）：宽屏是挂在按钮旁的 Popover，自动翻转、跟随滚动；窄屏是贴底的面板，带遮罩。
 * 点外面、按 Esc 关闭，焦点留在弹层里、关闭后回到按钮；放在弹窗（Sheet）里也能正确叠放。
 * 由调用方按需挂载（挂上即打开）。className 给到盒子本身（.dp-pop 系列样式）；style 只用于宽屏（窄屏高度交给样式表）。
 * maxHeight：内容可滚动的弹层（如支付方式）在打开时用 fitBelowSheetHead 算出方向与高度传进来，盒子用 .fit 继承外壳的高度上限。
 */
export function Pop({
  triggerRef,
  onClose,
  label,
  className = '',
  style,
  placement = 'bottom end',
  maxHeight,
  children,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  label: string;
  className?: string;
  style?: CSSProperties;
  placement?: 'bottom end' | 'bottom start' | 'top end' | 'right bottom' | 'right top';
  maxHeight?: number;
  children: ReactNode;
}) {
  // 打开那一刻决定用哪种形态，打开期间不来回切换
  const [mobile] = useState(() => window.innerWidth < MOBILE);
  // 调用方在打开时用 fitBelowSheetHead 算好方向和高度：此时不再自动翻转
  const fit = !!maxHeight;
  const change = (o: boolean) => !o && onClose();
  if (mobile)
    return (
      <ModalOverlay className="dp-scrim" isOpen onOpenChange={change} isDismissable>
        <Modal className="pop-shell">
          <Dialog aria-label={label} className={`dp-pop mobile ${className}`}>
            {children}
          </Dialog>
        </Modal>
      </ModalOverlay>
    );
  return (
    <Popover
      className="pop-shell"
      triggerRef={triggerRef}
      isOpen
      onOpenChange={change}
      placement={placement}
      shouldFlip={!fit}
      maxHeight={maxHeight}
      offset={OFFSET}
      containerPadding={PADDING}
    >
      <Dialog aria-label={label} className={`dp-pop ${fit ? 'fit' : ''} ${className}`} style={style}>
        {children}
      </Dialog>
    </Popover>
  );
}

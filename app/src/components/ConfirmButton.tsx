import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';

/**
 * 进入确认态后这段时间内的点击不算确认，挡住手滑的双击（系统双击判定一般 300–500ms）；
 * 有意的第二次点要先看清「确认删除？」，通常远超这个时间，所以不会觉得卡。
 */
export const CONFIRM_GUARD_MS = 600;

/** 两步删除的确认态：arm 进入，4 秒不操作自动收回；ready 为假时（刚进入不到 CONFIRM_GUARD_MS）不接受确认 */
export function useArmed() {
  const [armed, setArmed] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return {
    armed,
    arm: () => {
      since.current = Date.now();
      setArmed(true);
    },
    disarm: () => setArmed(false),
    ready: () => Date.now() - since.current >= CONFIRM_GUARD_MS,
  };
}

/**
 * 弹窗底部的删除类按钮，就地二次确认、不再叠一层确认弹窗：
 * 平时是红框红字的透明胶囊；第一次点转成实心红底、文字换成「确认删除？」，稍候再点一次才执行（紧跟着的双击不算）。失焦、按 Esc 或 4 秒不操作就收回。
 */
export function ConfirmButton({
  children,
  onConfirm,
  disabled,
  hint,
}: {
  children: ReactNode;
  onConfirm: () => void;
  disabled?: boolean;
  /** 确认态的说明（如「这几期一起回到待收」），作为提示与读屏文字 */
  hint?: string;
}) {
  const { armed, arm, disarm, ready } = useArmed();
  return (
    <button
      type="button"
      className={`btn confirm-btn${armed ? ' armed' : ''}`}
      disabled={disabled}
      aria-label={armed && hint ? `${t('common.confirmDelete')} ${hint}` : undefined}
      title={armed ? hint : undefined}
      onClick={() => {
        if (!armed) return arm();
        if (!ready()) return;
        disarm();
        onConfirm();
      }}
      onBlur={disarm}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          disarm();
        }
      }}
    >
      {armed ? t('common.confirmDelete') : children}
    </button>
  );
}

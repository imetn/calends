import { useState } from 'react';
import { useArmed } from './ConfirmButton.tsx';
import { Icon } from './icons.tsx';
import { IconButton } from './ui.tsx';

/**
 * 行尾的「编辑 + 删除」两个圆形按钮，删除需要二次确认：
 * 第一次点删除，它向左伸展成占满两个按钮位置的长条，显示「确认」和红色对勾；稍候再点一次才删除（紧跟着的双击不算）。
 * 失焦、按 Esc 或 4 秒不操作就收回。没有 onEdit 时（如刚添加还没保存的条目）直接删除，不需要确认。
 */
export function RowActions({
  onEdit,
  editLabel,
  onRemove,
  removeLabel,
  confirmLabel,
}: {
  onEdit?: () => void;
  editLabel?: string;
  onRemove: () => void;
  removeLabel: string;
  confirmLabel: string;
}) {
  const { armed, arm, disarm, ready } = useArmed();
  const [done, setDone] = useState(false);
  const remove = () => {
    if (!onEdit) return onRemove();
    if (!armed) return arm();
    if (!ready()) return;
    // 对勾弹一下再删，减少动效时立即删除
    setDone(true);
    setTimeout(onRemove, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 250);
  };
  return (
    <span className={`row-actions${onEdit ? ' pair' : ''}${armed ? ' armed' : ''}${done ? ' done' : ''}`}>
      {onEdit && (
        <IconButton className="row-edit" aria-label={editLabel ?? ''} tabIndex={armed ? -1 : undefined} aria-hidden={armed || undefined} onClick={onEdit}>
          <Icon name="edit" />
        </IconButton>
      )}
      <IconButton
        className="danger row-remove"
        aria-label={armed ? confirmLabel : removeLabel}
        onClick={remove}
        onBlur={() => !done && disarm()}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && armed) {
            e.stopPropagation();
            disarm();
          }
        }}
      >
        <span className="rm-x" aria-hidden>
          <Icon name="x" />
        </span>
        <span className="rm-confirm" aria-hidden>
          <span>{confirmLabel}</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
            <path pathLength={1} d="m5 12.5 4.5 4.5L19 7.5" />
          </svg>
        </span>
      </IconButton>
    </span>
  );
}

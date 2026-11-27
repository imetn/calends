import { use, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { StickyNote, X } from './ui-icons.tsx';
import { t } from '../../../shared/i18n.ts';
import { copyParts } from './copy.tsx';
import { CardTitle, IconButton } from './ui.tsx';
import { Icon } from './icons.tsx';
import { Sheet, SheetNested } from './overlays.tsx';
import '../views/detail.css';

/*
 * 订阅、代付、合租详情共用的骨架：同样的弹窗宽度、头部、信息卡和面板。
 * 顺序固定为 头部 → 指标卡 → 信息卡 → 各内容面板，样式见 views/detail.css
 */

/** 详情弹窗：自带头部，复用弹窗的焦点、关闭和键盘行为 */
export function DetailSheet({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  return (
    <Sheet bare label={label} onClose={onClose} header={null}>
      {children}
    </Sheet>
  );
}

/** 头部：图标、名称与角标、一行元信息，右侧操作与关闭 */
export function DetailHead({
  icon,
  title,
  badge,
  meta,
  actions,
  onClose,
}: {
  icon: ReactNode;
  title: ReactNode;
  badge?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  // 叠在别的弹窗上时和普通弹窗一样：左上角返回，没有关闭
  const nested = use(SheetNested);
  return (
    <header className={`dt-head${nested ? ' nested' : ''}`}>
      {nested && (
        <IconButton className="dt-back" onClick={onClose} title={t('common.back')} aria-label={t('common.back')} data-snapshot-hide>
          <Icon name="left" />
        </IconButton>
      )}
      {icon}
      <div className="dt-id">
        <h2>
          <span className="dt-name">{title}</span>
          {badge}
        </h2>
        {meta && <div className="dt-meta">{meta}</div>}
      </div>
      {actions && <div className="sheet-actions dt-actions">{actions}</div>}
      {!nested && (
        <IconButton className="dt-close" onClick={onClose} title={t('ui.close')} aria-label={t('ui.close')} data-snapshot-hide>
          <X size={17} />
        </IconButton>
      )}
    </header>
  );
}

/** 内容面板：标题与右侧附注，可整块点开 */
export function Panel({
  title,
  aside,
  children,
  className = '',
  onClick,
  snapshotRef,
}: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  snapshotRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <section
      ref={snapshotRef}
      className={`dt-panel ${className} ${onClick ? 'dt-tap' : ''}`}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
      {title && (
        <div className="dt-ph row">
          <CardTitle>{title}</CardTitle>
          {aside && <div className="dt-aside">{copyParts(aside)}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** 一项事实：标签与数值，可带一行小字 */
export function Prop({ k, children, hint, className = '' }: { k: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={`dt-prop ${className}`}>
      <dt>{k}</dt>
      <dd>
        {children}
        {hint && <small>{copyParts(hint)}</small>}
      </dd>
    </div>
  );
}

/** 信息卡：指标卡下面的一张卡，事实按列排开；备注等放在 children */
export function Facts({ label, items, children }: { label?: string; items: ReactNode; children?: ReactNode }) {
  return (
    <section className="dt-panel dt-glance">
      <dl className="dt-summary" aria-label={label}>
        {items}
      </dl>
      {children}
    </section>
  );
}

/** 备注：默认最多四行，和走势同一行时不把整行撑高；点开看全文 */
export function Note({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !open) setLong(el.scrollHeight > el.clientHeight + 1);
  }, [text, open]);
  return (
    <div className={`dt-note ${open ? 'open' : ''}`}>
      <StickyNote size={14} />
      <div>
        <p ref={ref}>{text}</p>
        {(long || open) && (
          <button className="dt-link" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? t('report.checkup.less') : t('detail.note.more')}
          </button>
        )}
      </div>
    </div>
  );
}

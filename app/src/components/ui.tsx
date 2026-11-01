import { copyParts } from './copy.tsx';
import './ui.css';
import type { ReactNode as ComponentChildren, CSSProperties, HTMLAttributes, JSX } from 'react';
import { Children } from 'react';
import { t } from '../../../shared/i18n.ts';
import { Icon } from './icons.tsx';
import { Hint } from './overlays.tsx';
import { useMedia } from './inputs.tsx';
import { useRegisterPageAdd } from '../page-add.ts';

/**
 * 一组并列指标（金额与颜色由调用处提供）。页面顶部与弹窗顶部用独立灰卡；放在另一张卡片里时传 inline，改为竖线分隔的一行，避免卡片套卡片；
 * 窄栏里的四项（概览、报告的大数字下方）传 plain：两行两列，不加底色与分割线。
 */
export function MetricCards({ children, inline = false, plain = false }: { children: ComponentChildren; inline?: boolean; plain?: boolean }) {
  const count = Children.toArray(children).length;
  if (count === 0) return null;
  return (
    <div
      className={`metric-cards ${inline ? 'inline' : ''} ${plain ? 'plain' : ''}`}
      style={{ '--metric-columns': Math.min(4, count) } as CSSProperties}
      data-count={count}
    >
      <div className="metric-grid">{children}</div>
    </div>
  );
}

export function Metric({
  label,
  value,
  note,
  accessory,
  valueClassName = '',
  valueStyle,
  noteStyle,
  ...props
}: {
  label: ComponentChildren;
  value: ComponentChildren;
  note?: ComponentChildren;
  accessory?: ComponentChildren;
  valueClassName?: string;
  valueStyle?: CSSProperties;
  noteStyle?: CSSProperties;
} & Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'className'>) {
  return (
    <div {...props} className="metric">
      <div className="metric-top">
        <small>{label}</small>
        {accessory}
      </div>
      <div className={`metric-value ${valueClassName}`} style={valueStyle}>
        {value}
      </div>
      {note != null && (
        <div className="metric-note" style={noteStyle}>
          {note}
        </div>
      )}
    </div>
  );
}

/** 页面工具栏：桌面端为半透明窗口工具栏，手机端为大标题 */
export function Toolbar({
  title,
  sub,
  children,
  onAdd,
  addLabel = t('ui.toolbar.add'),
  switcher,
}: {
  title: ComponentChildren;
  sub?: ComponentChildren;
  children?: ComponentChildren;
  /** 页面自带的新建：不在工具栏画按钮，登记给手机底栏「更多」里唯一的新建 */
  onAdd?: () => void;
  addLabel?: string;
  /** 手机端工具栏下方的一行切换（如 AI 的「助手 | 连接」）；桌面端不传，结构不变 */
  switcher?: ComponentChildren;
}) {
  useRegisterPageAdd(onAdd, addLabel);
  const narrow = useMedia('(max-width: 860px)');
  const head = (
    <div className="tb-title">
      <h1>{copyParts(title)}</h1>
      {sub && <div className="tb-sub">{copyParts(sub)}</div>}
    </div>
  );
  const actions = <div className="tb-actions">{children}</div>;
  const sw = switcher && <div className="tb-switch">{switcher}</div>;
  // 手机端只有标题吸顶，与概览、设置一致；切换和操作区排在标题下面，随页面滚走
  if (narrow)
    return (
      <>
        <header className="toolbar">{head}</header>
        <div className="tb-under">
          {sw}
          {actions}
        </div>
      </>
    );
  return (
    <header className="toolbar">
      {head}
      {actions}
      {sw}
    </header>
  );
}

/** 标题内容和说明始终作为一个居中对齐的整体，操作区由 card-h 等容器承载。 */
export function CardTitle({
  as: Tag = 'h3',
  className = '',
  hint,
  children,
}: {
  as?: 'h2' | 'h3' | 'h4' | 'div' | 'span';
  className?: string;
  hint?: string;
  children: ComponentChildren;
}) {
  return (
    <Tag className={`ui-title ${className}`}>
      <span className="ui-title-text">{copyParts(children)}</span>
      {hint && <Hint text={hint} />}
    </Tag>
  );
}

/** 所有圆形图标操作共用命中区域和状态；尺寸由 CSS 按视口统一。 */
export function IconButton({ className = '', type = 'button', ...props }: JSX.IntrinsicElements['button'] & { 'aria-label': string }) {
  return <button {...props} type={type} className={`icon-btn ${className}`} />;
}

/** iOS 分组列表 */
export function Group({
  title,
  action,
  foot,
  children,
  submit,
}: {
  title?: ComponentChildren;
  /** 标题右侧的操作，如「记一笔收款」 */
  action?: ComponentChildren;
  foot?: ComponentChildren;
  children: ComponentChildren;
  submit?: string;
}) {
  return (
    <section className="group" data-submit={submit}>
      {(title || action) && (
        <div className={`group-title ${action ? 'with-action' : ''}`}>
          <span>{copyParts(title)}</span>
          {action}
        </div>
      )}
      <div className="group-body">{children}</div>
      {foot && <div className="group-foot">{copyParts(foot)}</div>}
    </section>
  );
}

export function Cell({
  label,
  children,
  onClick,
  sub,
}: {
  label: ComponentChildren;
  children?: ComponentChildren;
  onClick?: () => void;
  sub?: ComponentChildren;
}) {
  const inner = (
    <>
      <span className="cell-l">
        {copyParts(label)}
        {sub && <small>{copyParts(sub)}</small>}
      </span>
      <span className="cell-r">{copyParts(children)}</span>
    </>
  );
  return onClick ? (
    <button className="cell tap" onClick={onClick}>
      {inner}
      <Icon name="right" />
    </button>
  ) : (
    <div className="cell">{inner}</div>
  );
}

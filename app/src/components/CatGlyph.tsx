import { isIconName } from '../../../shared/categories.ts';
import { CAT_ICONS } from './cat-icons.gen.ts';
import { KubaiIcon } from './KubaiIcon.tsx';
import { KUBAI_LINE } from './kubai-line.gen.ts';

const CAT_KUBAI_ALIAS: Record<string, string> = {
  house: 'home',
  'square-play': 'play',
  'gamepad-2': 'gamepad',
  'chart-column': 'chart-histogram',
  'notebook-pen': 'square-pen',
  code: 'square-code',
};

/** 分类图标：优先用 Kubai 线条动态图标（选中态可切换同构实心），未收录的小众图标回退 Lucide，其余当 emoji 显示；后台和公开页共用 */
export function CatGlyph({ icon, size = 14, active, className: cls = 'i' }: { icon?: string; size?: number; active?: boolean; className?: string }) {
  if (icon && !isIconName(icon)) {
    return (
      <span className={`${cls} cat-emo`} style={{ width: size, height: size, fontSize: 'var(--fs-1)' }} aria-hidden="true">
        {icon}
      </span>
    );
  }
  const key = icon ?? 'tag';
  const kubaiKey = CAT_KUBAI_ALIAS[key] ?? key;
  if (KUBAI_LINE[kubaiKey]) {
    return <KubaiIcon iconKey={kubaiKey} size={size} active={active} className={cls} />;
  }
  // 生成的图标数据是写死在仓库里的 SVG 片段，不含用户输入
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden="true"
      className={cls}
      dangerouslySetInnerHTML={{ __html: CAT_ICONS[key] ?? CAT_ICONS.tag }}
    />
  );
}

import { t } from '../../../shared/i18n.ts';
import { Picker } from './Picker.tsx';
import { Icon } from './icons.tsx';
import { useMedia } from './inputs.tsx';
import { IconButton } from './ui.tsx';

/**
 * 排序方式与方向：订阅与人员列表共用。桌面端选择器选字段，旁边的圆形按钮切换升降序；
 * 手机端不单设方向按钮，下拉里选中项右侧标出升降序，再点一次选中项即反转。
 */
export function SortControl<T extends string>({
  value,
  dir,
  options,
  onSort,
  onDir,
}: {
  value: T;
  dir: 'asc' | 'desc';
  options: Array<{ value: T; label: string }>;
  onSort: (v: T) => void;
  onDir: (d: 'asc' | 'desc') => void;
}) {
  const narrow = useMedia('(max-width: 860px)');
  const label = dir === 'asc' ? t('list.sort.asc') : t('list.sort.desc');
  const flip = () => onDir(dir === 'asc' ? 'desc' : 'asc');
  const icon = <Icon name={dir === 'asc' ? 'sort-asc' : 'sort-desc'} />;
  if (narrow)
    return (
      <Picker
        variant="btn"
        value={value}
        onChange={(v) => (v === value ? flip() : onSort(v))}
        ariaLabel={t('list.sort.label')}
        options={options}
        mark={
          <span className="pk-dir" role="img" aria-label={label} title={label}>
            {icon}
          </span>
        }
      />
    );
  return (
    <>
      <Picker variant="btn" value={value} onChange={onSort} ariaLabel={t('list.sort.label')} options={options} />
      <IconButton type="button" onClick={flip} aria-label={label} title={label}>
        {icon}
      </IconButton>
    </>
  );
}

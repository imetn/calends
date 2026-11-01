import { t } from '../../../shared/i18n.ts';
import { Icon } from './icons.tsx';
import { IconButton } from './ui.tsx';

export function QuickEdit({ onEdit }: { onEdit: () => void }) {
  return (
    <IconButton
      className="quick-edit"
      aria-label={t('detail.action.edit')}
      title={t('detail.action.edit')}
      data-snapshot-hide
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onEdit();
      }}
    >
      <Icon name="edit" size={14} />
    </IconButton>
  );
}

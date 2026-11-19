import type { Subscription } from '../../../../shared/types.ts';

/** Only fields rendered inside MoreFields affect its summary and initial disclosure. */
export function editorMoreKeys(f: Subscription, domainCategory = false): string[] {
  const recurring = f.cycle.unit !== 'lifetime';
  return [
    recurring && f.intro && 'editor.more.intro',
    recurring && f.bonus && 'editor.more.bonus',
    recurring && f.remindDays != null && 'editor.more.remind',
    recurring && (f.chargeLeadDays || f.cancelLeadDays || f.contract || f.settlement === 'separate') && 'core.renewal.title',
    (f.url?.trim() || f.manageUrl?.trim() || f.icon?.trim() || (domainCategory && f.showOnPublic)) && 'editor.more.links',
    !!f.tags?.length && 'editor.more.tags',
    f.notes?.trim() && 'editor.more.notes',
    !f.proxy && !!f.transfers?.length && 'detail.transfer.title',
  ].filter(Boolean) as string[];
}

export function editorMoreOpen(f: Subscription, isNew: boolean, domainCategory = false): boolean {
  return !isNew && editorMoreKeys(f, domainCategory).length > 0;
}

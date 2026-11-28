/** App-only keyboard rules. Selectors describe mounted overlays, including portalled pickers. */
const overlays = '.scrim, [aria-modal="true"], .pop-shell, [role="listbox"], [role="menu"]';
const editable = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], [role="spinbutton"]';
const singleLine = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time']);

function element(target: EventTarget | null): HTMLElement | null {
  return target && 'closest' in target ? (target as HTMLElement) : null;
}

export function composing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

export function saveShortcut(e: KeyboardEvent): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's';
}

/** Always reserve Save, even without a sheet or while a child consumes the event. */
export function preventBrowserSave(e: KeyboardEvent) {
  if (saveShortcut(e)) e.preventDefault();
}

export function popupOpen(doc: Document): boolean {
  return !!doc.querySelector('.pop-shell, [role="listbox"], [role="menu"], [aria-haspopup][aria-expanded="true"]');
}

export function hasOverlay(doc: Document): boolean {
  return !!doc.querySelector(overlays);
}

/** The optional scope admits only its own sheet, never a nested or sibling overlay. */
export function canUseSingleKey(e: KeyboardEvent, scope?: HTMLElement | null): boolean {
  const target = element(e.target);
  if (e.defaultPrevented || composing(e) || e.metaKey || e.ctrlKey || e.altKey || (e.shiftKey && e.key !== '?') || target?.closest(editable)) return false;
  const doc = target?.ownerDocument ?? document;
  return ![...doc.querySelectorAll(overlays)].some((overlay) => !scope || !overlay.contains(scope));
}

export function pageShortcut(e: KeyboardEvent, detail?: HTMLElement | null): 'edit' | 'search' | 'help' | 'new' | number | undefined {
  if (e.key.toLowerCase() === 'e' && detail && canUseSingleKey(e, detail)) return 'edit';
  if (!canUseSingleKey(e)) return;
  if (e.key === '/') return 'search';
  if (e.key === '?') return 'help';
  if (e.key === 'n') return 'new';
  if (/^[1-9]$/.test(e.key)) return Number(e.key);
}

/** Plain Enter belongs only to writable single-line fields; chords work at any focus. */
export function sheetSubmitKey(e: KeyboardEvent): boolean {
  if (composing(e) || e.repeat || e.altKey || e.shiftKey) return false;
  if (saveShortcut(e)) return true;
  if (e.key !== 'Enter') return false;
  if (e.metaKey || e.ctrlKey) return true;
  const target = element(e.target) as HTMLInputElement | null;
  return !e.defaultPrevented && target?.tagName === 'INPUT' && !target.disabled && !target.readOnly && singleLine.has(target.type);
}

/** data-submit is a selector relative to the nearest region; empty means locally handled. */
export function submitSheet(e: KeyboardEvent, sheet: HTMLElement): boolean {
  if (!sheetSubmitKey(e) || popupOpen(sheet.ownerDocument)) return false;
  const target = element(e.target);
  if (target?.closest('.sheet-dlg') !== sheet && e.target !== sheet.ownerDocument.body) return false;
  const region = target?.closest<HTMLElement>('[data-submit]');
  const selector = region ? region.dataset.submit : '.sheet-foot .btn.primary';
  if (!selector) return false;
  const button = [...(region ?? sheet).querySelectorAll<HTMLButtonElement>(selector)].find(
    (candidate) => candidate.closest('[data-submit]') === (region ?? null),
  );
  // Never fall through a disabled/missing local action to the outer sheet's Save.
  if (!button || button.tagName !== 'BUTTON' || button.closest('.sheet-dlg') !== sheet || button.matches(':disabled, [aria-disabled="true"]')) return false;
  e.preventDefault();
  e.stopPropagation();
  button.click();
  return true;
}

export function focusPageSearch(doc: Document): boolean {
  const field = [...doc.querySelectorAll<HTMLInputElement>('.main input[type="search"], .main [data-page-search]')].find(
    (input) => !input.disabled && !input.closest('[inert], [hidden]') && input.getClientRects().length > 0,
  );
  if (!field) return false;
  field.focus();
  return true;
}

export const commandLabel = () => (/Mac|iPhone|iPad|iPod/.test(navigator.platform) ? '⌘' : 'Ctrl');

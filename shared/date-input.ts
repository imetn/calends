/** Field order of a locale's numeric date, e.g. en-AU `dmy` (19/11/2026), en-US `mdy`, zh-CN `ymd`. */
export type DateOrder = 'ymd' | 'dmy' | 'mdy';

const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
// Separators seen in numeric dates across supported locales: - / . spaces, and 年月日 (zh/ja), "2026. 11. 19." (ko)
const SEPARATORS = /[\s./\-年月日]+/;
const ALLOWED = /^[\d\s./\-年月日]+$/;

/**
 * Parse a typed date without normalizing invalid calendar dates.
 * A four-digit leading year (2026-11-19, 2026/11/19, 2026年11月19日, 20261119) is always read year-first;
 * a trailing year follows the locale's order (19/11/2026 for `dmy`, 11/19/2026 for `mdy`).
 */
export function parseDateInput(raw: string, order: DateOrder = 'ymd'): string | undefined {
  const input = raw.trim();
  if (!input || !ALLOWED.test(input)) return undefined;
  let parts: string[];
  const compact = COMPACT.exec(input);
  if (compact) parts = compact.slice(1);
  else parts = input.split(SEPARATORS).filter(Boolean);
  if (parts.length !== 3) return undefined;
  let y: string, m: string, d: string;
  if (parts[0].length === 4) [y, m, d] = parts;
  else if (parts[2].length === 4 && order === 'dmy') [d, m, y] = parts;
  else if (parts[2].length === 4 && order === 'mdy') [m, d, y] = parts;
  else return undefined;
  if (m.length > 2 || d.length > 2) return undefined;
  const [yy, mm, dd] = [y, m, d].map(Number);
  const date = new Date(Date.UTC(yy, mm - 1, dd));
  if (date.getUTCFullYear() !== yy || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return undefined;
  return date.toISOString().slice(0, 10);
}

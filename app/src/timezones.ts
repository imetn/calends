/**
 * 全部 IANA 时区：名称用界面语言的时区名（日本標準時 · Tokyo），右侧标出当前偏移（GMT+9）；
 * 浏览器给不出本地名时（只得到 GMT±hh:mm）退回 IANA 名。搜索仍能按 IANA 英文名找到。当前值不在列表里时也保留
 */
export function timeZones(current: string, lang: string) {
  const all = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  const part = (z: string, timeZoneName: 'shortOffset' | 'longGeneric') => {
    try {
      return new Intl.DateTimeFormat(lang, { timeZone: z, timeZoneName }).formatToParts().find((p) => p.type === 'timeZoneName')?.value ?? '';
    } catch {
      return '';
    }
  };
  return [...new Set(['UTC', ...all, current])].map((z) => {
    const id = z.replace(/_/g, ' ');
    const name = z === 'UTC' ? '' : part(z, 'longGeneric');
    const city = id.split('/').pop()!;
    return { value: z, label: name && !/^(GMT|UTC)([+\-−]|$)/.test(name) ? `${name} · ${city}` : id, hint: part(z, 'shortOffset') };
  });
}

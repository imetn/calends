/** 写入剪贴板所需的最小浏览器接口，便于测试替换 */
export interface ClipboardEnv {
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } };
  document?: Document;
}

/**
 * 复制文字：优先异步剪贴板 API；非 HTTPS（如局域网 http://192.168.x.x）没有该 API，
 * 或被拒绝时，退回隐藏文本框 + execCommand('copy')。都失败才抛错。
 */
export async function writeClipboard(text: string, env: ClipboardEnv = globalThis as ClipboardEnv): Promise<void> {
  const api = env.navigator?.clipboard;
  if (api?.writeText) {
    try {
      await api.writeText(text);
      return;
    } catch {
      /* 再试回退方式 */
    }
  }
  const doc = env.document;
  if (!doc?.body) throw new Error('clipboard unavailable');
  const active = doc.activeElement as HTMLElement | null;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.opacity = '0';
  // 弹窗会把焦点锁在自己里面：文本框挂到触发按钮所在的弹窗里，否则选中后焦点被拉回、复制到空内容
  const host = active?.closest?.('[role="dialog"]') ?? doc.body;
  host.appendChild(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    ok = doc.execCommand('copy');
  } finally {
    area.remove();
    active?.focus?.({ preventScroll: true });
  }
  if (!ok) throw new Error('clipboard unavailable');
}

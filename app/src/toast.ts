import { toast as sonner } from 'sonner';
import { t } from '../../shared/i18n.ts';
import { writeClipboard } from './clipboard.ts';
// ---------- toast ----------
// 统一走 Sonner：成功、失败、提示、警告、进行中五种状态，可叠放、滑动关闭，可带「撤销」等操作按钮

export type ToastKind = 'success' | 'error' | 'info' | 'warning';
export interface ToastOptions {
  kind?: ToastKind;
  /** 第二行的补充说明 */
  description?: string;
  /** 例如「撤销」 */
  action?: { label: string; onClick: () => void };
  /** 替换已有的那条（例如把「进行中」换成结果） */
  id?: string | number;
}

/** 提示条：第二个参数是种类（缺省成功），或带撤销按钮、替换已有提示等选项 */
export function toast(text: string, how: ToastKind | ToastOptions = {}): string | number {
  const opts = typeof how === 'string' ? { kind: how } : how;
  const kind = opts.kind ?? 'success';
  return sonner[kind](text, { id: opts.id, description: opts.description, action: opts.action, duration: kind === 'error' ? 5000 : 2800 });
}

/** 复制文字：非 HTTPS 时退回旧式复制；仍失败（被拒绝、旧浏览器）才提示失败，不静默 */
export async function copyText(text: string, ok: string): Promise<boolean> {
  try {
    await writeClipboard(text);
    toast(ok);
    return true;
  } catch {
    toast(t('ai.copyFailed'), 'error');
    return false;
  }
}

/**
 * 执行一个操作并给出反馈：超过 400ms 还没完成就先显示「处理中」，完成后原地换成成功或失败。
 * ok 也可以是 ToastOptions（带撤销按钮等）。
 */
export async function run(fn: () => Promise<unknown>, ok?: string | (ToastOptions & { text: string })) {
  let pending: string | number | undefined;
  const timer = setTimeout(() => (pending = sonner.loading(t('ui.working'))), 400);
  try {
    await fn();
    clearTimeout(timer);
    if (ok) {
      const o = typeof ok === 'string' ? { text: ok } : ok;
      toast(o.text, { ...o, id: pending });
    } else if (pending !== undefined) sonner.dismiss(pending);
  } catch (e) {
    clearTimeout(timer);
    toast(e instanceof Error ? e.message : String(e), { kind: 'error', id: pending });
  }
}

// ---------- 界面配置：服务端为准，本机留一份副本供首屏和离线用 ----------

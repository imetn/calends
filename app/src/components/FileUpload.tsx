// 上传入口：选择文件与上传状态。文件页顶栏、订阅详情的回形针与拖入共用。
import { useRef, useState, type ReactNode } from 'react';
import { t } from '../../../shared/i18n.ts';
import { uploadFiles } from '../files.ts';
import { toast } from '../toast.ts';

const ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp';

/** 上传一批文件：返回正在传的（卡片先占位）与上传函数；结果汇总成一条提示 */
export function useUpload(anchor?: Parameters<typeof uploadFiles>[1]) {
  const [pending, setPending] = useState<Array<{ key: string; name: string }>>([]);
  const seq = useRef(0);
  const run = async (files: File[]) => {
    const batch = files.map((f) => ({ key: `u${++seq.current}`, name: f.name }));
    setPending((p) => [...batch, ...p]);
    try {
      const { done, failed } = await uploadFiles(files, anchor);
      if (failed.length)
        toast(t('files.failed', { count: failed.length }), { kind: 'error', description: failed.map((x) => `${x.name}: ${x.error}`).join('\n') });
      else if (done.length) toast(t('files.uploaded', { count: done.length }));
      return done;
    } finally {
      setPending((p) => p.filter((x) => !batch.includes(x)));
    }
  };
  return { pending, upload: (files: File[]) => void run(files), uploadAsync: run };
}

/** 隐藏的文件选择框：返回要放进页面的元素和打开系统选择窗口的函数（页面上不出现原生控件） */
export function useFilePicker(onFiles: (files: File[]) => void): [ReactNode, () => void] {
  const input = useRef<HTMLInputElement>(null);
  const el = (
    <input
      ref={input}
      type="file"
      accept={ACCEPT}
      multiple
      hidden
      onChange={(e) => {
        const files = [...(e.currentTarget.files ?? [])];
        e.currentTarget.value = '';
        if (files.length) onFiles(files);
      }}
    />
  );
  return [el, () => input.current?.click()];
}

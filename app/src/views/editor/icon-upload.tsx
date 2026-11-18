import { useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { t } from '../../../../shared/i18n.ts';
import type { Subscription } from '../../../../shared/types.ts';
import { compressIcon } from '../../handoff.ts';
import { toast } from '../../toast.ts';

/**
 * 订阅图标的本地上传：编辑页顶部的图标与「更多选项」里的上传按钮共用。
 * 返回隐藏的文件输入（需渲染出来）、打开选择框的方法，以及拖入、粘贴图片的处理函数。
 */
export function useIconUpload(up: (p: Partial<Subscription>) => void) {
  const file = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const upload = async (picked?: File) => {
    if (!picked || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      up({ icon: await compressIcon(picked) });
    } catch (error) {
      toast(error instanceof Error ? error.message : t('editor.field.iconUploadInvalid'), 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const input = (
    <input
      ref={file}
      type="file"
      hidden
      accept="image/png,image/jpeg,image/webp"
      onChange={(e) => {
        void upload(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );
  return {
    busy,
    input,
    open: () => file.current?.click(),
    onDragOver: (e: DragEvent) => e.preventDefault(),
    onDrop: (e: DragEvent) => {
      const picked = e.dataTransfer.files[0];
      if (!picked) return;
      e.preventDefault();
      void upload(picked);
    },
    onPaste: (e: ClipboardEvent) => {
      const picked = [...e.clipboardData.files][0];
      if (!picked) return;
      e.preventDefault();
      void upload(picked);
    },
  };
}

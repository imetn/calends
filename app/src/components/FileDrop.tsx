// 拖文件进窗口即上传：整页出现投放层，松手时投放口「吞」一下再淡出。文件页与订阅详情共用。
import '../files.css';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../../../shared/i18n.ts';
import { Icon } from './icons.tsx';

const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

type Phase = 'idle' | 'over' | 'gulp';

/** 同时有几处在接收（文件页上又打开了订阅详情）时，只有最后打开的那一处响应 */
const stack: object[] = [];

/** 在窗口任意位置拖入文件时显示投放层；enabled 为 false（只读、未启用存储、有弹窗盖住）时不响应 */
export function FileDrop({ enabled, onFiles }: { enabled: boolean; onFiles: (files: File[]) => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const depth = useRef(0);
  const deliver = useEffectEvent((files: File[]) => onFiles(files));
  // 暂不接收（弹窗盖住、只读）时也挡住浏览器默认行为：文件掉进页面不会把当前页换成那个文件
  useEffect(() => {
    const block = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    window.addEventListener('dragover', block);
    window.addEventListener('drop', block);
    return () => {
      window.removeEventListener('dragover', block);
      window.removeEventListener('drop', block);
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    const me = {};
    stack.push(me);
    const mine = (e: DragEvent) => hasFiles(e) && stack.at(-1) === me;
    let gulp: ReturnType<typeof setTimeout> | undefined;
    const enter = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      depth.current++;
      setPhase('over');
    };
    const over = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!mine(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setPhase('idle');
    };
    const drop = (e: DragEvent) => {
      if (!mine(e)) return;
      e.preventDefault();
      depth.current = 0;
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return setPhase('idle');
      setPhase('gulp');
      gulp = setTimeout(() => setPhase('idle'), 420);
      deliver(files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      clearTimeout(gulp);
      stack.splice(stack.indexOf(me), 1);
      depth.current = 0;
      setPhase('idle');
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [enabled]);
  if (phase === 'idle') return null;
  return createPortal(
    <div className={`file-drop ${phase}`} aria-hidden="true">
      <div className="file-drop-mouth">
        <span className="file-drop-ring" />
        <span className="file-drop-ring late" />
        <span className="file-drop-ico">
          <Icon name="upload" size={30} />
        </span>
        <b>{t('files.drop')}</b>
      </div>
    </div>,
    document.body,
  );
}

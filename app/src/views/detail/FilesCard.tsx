// 订阅详情的「文件」卡：有文件时才出现。挂在扣款、合同期上的文件同类多于一份时叠成一摞（点开可左右翻看），其余逐个列出；可拖文件进详情上传为资料。
import { createPortal } from 'react-dom';
import { useState } from 'react';
import { FILE_EXT, filesOf, type FileMeta } from '../../../../shared/files.ts';
import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';
import { Panel } from '../../components/DetailKit.tsx';
import { FileDrop } from '../../components/FileDrop.tsx';
import { fileLabel, FileSheet, FileThumb } from '../../components/FileSheet.tsx';
import { relinkFile, sizeLabel } from '../../files.ts';
import { useFilePicker, useUpload } from '../../components/FileUpload.tsx';
import { Icon } from '../../components/icons.tsx';
import { Cell, Group } from '../../components/ui.tsx';
import { useStore } from '../../store.ts';

/** 一摞文件覆盖的月份：同月只写一个 */
function span(g: FileMeta[]) {
  const months = g
    .map((f) => (f.date ?? '').slice(0, 7))
    .filter(Boolean)
    .sort();
  const [a, b] = [months[0], months.at(-1)];
  return !a ? '' : a === b ? a : `${a} – ${b}`;
}

/** 能不能往这个订阅上传：只读、没启用存储时不行 */
const STACKED = ['charge', 'contract'] as const;

export const canAttach = (state: AppState) => !state.readonly && state.filesEnabled !== false;

export function FilesCard({
  sub,
  state,
  today,
  pending,
  onFiles,
  onOpen,
}: {
  sub: Subscription;
  state: AppState;
  today: string;
  pending: Array<{ key: string; name: string }>;
  onFiles: (files: File[]) => void;
  onOpen?: (s: Subscription) => void;
}) {
  const all = state.files ?? [];
  const list = filesOf(all, sub.id);
  const [open, setOpen] = useState<{ id: string; group: FileMeta['kind'] | 'loose' }>();
  const can = canAttach(state);
  // 扣款凭证、合同常常每期一份，逐个列出会铺满详情：同类多于一份时叠成一摞
  const stacks = STACKED.map((kind) => list.filter((f) => f.kind === kind)).filter((g) => g.length > 1);
  const loose = list.filter((f) => !stacks.some((g) => g.includes(f)));
  return (
    <>
      {(list.length > 0 || pending.length > 0) && (
        <Panel className="dt-files" title={t('files.card')}>
          <div className="dt-file-list">
            {pending.map((p) => (
              <div key={p.key} className="dt-file loading" aria-busy="true">
                <span className="dt-file-thumb" />
                <span className="dt-file-text">
                  <b>{p.name}</b>
                </span>
              </div>
            ))}
            {stacks.map((g) => (
              <button key={g[0].kind} type="button" className="dt-file dt-file-stack" onClick={() => setOpen({ id: g[0].id, group: g[0].kind })}>
                <span className="dt-file-pile">
                  {g.slice(0, 3).map((f) => (
                    <span key={f.id} className="dt-file-thumb">
                      <FileThumb f={f} />
                    </span>
                  ))}
                </span>
                <span className="dt-file-text">
                  <b>
                    {t(`files.kind.${g[0].kind!}`)}
                    <span className="dt-file-count">{t('files.count', { count: g.length })}</span>
                  </b>
                  <span className="file-meta">
                    <span>{span(g)}</span>
                  </span>
                </span>
              </button>
            ))}
            {loose.map((f) => {
              const label = fileLabel(f, all, state.subscriptions);
              return (
                <button key={f.id} type="button" className="dt-file" onClick={() => setOpen({ id: f.id, group: 'loose' })}>
                  <span className="dt-file-thumb">
                    <FileThumb f={f} />
                  </span>
                  <span className="dt-file-text">
                    <b>{label.item ?? label.head}</b>
                    <span className="file-meta">
                      <span>{FILE_EXT[f.mime].toUpperCase()}</span>
                      <span>{sizeLabel(f.size)}</span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </Panel>
      )}
      <FileDrop enabled={can && !open} onFiles={onFiles} />
      {open &&
        createPortal(
          <FileSheet
            id={open.id}
            list={open.group === 'loose' ? loose : (stacks.find((g) => g[0].kind === open.group) ?? list)}
            state={state}
            today={today}
            onClose={() => setOpen(undefined)}
            onOpenSub={(id) => {
              setOpen(undefined);
              const s = state.subscriptions.find((x) => x.id === id);
              if (s && s.id !== sub.id) onOpen?.(s);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * 记一笔 / 改一笔扣款时的「文件」分组：传上去即挂在这笔扣款（订阅 + 日期）上，取消弹窗也保留；
 * 保存时日期改了，由调用方用 moveTo 把这里列出的文件一起挪到新日期
 */
export function useChargeFiles(sub: Subscription, today: string, date: string, originalDate?: string) {
  const { state } = useStore();
  const all = state?.files ?? [];
  const [mine, setMine] = useState<string[]>([]);
  const up = useUpload({ subId: sub.id, kind: 'charge', date });
  const add = (files: File[]) => void up.uploadAsync(files).then((done) => setMine((m) => [...m, ...done.map((f) => f.id)]));
  const [picker, pick] = useFilePicker(add);
  const list = all.filter((f) => mine.includes(f.id) || (!!originalDate && f.subId === sub.id && f.kind === 'charge' && f.date === originalDate));
  const [open, setOpen] = useState<string>();
  const can = !!state && canAttach(state);
  const moveTo = async (day: string) => {
    for (const f of list) if (f.subId === sub.id && f.kind === 'charge' && f.date !== day) await relinkFile(f, { subId: sub.id, kind: 'charge', date: day });
  };
  const group =
    state && (can || list.length > 0) ? (
      <Group title={t('files.card')}>
        {list.map((f) => (
          <Cell key={f.id} label={f.name} sub={`${FILE_EXT[f.mime].toUpperCase()}\n${sizeLabel(f.size)}`} onClick={() => setOpen(f.id)} />
        ))}
        {up.pending.map((p) => (
          <Cell key={p.key} label={p.name} />
        ))}
        {can && (
          <button type="button" className="cell tap pay-split-add" onClick={pick}>
            <Icon name="upload" />
            {t('files.add')}
          </button>
        )}
        {picker}
        <FileDrop enabled={can && !open} onFiles={add} />
        {open && createPortal(<FileSheet id={open} list={list} state={state} today={today} onClose={() => setOpen(undefined)} />, document.body)}
      </Group>
    ) : null;
  // 还在传的文件保存时挪不过去：传完才能保存
  return { group, moveTo, uploading: up.pending.length > 0 };
}

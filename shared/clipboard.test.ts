import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeClipboard, type ClipboardEnv } from '../app/src/clipboard.ts';

/** 最小的假 document：记录 execCommand 调用与文本框的增删 */
function fakeDoc(copyOk: boolean, dialog = false) {
  const log: string[] = [];
  let focused = false;
  const modal = { appendChild: () => log.push('append:dialog') };
  const area = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: () => {},
    select: () => log.push('select'),
    setSelectionRange: () => {},
    remove: () => log.push('remove'),
  };
  const doc = {
    body: { appendChild: () => log.push('append') },
    activeElement: { focus: () => (focused = true), closest: (sel: string) => (dialog && sel === '[role="dialog"]' ? modal : null) },
    createElement: () => area,
    execCommand: (cmd: string) => {
      log.push(`exec:${cmd}:${area.value}`);
      return copyOk;
    },
  };
  return { doc: doc as unknown as Document, log, area, focused: () => focused };
}

test('Issue #28：局域网 http 没有异步剪贴板 API 时退回旧式复制，复制完整文本并还原焦点', async () => {
  const d = fakeDoc(true);
  await writeClipboard('完整回复\n第二行', { navigator: {}, document: d.doc });
  assert.deepEqual(d.log, ['append', 'select', 'exec:copy:完整回复\n第二行', 'remove']);
  assert.equal(d.focused(), true);
});

test('异步剪贴板可用时直接写入，不碰 DOM；被拒绝时再退回旧式复制', async () => {
  let wrote = '';
  const d = fakeDoc(true);
  await writeClipboard('a', { navigator: { clipboard: { writeText: async (s) => void (wrote = s) } }, document: d.doc });
  assert.equal(wrote, 'a');
  assert.deepEqual(d.log, []);

  const denied: ClipboardEnv = { navigator: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } }, document: d.doc };
  await writeClipboard('b', denied);
  assert.deepEqual(d.log, ['append', 'select', 'exec:copy:b', 'remove']);
});

test('两种方式都失败才抛错（交给调用方提示复制失败），文本框不残留', async () => {
  const d = fakeDoc(false);
  await assert.rejects(writeClipboard('x', { navigator: {}, document: d.doc }));
  assert.deepEqual(d.log.at(-1), 'remove');
  await assert.rejects(writeClipboard('x', { navigator: {} }));
});

test('在弹窗里复制：文本框挂进弹窗，不被弹窗的焦点锁拉走', async () => {
  const d = fakeDoc(true, true);
  await writeClipboard('ics', { navigator: {}, document: d.doc });
  assert.equal(d.log[0], 'append:dialog');
});

test('没有剪贴板 API 时旧式复制同步完成，仍在点击手势内', () => {
  const d = fakeDoc(true);
  void writeClipboard('sync', { navigator: {}, document: d.doc });
  assert.ok(d.log.includes('exec:copy:sync'));
});

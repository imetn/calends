import { readStored, storageKey } from '../../base.ts';
import type { Subscription } from '../../../../shared/types.ts';
import { type StopForm } from '../../../../shared/stop-form.ts';
import type { LinkedPlan } from './linked.ts';

/**
 * 表单草稿：关掉时有改动就存一份，下次打开接着填，不再弹「放弃修改？」。
 * 新建共用一份，编辑按订阅各存一份；只存在本机。编辑的订阅在别处改过后，旧草稿作废
 */
export interface Draft {
  form: Subscription;
  basePrice: number;
  stop?: StopForm;
  /** 本次编辑暂存的关联子订阅变更 */
  linked?: LinkedPlan;
  /** 打开表单时订阅的样子：和现在不一样说明别处改过，草稿不再适用 */
  base: string;
}

export const draftKey = (isNew: boolean, id: string) => `ledger:draft:${isNew ? 'new' : id}`;

/** 比较表单内容时不看 id：清空后的新表单 id 不同，但内容是空的 */
export const sig = (x: Subscription) => JSON.stringify({ ...x, id: '' });

export function readDraft(key: string, base: string): Draft | undefined {
  try {
    const d = JSON.parse(readStored(key) ?? 'null') as Draft | null;
    if (d && d.base === base) return d;
    localStorage.removeItem(storageKey(key));
  } catch {
    /* 隐私模式或坏数据 */
  }
  return undefined;
}

export function writeDraft(key: string, d: Draft | undefined) {
  try {
    if (d) localStorage.setItem(storageKey(key), JSON.stringify(d));
    else localStorage.removeItem(storageKey(key));
  } catch {
    /* ignore */
  }
}

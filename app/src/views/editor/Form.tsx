import { useEditorFields } from './useEditorFields.ts';
import { BillingFields, StatusFields, SharingFields, MoreFields } from './Sections.tsx';

import { copyParts } from '../../components/copy.tsx';
import { type CSSProperties, type ReactNode } from 'react';

import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';

import { SubIcon } from '../../components/marks.tsx';
import { Pencil } from '../../components/ui-icons.tsx';
import { useIconUpload } from './icon-upload.tsx';

import { Icon } from '../../components/icons.tsx';

import { catColor, presetCat } from '../../derive.ts';
import { CategorySheet } from '../Categories.tsx';
import { type StopForm } from '../../../../shared/stop-form.ts';

import { TransferSheet } from '../../components/TransferSheet.tsx';
import { LinkedSubSheet } from './LinkedSubSheet.tsx';
import { childrenOf } from '../../../../shared/bundle.ts';
import type { LinkedChildChange, LinkedChildView, LinkedPlan } from './linked.ts';

import { GENRE_CAT } from './NameField.tsx';
import { NameField } from './NameField.tsx';

// 按订阅生命周期排列：先试用，再计费，可暂停，最后停止

export function Form({
  isNew,
  stop,
  setStop,
  f,
  setF,
  up,
  linked,
  setLinked,
  state,
  today,
  history,
}: {
  isNew: boolean;
  stop?: StopForm;
  setStop: (value: StopForm | undefined) => void;
  f: Subscription;
  setF: (s: Subscription) => void;
  up: (p: Partial<Subscription>) => void;
  linked: LinkedPlan;
  setLinked: (value: LinkedPlan | ((prev: LinkedPlan) => LinkedPlan)) => void;
  state: AppState;
  today: string;
  history?: ReactNode;
}) {
  const context = useEditorFields({ isNew, stop, setStop, f, setF, up, linked, setLinked, state, today, history });
  const pick = useIconUpload(up);
  const { method, lt, extras, transfer, setTransfer, bundleSheet, setBundleSheet, more, setMore, newCat, setNewCat, plans, loadPlans } = context;
  const savedChildren = new Map(childrenOf(f.id, state.subscriptions, today).map((c) => [c.sub.id, c.link.follow !== false]));
  const applyLinkedUpsert = (change: LinkedChildChange) => {
    setLinked((prev) => {
      if (change.kind === 'new') {
        const rest = prev.upsert.filter((x) => !(x.kind === 'new' && x.id === change.id));
        return { ...prev, upsert: [...rest, change] };
      }
      const unlink = prev.unlink.filter((id) => id !== change.subId);
      const rest = prev.upsert.filter((x) => !(x.kind === 'existing' && x.subId === change.subId));
      // 恢复成账本里原有的跟随模式时不再记为改动
      const sameAsSaved = savedChildren.has(change.subId) && savedChildren.get(change.subId) === change.follow;
      return { unlink, upsert: sameAsSaved ? rest : [...rest, change] };
    });
  };
  const applyLinkedRemove = (item: LinkedChildView) => {
    setLinked((prev) => {
      if (item.kind === 'new') return { ...prev, upsert: prev.upsert.filter((x) => !(x.kind === 'new' && x.id === item.id)) };
      const upsert = prev.upsert.filter((x) => !(x.kind === 'existing' && x.subId === item.id));
      if (item.kind === 'existing') return { ...prev, upsert };
      return { upsert, unlink: prev.unlink.includes(item.id) ? prev.unlink : [...prev.unlink, item.id] };
    });
  };
  return (
    <div className="ed">
      {/* 一、是什么：图标 + 名称（输入时联想 App Store）+ 分类 */}
      <div className="ed-id">
        {/*
          填了名称、图标或网址：直接显示它最终的样子（真实图标，或分类色方块加首字母）；
          还没填名称：同样大小的方块淡淡铺上分类色，预告将来的样子，换分类颜色跟着变
        */}
        {/* 点图标（或拖入、粘贴图片）即上传自定义图标；悬停时盖一层半透明铅笔提示 */}
        <button
          type="button"
          className="ed-id-icon"
          aria-label={t('editor.field.iconChange')}
          title={t('editor.field.iconUploadHelp')}
          disabled={pick.busy}
          onClick={pick.open}
          onDragOver={pick.onDragOver}
          onDrop={pick.onDrop}
          onPaste={pick.onPaste}
        >
          {f.icon || f.url || f.name.trim() ? (
            <SubIcon sub={f} size={36} />
          ) : (
            <span className="ico ed-id-ghost" style={{ '--s': '36px', '--tint': catColor(f.category) } as CSSProperties} aria-hidden="true" />
          )}
          <span className="ed-id-edit" aria-hidden="true">
            <Pencil size={15} strokeWidth={2.2} />
          </span>
        </button>
        {pick.input}
        <div className="ed-id-main">
          <NameField
            value={f.name}
            region={(f.region || method?.region || 'us').toLowerCase()}
            onChange={(name) => {
              up({ name });
              if (plans) loadPlans();
            }}
            onPick={(h) => {
              loadPlans(h);
              up({
                // 「Spotify: Music and Podcasts」只取冒号、破折号前的产品名
                name: h.name.split(/\s*[:：|]\s*|\s[-–—]\s/)[0].trim(),
                icon: h.icon,
                ...(isNew && f.cancelLeadDays == null ? { cancelLeadDays: 1 } : {}),
                url: f.url || h.url,
                // 只有粘贴的链接里带了地区才填，按名称搜时不猜
                ...(h.fromLink && !f.region && h.country !== 'cn' ? { region: h.country!.toUpperCase() } : {}),
                // 分类按 App Store 的类别给个默认值，已经选过的不动
                ...(!f.name.trim() || f.category === presetCat('tools') ? { category: GENRE_CAT[h.genre] ? presetCat(GENRE_CAT[h.genre]) : f.category } : {}),
              });
            }}
            onPickCatalog={(c) => {
              loadPlans();
              up({
                name: c.name,
                icon: c.icon,
                url: f.url || c.url,
                category: c.category,
                ...(isNew ? { chargeLeadDays: f.chargeLeadDays ?? c.chargeLeadDays, cancelLeadDays: f.cancelLeadDays ?? c.cancelLeadDays } : {}),
              });
            }}
          />
        </div>
      </div>

      {/* 二、怎么付钱 */}
      <BillingFields context={context} />

      {/* 三、现在的状态 */}
      {!lt && <StatusFields context={context} />}

      {/* 四、谁在用 */}
      <SharingFields context={context} />

      {history}

      {/* 最后放不常用的选项，标题上列出已设置的项 */}
      <button type="button" className={`ed-more ${more ? 'open' : ''}`} onClick={() => setMore(!more)} aria-expanded={more}>
        <span>{t('editor.more.title')}</span>
        <small>{copyParts(extras.length ? extras.join('\n') : t(lt ? 'editor.more.summaryLt' : 'editor.more.summary'))}</small>
        <Icon name="down" size={14} />
      </button>
      <MoreFields context={context} />
      {transfer && (
        <TransferSheet
          list={f.transfers ?? []}
          index={transfer.index}
          currency={f.currency}
          today={today}
          onSave={(next) => {
            up({ transfers: next.length ? next : undefined });
            setTransfer(null);
          }}
          onClose={() => setTransfer(null)}
        />
      )}
      {bundleSheet && (
        <LinkedSubSheet
          parent={f}
          isNewParent={isNew}
          state={state}
          today={today}
          linked={linked}
          edit={bundleSheet.edit}
          onSave={applyLinkedUpsert}
          onRemove={applyLinkedRemove}
          onClose={() => setBundleSheet(null)}
        />
      )}
      {newCat && <CategorySheet state={state} onClose={() => setNewCat(false)} onSaved={(name) => up({ category: name })} />}
    </div>
  );
}

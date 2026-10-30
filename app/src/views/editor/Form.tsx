import { useEditorFields } from './useEditorFields.ts';
import { BillingFields, StatusFields, SharingFields, MoreFields } from './Sections.tsx';

import { copyParts } from '../../components/copy.tsx';
import { type CSSProperties, type ReactNode } from 'react';

import { t } from '../../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../../shared/types.ts';

import { SubIcon } from '../../components/marks.tsx';

import { Icon } from '../../components/icons.tsx';

import { catColor, presetCat } from '../../derive.ts';
import { CategorySheet } from '../Categories.tsx';
import { type StopForm } from '../../../../shared/stop-form.ts';

import { TransferSheet } from '../../components/TransferSheet.tsx';

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
  state: AppState;
  today: string;
  history?: ReactNode;
}) {
  const context = useEditorFields({ isNew, stop, setStop, f, setF, up, state, today, history });
  const { method, lt, extras, transfer, setTransfer, more, setMore, newCat, setNewCat, plans, loadPlans } = context;
  return (
    <div className="ed">
      {/* 一、是什么：图标 + 名称（输入时联想 App Store）+ 分类 */}
      <div className="ed-id">
        {/*
          填了名称、图标或网址：直接显示它最终的样子（真实图标，或分类色方块加首字母）；
          还没填名称：同样大小的方块淡淡铺上分类色，预告将来的样子，换分类颜色跟着变
        */}
        {f.icon || f.url || f.name.trim() ? (
          <SubIcon sub={f} size={36} />
        ) : (
          <span className="ico ed-id-ghost" style={{ '--s': '36px', '--tint': catColor(f.category) } as CSSProperties} aria-hidden="true" />
        )}
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
            onPickLogo={(icon) => up({ icon })}
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
      {newCat && <CategorySheet state={state} onClose={() => setNewCat(false)} onSaved={(name) => up({ category: name })} />}
    </div>
  );
}

import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { useEditorDraft } from './editor/useEditorDraft.ts';
import { prepareEditorSave, mergeEditorSave } from './editor/save.ts';

import { ReceiptText } from 'lucide-react';
import { compressImage, handoff } from '../handoff.ts';
import { t } from '../../../shared/i18n.ts';
import type { AppState, Subscription } from '../../../shared/types.ts';
import { ask, Sheet } from '../components/overlays.tsx';
import { useSubmit } from '../components/inputs.tsx';

import { pauseDay } from '../../../shared/billing.ts';
import { affectedPriceCharges } from '../../../shared/phases.ts';
import { ChangePanel } from '../components/ChangePanel.tsx';

import { deleteSub, getState, savePerson, saveSettings, saveSub } from '../store.ts';
import { run } from '../toast.ts';
import { linkPerson } from './person-fields.tsx';

import { writeDraft } from './editor/draft.ts';
import { Form } from './editor/Form.tsx';

export function Editor({ sub, state, today, onClose }: { sub: Subscription; state: AppState; today: string; onClose: () => void }) {
  const { isNew, key, restored, priceValid, setPriceValid, historyReset, f, setF, up, stop, setStop, basePrice, dirty, close, reset } = useEditorDraft({
    sub,
    state,
    today,
    onClose,
  });
  /** 交给 AI 助手：已经填的名称一并带过去 */
  const toAssistant = (images: string[] = []) => {
    close();
    handoff(f.name.trim() ? `${f.name.trim()}\n` : '', images);
  };

  const [busy, submit] = useSubmit();
  const save = async () => {
    if (!priceValid) return;
    let out: Subscription;
    try {
      out = prepareEditorSave(sub, f, today, isNew, basePrice, stop);
    } catch (e) {
      await run(async () => {
        throw e;
      });
      return;
    }
    const affected = !isNew && affectedPriceCharges(sub, out, today);
    if (affected && !(await ask(t('editor.history.repriceCharges', { count: affected })))) return;
    await run(
      async () => {
        if (out.status === 'paused' && !out.pausedAt) out.pausedAt = pauseDay(out, today);
        if (out.status !== 'paused') delete out.pausedAt;
        // 代付对象：新的人先建档，已有的人改了资料等订阅保存后再同步
        const px = out.proxy;
        const link: Awaited<ReturnType<typeof linkPerson>> = px
          ? await linkPerson(state, px.personId, px.forName, px.contact ? (px.contactVia ?? 'Telegram') : undefined, px.contact)
          : {};
        if (px) out = { ...out, proxy: { ...px, forName: px.forName.trim(), personId: link.id } };
        const latest = getState().subscriptions.find((x) => x.id === sub.id);
        const final = mergeEditorSave(sub, out, latest, isNew);
        await saveSub(final);
        if (link.after) await savePerson(link.after);
        writeDraft(key, undefined);
        onClose();
      },
      t(isNew ? 'editor.toast.added' : 'editor.toast.saved'),
    );
  };

  return (
    <Sheet
      narrow
      title={isNew ? t('editor.addTitle') : t('editor.editTitle', { name: sub.name })}
      onClose={close}
      foot={
        <>
          {!isNew && (
            <ConfirmButton
              hint={t('editor.confirmDelete', { name: sub.name })}
              onConfirm={() => {
                // 删除会把它移出公开页隐藏列表；撤销时一并放回
                const hidden = getState().settings.publicHidden?.includes(sub.id);
                const restore = async () => {
                  await saveSub(sub);
                  const list = getState().settings.publicHidden ?? [];
                  if (hidden && !list.includes(sub.id)) await saveSettings({ publicHidden: [...list, sub.id] });
                };
                run(
                  async () => {
                    await deleteSub(sub.id);
                    writeDraft(key, undefined);
                    onClose();
                  },
                  // 删了还能撤销：把删掉的订阅原样存回去
                  { text: t('editor.toast.deleted'), action: { label: t('ui.undo'), onClick: () => void run(restore, t('ui.restored')) } },
                );
              }}
            >
              {t('common.delete')}
            </ConfirmButton>
          )}
          {dirty ? (
            <button className="btn plain" onClick={reset}>
              {isNew ? t('editor.clearForm') : t('editor.revert')}
            </button>
          ) : null}
          <span className="grow" />
          <button
            className="btn"
            onClick={() => {
              writeDraft(key, undefined);
              onClose();
            }}
          >
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || !f.name.trim() || !priceValid} onClick={() => void submit(save)}>
            {isNew ? t('common.add') : t('common.done')}
          </button>
        </>
      }
    >
      {restored && dirty && <div className="ed-draft">{t('editor.draftRestored')}</div>}
      {isNew && (
        <button type="button" className="ed-ai" onClick={() => toAssistant()}>
          <span className="ed-ai-ico">
            <ReceiptText size={18} />
          </span>
          <span className="ed-ai-text">
            <b>{t('editor.ai.title')}</b>
          </span>
          <span className="ed-ai-go">{t('editor.ai.go')}</span>
        </button>
      )}
      <div
        onPaste={(e) => {
          // 新建时在表单里粘贴截图：交给 AI 助手识别
          const files = isNew ? [...e.clipboardData.files].filter((x) => x.type.startsWith('image/')) : [];
          if (!files.length) return;
          e.preventDefault();
          void Promise.all(files.slice(0, 8).map(compressImage)).then(toAssistant, () => toAssistant());
        }}
      >
        <Form
          key={historyReset}
          isNew={isNew}
          f={f}
          setF={setF}
          up={up}
          state={state}
          today={today}
          stop={stop}
          setStop={setStop}
          history={!isNew && <ChangePanel key={historyReset} f={f} setF={setF} state={state} today={today} onPriceValidity={setPriceValid} />}
        />
      </div>
    </Sheet>
  );
}

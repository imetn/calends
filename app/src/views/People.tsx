import { MemberSheet } from './Members.tsx';
import { copyParts } from '../components/copy.tsx';
import { useState } from 'react';
import { PersonAvatar } from '../components/PersonAvatar.tsx';
import { flow, cnDateAuto, money } from '../../../shared/format.ts';
import { locale, t } from '../../../shared/i18n.ts';
import { SortControl } from '../components/SortControl.tsx';
import { isMarked, nextSort, usePhone } from '../components/LtHead.tsx';
import { personLink, peopleLedger, peopleListRows, type PeopleSort, type PersonLedger } from '../../../shared/people.ts';
import { PERSON_COLORS, type AppState, type Person, type Subscription } from '../../../shared/types.ts';
import { Group, IconButton, MetricCards, Metric, Toolbar } from '../components/ui.tsx';
import { Amount, Seg, useSubmit } from '../components/inputs.tsx';
import { Sheet } from '../components/overlays.tsx';
import { getState, savePerson } from '../store.ts';
import { run } from '../toast.ts';
import { Icon } from '../components/icons.tsx';
import { SubIcon } from '../components/marks.tsx';
import { contactValue } from '../components/Contact.tsx';
import './people-list.css';
import { FamilyTabs } from './person-fields.tsx';
import { PersonSheet, ProfileFields } from './PersonProfile.tsx';

/** 选人：已有的人（可搜索）或「新的人」；选中已有的人时把称呼、联系方式带过去 */
/** 人员表各列的默认方向：称呼 A→Z，金额与日期大的、近的在前 */
export const PEOPLE_DIR: Record<PeopleSort, 'asc' | 'desc'> = { owed: 'desc', received: 'desc', lastPaid: 'desc', name: 'asc' };

/** 人：每个人在哪些合租、代付里，现在欠多少、至今收回多少、最近一次收款 */
export function PeopleView({ state, today, onOpen }: { state: AppState; today: string; onOpen: (s: Subscription) => void }) {
  const base = state.settings.baseCurrency;
  const book = peopleLedger(state, today);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<'all' | 'owe' | 'settled'>('all');
  const [sort, setSort] = useState<PeopleSort>('owed');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const phone = usePhone();
  const chooseSort = (key: PeopleSort) => {
    setSort(key);
    setDir(PEOPLE_DIR[key]);
  };
  // 表头三态：该列默认方向、反向、回到默认（待收多的在前）；默认排序不标箭头，与合租、代付表一致
  const toggleSort = (key: PeopleSort) => {
    const [ns, nd] = nextSort(key, sort, dir, PEOPLE_DIR, 'owed');
    setSort(ns);
    setDir(nd);
  };
  const marked = (key: PeopleSort) => isMarked(key, sort, dir, ['owed', PEOPLE_DIR.owed]);
  const rows = peopleListRows(book, { filter, sort, dir, locale: locale() });
  const owing = peopleListRows(book, { filter: 'owe' });
  const counts = { all: book.length, owe: owing.length, settled: peopleListRows(book, { filter: 'settled' }).length };
  const columns: Array<[PeopleSort, string]> = [
    ['name', t('family.member.name')],
    ['owed', t('people.sheet.owed')],
    ['received', t('people.sheet.received')],
    ['lastPaid', t('people.sheet.last')],
  ];
  const owed = book.some((l) => !Number.isFinite(l.owed)) ? NaN : owing.reduce((a, l) => a + l.owed, 0);
  const received = book.reduce((a, l) => a + l.received, 0);
  const inShare = book.filter((l) => l.items.some((i) => i.kind === 'share')).length;
  const inProxy = book.filter((l) => l.items.some((i) => i.kind === 'proxy')).length;
  const current = open ? book.find((l) => (l.person.id || l.person.name) === open) : undefined;
  return (
    <>
      {/* 筛选与「合租」页同位置：工具栏右上角 */}
      {/* 右上角 + 单独新建人员，放在筛选左侧；侧栏「新建」只建订阅，所以桌面上始终显示 */}
      <Toolbar title={t('family.pool.title')} onAdd={() => setAdding(true)} addLabel={t('people.pick.new')}>
        {!state.readonly && (
          <IconButton className="accent d-only" onClick={() => setAdding(true)} aria-label={t('people.pick.new')}>
            <Icon name="plus" />
          </IconButton>
        )}
        {book.length > 0 && (
          <Seg
            small
            value={filter}
            onChange={setFilter}
            options={(['all', 'owe', 'settled'] as const).map((key) => [key, `${t(`family.pool.filter.${key}`)} ${counts[key]}`])}
          />
        )}
        {/* 桌面在表头排序，右上角不再重复；手机上表头收起，排序按钮只在手机出现 */}
        {phone && book.length > 0 && (
          <SortControl
            value={sort}
            dir={dir}
            onSort={chooseSort}
            onDir={setDir}
            options={[
              { value: 'owed', label: t('family.sort.owed') },
              { value: 'received', label: t('family.sort.received') },
              { value: 'lastPaid', label: t('family.sort.lastPaid') },
              { value: 'name', label: t('list.sort.name') },
            ]}
          />
        )}
        <FamilyTabs tab="people" />
        {/* 与合租页一样右上角最后是卡片 / 列表切换；人员只有列表，卡片不可选 */}
        {!phone && (
          <Seg
            small
            value="list"
            onChange={() => {}}
            disabledKeys={['grid']}
            options={[
              ['grid', t('list.view.grid')],
              ['list', t('list.view.list')],
            ]}
          />
        )}
      </Toolbar>
      <div className="page fade-in stack people-page">
        <MetricCards>
          <Metric
            label={t('people.stat.owed')}
            value={<Amount plain value={owed} ccy={base} />}
            valueStyle={{ color: owed > 0 ? 'var(--orange)' : undefined }}
            note={owing.length ? t('people.stat.owedSub', { count: owing.length }) : Number.isFinite(owed) ? t('people.stat.allSettled') : '—'}
          />
          <Metric label={t('people.stat.received')} value={<Amount value={received} ccy={base} />} note={t('people.stat.receivedSub')} />
          <Metric
            label={t('people.stat.count')}
            value={<span className="amt">{book.length}</span>}
            note={copyParts(t('people.stat.countSub', { share: inShare, proxy: inProxy }))}
          />
        </MetricCards>
        {book.length === 0 ? (
          <div className="card empty">
            <b>{t('people.empty.title')}</b>
            {t('people.empty.body')}
          </div>
        ) : (
          <>
            <div className="card people-list" role="table" aria-label={t('people.tab.people')}>
              <div className="people-head table-head" role="row">
                {columns.flatMap(([key, label], index) => [
                  <div key={key} role="columnheader" aria-sort={sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
                    <button className={`lt-sort ${marked(key) ? 'on' : ''}`} onClick={() => toggleSort(key)}>
                      {label}
                      {marked(key) && <Icon name={dir === 'asc' ? 'arrow-up' : 'arrow-down'} size={12} />}
                    </button>
                  </div>,
                  ...(index === 0
                    ? [
                        <div key="plans" role="columnheader">
                          {t('app.nav.list')}
                        </div>,
                      ]
                    : []),
                ])}
              </div>
              {rows.map((l) => (
                <PersonRow key={l.person.id || l.person.name} l={l} base={base} today={today} onClick={() => setOpen(l.person.id || l.person.name)} />
              ))}
              {rows.length === 0 && <div className="empty">{t('people.list.none')}</div>}
            </div>
          </>
        )}
      </div>
      {adding && <NewPersonSheet onClose={() => setAdding(false)} onSaved={(id) => setOpen(id)} />}
      {current && <PersonSheet memberDialog={MemberSheet} state={state} today={today} l={current} onOpen={onOpen} onClose={() => setOpen(null)} />}
    </>
  );
}

export function PersonRow({ l, base, today, onClick }: { l: PersonLedger; base: string; today: string; onClick: () => void }) {
  // 列表里只写联系方式本身，不带渠道名
  const contact = contactValue(l.person);
  // One icon per subscription, while retaining all account names in its tooltip.
  const plans = [...new Map(l.items.map((i) => [i.sub.id, i.sub])).values()];
  const planTitle = (id: string) =>
    l.items
      .filter((i) => i.sub.id === id)
      .map((i) => [i.sub.name, i.member?.account].filter(Boolean).join('\n'))
      .join('\n');
  return (
    <div className="people-row" role="row" onClick={onClick}>
      <div className="people-identity" role="cell">
        <span className="people-person">
          {/* 人员一律用胶囊（头像 + 称呼），与合租成员、代付对象一致 */}
          <button
            className="people-open car-member-chip"
            title={l.person.name}
            onClick={(e) => {
              e.stopPropagation();
              onClick();
            }}
          >
            <PersonAvatar p={l.person} size={24} />
            <span className="text-ellipsis">{l.person.name}</span>
          </button>
          {contact && (
            <small className="muted text-ellipsis" title={contact}>
              {contact}
            </small>
          )}
        </span>
      </div>
      <div className="people-plans" role="cell">
        {plans.length ? (
          plans.slice(0, 4).map((sub) => (
            <span key={sub.id} title={planTitle(sub.id)} aria-label={planTitle(sub.id)}>
              <SubIcon sub={sub} size={22} />
            </span>
          ))
        ) : (
          <span className="muted">—</span>
        )}
        {plans.length > 4 && (
          <span
            className="people-more"
            title={plans
              .slice(4)
              .map((sub) => planTitle(sub.id))
              .join('\n')}
          >
            +{plans.length - 4}
          </span>
        )}
      </div>
      {/* 待收与收款状态合成一列：欠款写「金额 · 欠 N 期」，结清写「已结清」，不留空格子 */}
      <div className="people-owed" role="cell">
        {!Number.isFinite(l.owed) ? (
          <span className="muted">—</span>
        ) : l.owed > 0.005 ? (
          <>
            <b>{money(l.owed, base)}</b>
            <small>{t('people.item.owedPeriods', { count: l.periodsOwed })}</small>
          </>
        ) : (
          <span className="people-settled">{t('family.pool.settled')}</span>
        )}
      </div>
      <div className={`people-received ${l.received ? '' : 'muted'}`} role="cell">
        {l.received ? flow(l.received, base) : '—'}
      </div>
      <div className="people-last muted" role="cell">
        {l.lastPaid && <span className="people-last-label">{t('people.sheet.last')} </span>}
        {l.lastPaid ? cnDateAuto(l.lastPaid, today) : t('people.item.noPay')}
      </div>
    </div>
  );
}

/** 单独新建人员：与人员详情同一套资料表单；之后在合租或代付里选他。重名且联系方式对得上时不重复建档 */
function NewPersonSheet({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void }) {
  // 颜色先随机定好，预览里的头像和保存后的一致
  const [f, setF] = useState<Person>(() => ({ id: '', name: '', color: PERSON_COLORS[Math.floor(Math.random() * PERSON_COLORS.length)] }));
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [busy, submit] = useSubmit();
  const save = () =>
    submit(() =>
      run(async () => {
        const link = personLink(getState().people ?? [], {
          name: f.name,
          contactVia: f.contact ? (f.contactVia ?? 'Telegram') : undefined,
          contact: f.contact,
        });
        if (!link.created) throw new Error(t('people.add.exists', { name: f.name.trim() }));
        await savePerson({ ...link.created, note: f.note?.trim() || undefined, color: f.color, avatar: f.avatar });
        onClose();
        onSaved(link.created.id);
      }, t('people.add.saved')),
    );
  return (
    <Sheet
      narrow
      title={t('people.pick.new')}
      onClose={onClose}
      foot={
        <>
          <span className="grow" />
          <button className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button className="btn primary" disabled={busy || avatarBusy || !f.name.trim()} onClick={() => void save()}>
            {t('common.add')}
          </button>
        </>
      }
    >
      <Group>
        <ProfileFields f={f} setF={setF} busy={avatarBusy} setBusy={setAvatarBusy} autoFocus />
      </Group>
    </Sheet>
  );
}

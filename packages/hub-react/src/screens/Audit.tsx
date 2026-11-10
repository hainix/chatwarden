import { AUDIT_ACTIONS } from '@chatwarden/core';
import { useId, useRef, useState } from 'react';
import { useHub } from '../context.js';
import type { HubT, HubText } from '../i18n.js';
import { personTag } from '../format.js';
import { usePagedList } from '../hooks.js';
import { errorText } from '../labels.js';
import type { Route } from '../router.js';
import type { AuditAction, AuditItem } from '../types.js';
import { Empty, ErrorBlock, Link, Loading, Notice, Panel, Scroll, Time } from '../ui.js';

/** Entries asked for per page. */
export const AUDIT_PAGE = 50;

// One plain label for each action the kit records, typed against the kit's own list: a new action is a compile error until it has
// a word here. An action from a newer kit than this hub is shown as it is.
const LABEL: Record<AuditAction, HubText> = {
  'report.view': 'hub.audit.label.report.view',
  'report.decide': 'hub.audit.label.report.decide',
  'sanction.apply': 'hub.audit.label.sanction.apply',
  'sanction.revoke': 'hub.audit.label.sanction.revoke',
  'gap.close': 'hub.audit.label.gap.close',
  'term.add': 'hub.audit.label.term.add',
  'term.update': 'hub.audit.label.term.update',
  'term.toggle': 'hub.audit.label.term.toggle',
  'exception.add': 'hub.audit.label.exception.add',
  'exception.update': 'hub.audit.label.exception.update',
  'exception.toggle': 'hub.audit.label.exception.toggle',
  'history.view': 'hub.audit.label.history.view',
  suggest: 'hub.audit.label.suggest',
  'policy.view': 'hub.audit.label.policy.view',
  'blocked.view': 'hub.audit.label.blocked.view',
  'case.takeover': 'hub.audit.label.case.takeover',
  'reason.add': 'hub.audit.label.reason.add',
  'reason.update': 'hub.audit.label.reason.update',
  'reason.toggle': 'hub.audit.label.reason.toggle',
};

/** What the hub's routes accept for an id in an address (the same pattern the router uses). */
const ROUTABLE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What an entry points at. A person or report is a short tag and a link (the address holds the id the route needs; the text never
 * does). A term or exception is only "A term": its row id can be the word itself, so it is never printed.
 */
function Target({ item }: { item: AuditItem }) {
  const { t, can } = useHub();
  const target = item.target;
  if (target === undefined) return <span className="cw-hint">{t('hub.audit.target.none')}</span>;
  const tag = personTag(target.ref);
  const routable = ROUTABLE.test(target.ref);
  const link = (to: Route, text: string, allowed: boolean) =>
    allowed && routable ? (
      <Link to={to} className="cw-link">
        {text}
      </Link>
    ) : (
      <span>{text}</span>
    );
  switch (target.type) {
    case 'person':
      return link({ name: 'person', ref: target.ref }, t('hub.audit.target.person', { tag }), can('history.read'));
    case 'report':
      return link({ name: 'report', id: target.ref }, t('hub.audit.target.report', { tag }), can('reports.read'));
    case 'sanction':
      return <span>{t('hub.audit.target.sanction', { tag })}</span>;
    case 'term':
      return <span>{t('hub.audit.target.term')}</span>;
    case 'exception':
      return <span>{t('hub.audit.target.exception')}</span>;
    case 'reason':
      return <span>{t('hub.audit.target.reason')}</span>;
    default:
      return <span className="cw-hint">{t('hub.audit.target.none')}</span>;
  }
}

/** The words for an entry's action. A `report.view` with no target is the queue being read, not one report. */
function actionLabel(item: AuditItem, t: HubT): string {
  if (item.action === 'report.view' && item.target === undefined) return t('hub.audit.label.report.list');
  return Object.hasOwn(LABEL, item.action) ? t(LABEL[item.action]) : item.action;
}

interface Filters {
  actor: string;
  action: AuditAction | '';
}
const NONE: Filters = { actor: '', action: '' };

/**
 * Who did what, newest first, 50 at a time, filtered by staff member and action. It is a read of the trail and writes nothing to it.
 * A filter takes effect when it is applied (typing reads nothing), and a new filter starts from the first page. The trail keeps
 * ids and action names, so no chat text is here.
 */
export function Audit() {
  const { client, t } = useHub();
  const id = useId();
  const [draft, setDraft] = useState<Filters>(NONE);
  const [applied, setApplied] = useState<Filters>(NONE);
  const [announcement, setAnnouncement] = useState('');
  const pager = usePagedList(`audit:${applied.actor}:${applied.action}`, (cursor) =>
    client.listAudit({
      limit: AUDIT_PAGE,
      ...(applied.actor === '' ? {} : { actor: applied.actor }),
      ...(applied.action === '' ? {} : { action: applied.action }),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const moreRef = useRef<HTMLButtonElement>(null);
  const countRef = useRef<HTMLParagraphElement>(null);
  const filtered = applied.actor !== '' || applied.action !== '';

  const apply = (): void => setApplied({ actor: draft.actor.trim(), action: draft.action });
  const clear = (): void => {
    setDraft(NONE);
    setApplied(NONE);
  };

  const loadMore = async (): Promise<void> => {
    if (pager.loadingMore) return;
    const hadFocus = document.activeElement === moreRef.current;
    setAnnouncement('');
    const added = await pager.loadMore();
    if (added > 0) setAnnouncement(t('hub.audit.loadedMore', { count: added }));
    if (hadFocus) countRef.current?.focus({ preventScroll: true });
  };

  const what = t('hub.state.what.audit');
  const bad = pager.error !== null && pager.error.status === 400;
  let body;
  if (pager.items.length === 0 && pager.loading) body = <Loading />;
  else if (pager.items.length === 0 && pager.error !== null) {
    body = bad ? <Notice tone="bad" role="alert">{t('hub.audit.badFilter')}</Notice> : <ErrorBlock error={pager.error} what={what} onRetry={pager.reload} />;
  } else if (pager.items.length === 0) body = <Empty>{t(filtered ? 'hub.audit.empty.filtered' : 'hub.audit.empty')}</Empty>;
  else {
    body = (
      <>
        <Scroll label={t('hub.audit.list')}>
          <table className="cw-table cw-audit-table">
            <thead>
              <tr>
                <th scope="col">{t('hub.audit.col.time')}</th>
                <th scope="col">{t('hub.audit.col.actor')}</th>
                <th scope="col">{t('hub.audit.col.role')}</th>
                <th scope="col">{t('hub.audit.col.action')}</th>
                <th scope="col">{t('hub.audit.col.target')}</th>
              </tr>
            </thead>
            <tbody>
              {pager.items.map((item) => (
                <tr key={item.id}>
                  <td className="cw-nowrap">
                    <Time at={item.at} />
                  </td>
                  <td className="cw-term-word">{item.actor}</td>
                  <td>{item.role === null ? <span className="cw-hint">{t('hub.audit.noRole')}</span> : t(`hub.session.role.${item.role}`)}</td>
                  <td>{actionLabel(item, t)}</td>
                  <td>
                    <Target item={item} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
        <div className="cw-more">
          <p ref={countRef} tabIndex={-1}>
            {t('hub.audit.shown', { count: pager.items.length })}
          </p>
          {pager.next === null && <p className="cw-hint">{t('hub.audit.end')}</p>}
          {pager.error !== null && (
            <Notice tone="bad" role="alert">
              <strong>{t('hub.state.loadFailed', { what })}</strong> {errorText(t, pager.error)}
            </Notice>
          )}
          {pager.next !== null && (
            <button ref={moreRef} type="button" className="cw-btn" aria-disabled={pager.loadingMore} aria-busy={pager.loadingMore} onClick={() => void loadMore()}>
              {pager.loadingMore ? t('hub.audit.loadingMore') : t('hub.audit.loadMore')}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.audit.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.audit.intro')}</p>
      <Panel title={t('hub.audit.filter')}>
        <form
          className="cw-form cw-panel-pad cw-audit-filter"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="cw-field">
            <label htmlFor={`${id}-actor`}>{t('hub.audit.actor')}</label>
            <input id={`${id}-actor`} type="text" className="cw-input" autoComplete="off" spellCheck={false} aria-describedby={`${id}-actor-hint`} value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} />
            <p id={`${id}-actor-hint`} className="cw-hint">
              {t('hub.audit.actor.hint')}
            </p>
          </div>
          <div className="cw-field">
            <label htmlFor={`${id}-action`}>{t('hub.audit.action')}</label>
            <select id={`${id}-action`} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value as AuditAction | '' })}>
              <option value="">{t('hub.audit.action.any')}</option>
              {AUDIT_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {t(LABEL[a])}
                </option>
              ))}
            </select>
          </div>
          <div className="cw-action-foot">
            <button type="submit" className="cw-btn cw-btn--primary">
              {t('hub.audit.apply')}
            </button>
            {(filtered || draft.actor !== '' || draft.action !== '') && (
              <button type="button" className="cw-btn" onClick={clear}>
                {t('hub.audit.clear')}
              </button>
            )}
          </div>
        </form>
      </Panel>
      {body}
      <p className="cw-sr" role="status">
        {announcement}
      </p>
    </div>
  );
}

import { useState } from 'react';
import { Masked } from '../case/Transcript.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { timeOfDay } from '../format.js';
import { WORD_MAX } from '../terms/TermForm.js';
import type { BlockedDays, BlockedLine } from '../types.js';
import { Empty, Fetched, Link, PersonChip, Scroll, Segmented, Time } from '../ui.js';

/** The longest list the server sends: the newest 500. */
export const BLOCKED_LIMIT = 500;

const DAYS: readonly BlockedDays[] = [1, 7, 30];
const DAYS_KEY = { 1: 'hub.blocked.screen.days.day', 7: 'hub.blocked.screen.days.week', 30: 'hub.blocked.screen.days.month' } as const;

/**
 * The chat lines the term filter refused, newest first, over the last 1, 7 or 30 days. Each blocked text is masked until a
 * moderator shows it (one line, or "Show blocked words" for the screen), and so is the term, because a term is a word.
 * Opening the list is one audited read (`blocked.view`), and so is each change of window; showing a word is never a read.
 * From a line a moderator can add an exception or look at the term: both go to Terms through the session, so nothing but the
 * screen is in an address.
 */
export function Blocked() {
  const { client, t, locale, can, session, go } = useHub();
  const [days, setDays] = useState<BlockedDays>(7);
  const [all, setAll] = useState(false);
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const state = useHubData(`blocked:${days}`, () => client.listBlocked({ days }));
  const canTerms = can('terms.read');
  const canException = canTerms && can('terms.write');

  const toggle = (id: string): void =>
    setShown((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const addException = (line: BlockedLine): void => {
    session.handoff.set({ kind: 'exception', phrase: line.text.slice(0, WORD_MAX), language: line.language ?? 'en' });
    go({ name: 'terms' });
  };
  const viewTerm = (line: BlockedLine): void => {
    session.handoff.set({ kind: 'term', id: line.termId });
    go({ name: 'terms' });
  };

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.blocked.screen.title')}
        </h2>
        <Segmented
          label={t('hub.blocked.screen.days')}
          value={String(days) as '1' | '7' | '30'}
          options={DAYS.map((d) => ({ value: String(d) as '1' | '7' | '30', label: t(DAYS_KEY[d]) }))}
          onChange={(v) => setDays(Number(v) as BlockedDays)}
        />
      </div>
      <p className="cw-hint">{t('hub.blocked.screen.intro')}</p>
      <Fetched state={state} what={t('hub.state.what.blocked')}>
        {({ items }) =>
          items.length === 0 ? (
            <Empty>{t('hub.blocked.screen.empty')}</Empty>
          ) : (
            <>
              <div className="cw-bar">
                <p className="cw-hint" role="status">
                  {t('hub.blocked.screen.count', { count: items.length })}
                  {items.length >= BLOCKED_LIMIT && ` ${t('hub.blocked.screen.limit', { max: BLOCKED_LIMIT })}`}
                </p>
                <label className="cw-check cw-tr-reveal">
                  <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />
                  <span>{t('hub.mask.all')}</span>
                </label>
              </div>
              <Scroll label={t('hub.blocked.screen.list')}>
                <table className="cw-table cw-blocked-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('hub.blocked.screen.col.time')}</th>
                      <th scope="col">{t('hub.blocked.screen.col.person')}</th>
                      <th scope="col">{t('hub.blocked.screen.col.room')}</th>
                      <th scope="col">{t('hub.blocked.screen.col.term')}</th>
                      <th scope="col">{t('hub.blocked.screen.col.text')}</th>
                      <th scope="col">{t('hub.blocked.screen.col.actions')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((line) => {
                      const visible = all || shown.has(line.id);
                      const time = timeOfDay(line.at, locale);
                      const who = <PersonChip person={line.person} />;
                      return (
                        <tr key={line.id}>
                          <td className="cw-nowrap">
                            <Time at={line.at} />
                          </td>
                          <td>
                            {can('history.read') ? (
                              <Link to={{ name: 'person', ref: line.person }} className="cw-link">
                                {who}
                              </Link>
                            ) : (
                              who
                            )}
                          </td>
                          <td className="cw-term-word">{line.roomId === '' ? t('hub.blocked.screen.noRoom') : line.roomId}</td>
                          <td className="cw-term-word">{line.term === null ? <span className="cw-hint">{t('hub.blocked.screen.termNone')}</span> : visible ? line.term : <Masked />}</td>
                          <td className="cw-term-word">{visible ? line.text : <Masked />}</td>
                          <td>
                            <div className="cw-row-actions">
                              {!all && (
                                <button
                                  type="button"
                                  className="cw-linkbtn"
                                  aria-pressed={visible}
                                  aria-label={t(visible ? 'hub.mask.hideBlocked' : 'hub.mask.showBlocked', { time })}
                                  onClick={() => toggle(line.id)}
                                >
                                  {t(visible ? 'hub.mask.hide' : 'hub.mask.show')}
                                </button>
                              )}
                              {canException && (
                                <button type="button" className="cw-btn" aria-label={t('hub.blocked.screen.addException.label', { time })} onClick={() => addException(line)}>
                                  {t('hub.blocked.screen.addException')}
                                </button>
                              )}
                              {canTerms && line.term !== null && (
                                <button type="button" className="cw-btn" aria-label={t('hub.blocked.screen.viewTerm.label', { time })} onClick={() => viewTerm(line)}>
                                  {t('hub.blocked.screen.viewTerm')}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Scroll>
            </>
          )
        }
      </Fetched>
    </div>
  );
}

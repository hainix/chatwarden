import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Masked } from '../case/Transcript.js';
import { actorName } from '../claims.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { termErrorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import { HitsConfirm } from '../terms/HitsConfirm.js';
import { TermForm } from '../terms/TermForm.js';
import type { TermKind, TermRowDraft } from '../terms/TermForm.js';
import { languageLabel, sortLanguages } from '../terms/languages.js';
import { Tester } from '../terms/Tester.js';
import type { ExceptionRow, TermRow, TermsList } from '../types.js';
import { Empty, ErrorBlock, Loading, Notice, Panel, Scroll, Tag, Time } from '../ui.js';

type Row = (TermRow & { word: string }) | (ExceptionRow & { word: string });

interface FormState {
  kind: TermKind;
  row: TermRowDraft | null;
  prefill: { word: string; language: string } | null;
  /** Changes with each open, so a different row starts a fresh form. */
  key: string;
}

/**
 * Terms and exceptions, by language. The words are hidden until "Show words" is on (a word is a word, so a screen full of them is
 * opt-in), and every label names a row by its place, never by its word, so a screen reader hears no word either. A moderator can
 * add, edit and switch terms and exceptions; a term is dry-run first (`POST /terms/check`), and "Test a message" asks the live
 * list about one line. Write controls follow `terms.write`, never a role name.
 */
export function Terms() {
  const { client, t, locale, can, session } = useHub();
  const toasts = useToasts();
  const list = useHubData('terms', () => client.listTerms());
  const [shown, setShown] = useState(false);
  // Blocked hands over "add an exception for this line" or "show me this term"; read once, then dropped.
  const [handoff] = useState(() => session.handoff.peek());
  const [form, setForm] = useState<FormState | null>(() =>
    handoff?.kind === 'exception' && can('terms.write')
      ? { kind: 'exception', row: null, prefill: { word: handoff.phrase, language: handoff.language }, key: 'handoff' }
      : null,
  );
  const [notice, setNotice] = useState<HubError | null>(null);
  const toggling = useRef(false);
  // Turning a term back on is dry-run first: lines it would also block wait for a confirm on that row.
  const [confirm, setConfirm] = useState<{ id: string; hits: string[]; revealed: boolean } | null>(null);
  const switches = useRef(new Map<string, HTMLInputElement>());
  const addTermButton = useRef<HTMLButtonElement>(null);
  const addExceptionButton = useRef<HTMLButtonElement>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const picked = useRef(new Map<string, HTMLTableRowElement>());
  useEffect(() => {
    session.handoff.clear();
  }, [session]);

  const canWrite = can('terms.write');
  const data = list.data;
  const pickedId = handoff?.kind === 'term' ? handoff.id : null;
  // The marked row takes the focus and the scroll once, when the list first arrives: a reload after a switch must not take them back.
  const pickedDone = useRef(false);
  useEffect(() => {
    if (pickedId === null || data === undefined || pickedDone.current) return;
    pickedDone.current = true;
    const row = picked.current.get(pickedId);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: 'center' });
  }, [pickedId, data]);

  const groups = useMemo(() => {
    if (data === undefined) return [];
    const languages = sortLanguages([...data.terms.map((r) => r.language), ...data.exceptions.map((r) => r.language)], locale);
    return languages.map((language) => ({
      language,
      terms: data.terms.filter((r) => r.language === language).map((r): Row => ({ ...r, word: r.term })),
      exceptions: data.exceptions.filter((r) => r.language === language).map((r): Row => ({ ...r, word: r.phrase })),
    }));
  }, [data, locale]);

  if (data === undefined) {
    if (list.error === null) return <Screen><Loading /></Screen>;
    if (list.error.status === 404) {
      return (
        <Screen>
          <Empty>{t('hub.terms.unavailable')}</Empty>
        </Screen>
      );
    }
    return (
      <Screen>
        <ErrorBlock error={list.error} what={t('hub.state.what.terms')} onRetry={list.reload} />
      </Screen>
    );
  }

  const languageCodes = groups.map((g) => g.language);
  const defaultLanguage = languageCodes.includes('en') ? 'en' : (languageCodes[0] ?? 'en');
  const open = (kind: TermKind, row: TermRowDraft | null): void => setForm({ kind, row, prefill: null, key: `${kind}:${row?.id ?? 'new'}` });
  const close = (): void => {
    const was = form;
    setForm(null);
    queueMicrotask(() => {
      if (was === null) return;
      if (was.row !== null) editButtons.current.get(was.row.id)?.focus();
      else (was.kind === 'term' ? addTermButton : addExceptionButton).current?.focus();
    });
  };

  const toggle = async (kind: TermKind, row: Row, next: boolean, confirmed = false): Promise<void> => {
    if (toggling.current) return;
    toggling.current = true;
    setNotice(null);
    let reload = true;
    try {
      if (kind === 'term' && next && !confirmed) {
        const check = await client.checkTerm({ term: row.word, language: row.language });
        if (check.hits.length > 0) {
          setConfirm({ id: row.id, hits: check.hits, revealed: false });
          // Nothing changed on the server: there is nothing to read again.
          reload = false;
          return;
        }
      }
      await (kind === 'term' ? client.setTermActive(row.id, next) : client.setExceptionActive(row.id, next));
      setConfirm(null);
      toasts.push({ text: t(next ? 'hub.terms.toast.on' : 'hub.terms.toast.off') });
    } catch (e) {
      setNotice(toHubError(e));
    } finally {
      toggling.current = false;
      if (reload) list.reload();
    }
  };

  const matchOf = (termId: string) => {
    const row = data.terms.find((r) => r.id === termId);
    return row === undefined ? null : { word: shown ? row.term : null, language: languageLabel(row.language, locale) };
  };

  const name = (kind: TermKind, row: Row, n: number): string => (shown ? row.word : t(kind === 'term' ? 'hub.terms.rowName.term' : 'hub.terms.rowName.exception', { n }));

  const table = (kind: TermKind, rows: Row[], language: string, counts: TermsList['blocks30d']) => (
    <Scroll label={t(kind === 'term' ? 'hub.terms.list.terms' : 'hub.terms.list.exceptions', { language: languageLabel(language, locale) })}>
      <table className="cw-table cw-terms-table">
        <thead>
          <tr>
            <th scope="col">{t(kind === 'term' ? 'hub.terms.col.word' : 'hub.terms.col.phrase')}</th>
            <th scope="col">{t('hub.terms.col.note')}</th>
            <th scope="col">{t('hub.terms.col.changed')}</th>
            {kind === 'term' && <th scope="col">{t('hub.terms.col.blocks')}</th>}
            <th scope="col">{t('hub.terms.col.active')}</th>
            <th scope="col">{t('hub.terms.col.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const rowName = name(kind, row, i + 1);
            const by = row.updatedBy ?? row.addedBy;
            const at = row.updatedAt ?? row.addedAt;
            return (
              <Fragment key={row.id}>
              <tr
                tabIndex={row.id === pickedId && kind === 'term' ? -1 : undefined}
                ref={(el) => {
                  if (kind !== 'term') return;
                  if (el === null) picked.current.delete(row.id);
                  else picked.current.set(row.id, el);
                }}
                {...(row.id === pickedId && kind === 'term' ? { 'aria-current': 'true' as const } : {})}
              >
                <td className="cw-term-word">
                  {shown ? row.word : <Masked />}
                  {row.id === pickedId && kind === 'term' && (
                    <>
                      {' '}
                      <Tag>{t('hub.terms.fromBlocked')}</Tag>
                    </>
                  )}
                </td>
                <td className="cw-term-note">{row.note === null ? <span className="cw-hint">{t('hub.terms.noNote')}</span> : row.note}</td>
                <td className="cw-term-changed">
                  {by === null || at === null ? (
                    t('hub.terms.changed.starter')
                  ) : (
                    <>
                      {actorName(by)} <Time at={at} />
                    </>
                  )}
                </td>
                {kind === 'term' && <td className="cw-term-count">{counts[row.id] ?? 0}</td>}
                <td>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el === null) switches.current.delete(row.id);
                      else switches.current.set(row.id, el);
                    }}
                    checked={row.active}
                    disabled={!canWrite}
                    aria-label={t('hub.terms.active', { name: rowName })}
                    onChange={(e) => void toggle(kind, row, e.target.checked)}
                  />
                </td>
                <td>
                  {canWrite && (
                    <button
                      type="button"
                      className="cw-btn"
                      aria-label={t('hub.terms.edit.label', { name: rowName })}
                      ref={(el) => {
                        if (el === null) editButtons.current.delete(row.id);
                        else editButtons.current.set(row.id, el);
                      }}
                      onClick={() => open(kind, { id: row.id, word: row.word, language: row.language, note: row.note })}
                    >
                      {t('hub.terms.edit')}
                    </button>
                  )}
                </td>
              </tr>
              {kind === 'term' && confirm !== null && confirm.id === row.id && (
                <tr className="cw-term-confirm">
                  <td colSpan={6}>
                    <HitsConfirm
                      hits={confirm.hits}
                      visible={shown || confirm.revealed}
                      busy={toggling.current}
                      onReveal={() => setConfirm({ ...confirm, revealed: true })}
                      onSave={() => void toggle('term', row, true, true)}
                      onBack={() => {
                        setConfirm(null);
                        queueMicrotask(() => switches.current.get(row.id)?.focus());
                      }}
                    />
                  </td>
                </tr>
              )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );

  return (
    <Screen
      actions={
        <>
          <label className="cw-check cw-tr-reveal">
            <input type="checkbox" checked={shown} onChange={(e) => setShown(e.target.checked)} />
            <span>{t('hub.terms.showWords')}</span>
          </label>
          {canWrite && (
            <>
              <button ref={addTermButton} type="button" className="cw-btn cw-btn--primary" aria-expanded={form?.kind === 'term' && form.row === null} onClick={() => open('term', null)}>
                {t('hub.terms.addTerm')}
              </button>
              <button ref={addExceptionButton} type="button" className="cw-btn" aria-expanded={form?.kind === 'exception' && form.row === null} onClick={() => open('exception', null)}>
                {t('hub.terms.addException')}
              </button>
            </>
          )}
        </>
      }
    >
      <p className="cw-hint">{t('hub.terms.intro')}</p>
      <p className="cw-hint">{t('hub.terms.showWords.hint')}</p>
      {list.error !== null && <ErrorBlock error={list.error} what={t('hub.state.what.terms')} onRetry={list.reload} />}
      {notice !== null && (
        <Notice tone="bad" role="alert">
          {termErrorText(t, notice)}
        </Notice>
      )}
      {form !== null && canWrite && (
        <div className="cw-panel cw-panel-pad">
          <TermForm
            key={form.key}
            kind={form.kind}
            row={form.row}
            languages={languageCodes}
            prefill={form.prefill}
            defaultLanguage={defaultLanguage}
            showWords={shown}
            onClose={close}
            onSaved={() => {
              close();
              list.reload();
            }}
          />
        </div>
      )}
      <Tester matchOf={matchOf} />
      {groups.length === 0 ? (
        <Empty>{t('hub.terms.empty')}</Empty>
      ) : (
        groups.map((g) => (
          <Panel key={g.language} title={languageLabel(g.language, locale)}>
            <div className="cw-terms-group">
              <h3>{t('hub.terms.group.terms')}</h3>
              {g.terms.length === 0 ? <p className="cw-hint">{t('hub.terms.noneInLanguage')}</p> : table('term', g.terms, g.language, data.blocks30d)}
              <h3>{t('hub.terms.group.exceptions')}</h3>
              {g.exceptions.length === 0 ? <p className="cw-hint">{t('hub.terms.noneInLanguage')}</p> : table('exception', g.exceptions, g.language, data.blocks30d)}
            </div>
          </Panel>
        ))
      )}
    </Screen>
  );
}

function Screen({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useHub();
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.terms.title')}
        </h2>
        {actions !== undefined && <div className="cw-bar-actions">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

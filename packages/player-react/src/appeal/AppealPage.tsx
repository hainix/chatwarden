import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AppealCase } from '@chatwarden/core';
import { noticeWordsFor } from '@chatwarden/core/notice-locales';
import type { AppealWordOverrides } from '@chatwarden/core/notice-locales';
import { toPlayerError } from '../client.js';
import { createT } from '../createT.js';
import type { PlayerParams, PlayerT } from '../i18n.js';
import { timeLeft, untilText } from '../format.js';
import { Card, Root, titleKey, viewOf } from '../ui.js';
import type { PlayerUiProps, Ui } from '../ui.js';
import { createAppealPageClient } from './appealClient.js';
import type { AppealPageClient } from './appealClient.js';

// The appeal page as a component (appeals landing, 3.3 and 3.4): what the served `/appeal` page shows, in the same order and the same words, drawn from the same `AppealCase`
// and sent back through the same route (`/appeal/case`), for a game that wants the page inside its own screens. It holds no English: the words are the kit's
// (`noticeWordsFor`, with the game's own over them). It uses no cookie and never asks who the player is: the link is the capability.

export interface AppealPageProps extends PlayerUiProps {
  /** The full address of the case route on the game's server: `https://game.example/appeal/case`. */
  endpoint: string;
  /** The token of the link (`readAppealToken(location.search)`). A capability: do not log it or show it. */
  token: string;
  /** Replaces the client made from `endpoint` (tests, or a game that sends its own way). */
  client?: AppealPageClient;
  /** The `fetch` the client made from `endpoint` uses. Default: the global one. */
  fetch?: typeof fetch;
  /** The game's own words, as `appeals.words` in the profile holds them: by language, then by word key. */
  words?: AppealWordOverrides;
  /** The line shown under "this link is no longer valid" (the case that would carry it did not open). Default: none. */
  contact?: string;
}

/** The words, with any key and any values: the kit's appeal keys are not part of `PlayerText`, so this page reads its `t` through a looser type. */
type Say = (key: string, params?: PlayerParams) => string;

type View = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'failed'; busy: boolean } | { kind: 'case'; case: AppealCase };
type Refusal = { code: 'invalid' | 'already' | 'rate' | 'failed'; retryAfterMs?: number };

export function AppealPage(props: AppealPageProps) {
  const { endpoint, token, theme, className, contact } = props;
  const locale = props.locale ?? 'en';
  const timeZone = props.timeZone ?? 'UTC';
  const now = props.now ?? Date.now;
  const words = useMemo(() => noticeWordsFor(locale, props.words).words, [locale, props.words]);
  const t = useMemo<Say>(() => (props.t ?? createT(words, locale)) as unknown as Say, [props.t, words, locale]);
  const ui: Ui = useMemo(() => ({ t: t as unknown as PlayerT, locale, now, timeZone }), [t, locale, now, timeZone]);
  // The served page writes its times in UTC and says so; a game that asks for another zone gets its times in that zone, and no sentence that says UTC.
  const utc = timeZone === 'UTC';
  const at = (ms: number): string => `${untilText(ms, locale, timeZone)}${utc ? ' UTC' : ''}`;

  const client = useMemo(() => props.client ?? createAppealPageClient({ endpoint, ...(props.fetch === undefined ? {} : { fetch: props.fetch }) }), [props.client, props.fetch, endpoint]);
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [statement, setStatement] = useState('');
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [busy, setBusy] = useState(false);
  const [sentFocus, setSentFocus] = useState(0);
  const mounted = useRef(true);
  const sending = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const sent = useRef<HTMLParagraphElement>(null);
  const fieldId = useId();
  const hintId = useId();
  const countId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The case is read once per link, after the page is on screen; an answer for a link the page has left is dropped.
  useEffect(() => {
    let live = true;
    setView({ kind: 'loading' });
    setRefusal(null);
    setStatement('');
    client.load(token).then(
      (found) => {
        if (live) setView(found === 'invalid' ? { kind: 'invalid' } : { kind: 'case', case: found });
      },
      (error: unknown) => {
        if (live) setView({ kind: 'failed', busy: toPlayerError(error).status === 429 });
      },
    );
    return () => {
      live = false;
    };
  }, [client, token]);

  // The heading is where reading starts, once there is something under it; an alert and the sent line take focus when they appear.
  useEffect(() => {
    if (view.kind !== 'loading') heading.current?.focus();
  }, [view.kind]);
  useEffect(() => {
    if (refusal !== null) alert.current?.focus();
  }, [refusal]);
  useEffect(() => {
    if (sentFocus > 0) sent.current?.focus();
  }, [sentFocus]);

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (sending.current || view.kind !== 'case') return;
    const count = [...statement.trim()].length;
    if (count === 0 || count > view.case.statementMax) {
      setRefusal({ code: 'invalid' });
      return;
    }
    sending.current = true;
    setBusy(true);
    setRefusal(null);
    const result = await client.send(token, statement).catch((): Awaited<ReturnType<AppealPageClient['send']>> => ({ ok: false, refused: 'failed' }));
    sending.current = false;
    if (!mounted.current) return;
    setBusy(false);
    if (result.ok) {
      setView({ kind: 'case', case: result.case });
      setStatement('');
      setSentFocus((n) => n + 1);
    } else if (result.refused === 'link') setView({ kind: 'invalid' });
    else setRefusal({ code: result.refused, ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) });
  };

  const contactLine = (line: string | null | undefined) => (line === null || line === undefined ? null : <p className="cw-hint">{t('player.appealPage.contact', { contact: line })}</p>);

  const refusalText = (r: Refusal, max: number): string => {
    if (r.code === 'invalid') return t('player.appealPage.refused.invalid', { max: String(max) });
    if (r.code === 'rate') {
      const wait = r.retryAfterMs !== undefined && r.retryAfterMs > 0 ? timeLeft(now() + r.retryAfterMs, now(), locale) : null;
      return wait === null ? t('player.appealPage.refused.busy') : t('player.appealPage.refused.rate', { when: wait });
    }
    return t(`player.appealPage.refused.${r.code}`);
  };

  /** The sanction as it stands after a decision: its title and end while it is in force, else the words for nothing. */
  const standing = (c: AppealCase) => {
    const s = c.standing;
    const active = s !== null && s.state === 'active';
    const end = !active || s.kind === 'warning' ? '' : s.until === null ? t('player.notice.noEnd') : at(s.until);
    return (
      <>
        <h2 className="cw-kind">{t('player.appealPage.standing')}</h2>
        {active ? (
          <>
            <p>
              <strong>{t(titleKey(s.kind))}</strong>
            </p>
            {end !== '' && (
              <dl className="cw-facts">
                <div className="cw-fact">
                  <dt>{t('player.notice.until')}</dt>
                  <dd>{end}</dd>
                </div>
              </dl>
            )}
          </>
        ) : (
          <p>{t('player.appealPage.standing.none')}</p>
        )}
      </>
    );
  };

  const caseBody = (c: AppealCase) => {
    const nv = viewOf(ui, { ...c.notice, id: '', mustAcknowledge: false });
    const a = c.appeal;
    const over = [...statement.trim()].length > c.statementMax;
    return (
      <>
        <section className="cw-appeal-card">
          <div className="cw-head">
            <Card kind={c.notice.kind} />
            <h2 className="cw-kind">{nv.title}</h2>
          </div>
          <p className="cw-body">{nv.body}</p>
          {nv.facts.length > 0 && (
            <dl className="cw-facts">
              {nv.facts.map((f) => (
                <div key={f.id} className="cw-fact">
                  <dt>{f.term}</dt>
                  <dd>{f.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {nv.refHint !== null && <p className="cw-hint">{nv.refHint}</p>}
          {nv.linesLabel !== null && (
            <>
              <p className="cw-lines-label">{nv.linesLabel}</p>
              <ul className="cw-lines">
                {nv.lines.map((line, i) => (
                  <li key={i}>
                    <span className="cw-line-day">{line.day}</span>
                    <span className="cw-line-text">{line.text}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {utc && <p className="cw-hint">{t('delivery.times')}</p>}
        </section>
        {refusal !== null && (
          <p ref={alert} role="alert" tabIndex={-1} className="cw-error">
            {refusalText(refusal, c.statementMax)}
          </p>
        )}
        {c.canAppeal ? (
          <form className="cw-appeal-form" onSubmit={(e) => void submit(e)} noValidate>
            <div className="cw-field">
              <label className="cw-label" htmlFor={fieldId}>
                {t('player.appealPage.form.label')}
              </label>
              {/* No maxlength: a long paste is counted and refused, never cut. */}
              <textarea
                id={fieldId}
                className="cw-textarea"
                rows={6}
                value={statement}
                aria-invalid={over || undefined}
                aria-describedby={`${hintId} ${countId}`}
                onChange={(e) => {
                  setStatement(e.target.value);
                  setRefusal(null);
                }}
              />
              <p id={hintId} className="cw-hint">
                {t('player.appealPage.form.hint', { max: String(c.statementMax) })}
              </p>
              <p id={countId} className="cw-hint cw-count">
                {t('player.appealPage.form.count', { count: [...statement.trim()].length, max: c.statementMax })}
              </p>
            </div>
            <div className="cw-actions">
              <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy || undefined} aria-busy={busy || undefined}>
                {t('player.appealPage.form.send')}
              </button>
            </div>
          </form>
        ) : a !== null && a.status === 'open' ? (
          <>
            <p ref={sent} tabIndex={-1}>
              {t('player.appealPage.sent', { when: at(a.createdAt) })}
            </p>
            <p>{c.emailsOutcome ? t('player.appealPage.sent.email') : t('player.appealPage.sent.return')}</p>
          </>
        ) : a !== null ? (
          <>
            <h2 className="cw-kind">{t('player.appealPage.decided')}</h2>
            <p>{t(`player.appealPage.outcome.${a.status}`)}</p>
            {a.reason !== null && <p>{t(`player.appeal.reason.${a.status}.${a.reason}`)}</p>}
            {standing(c)}
          </>
        ) : (
          <p>{t('player.appealPage.refused.not_appealable')}</p>
        )}
        <p className="cw-hint">{t('player.appealPage.expires', { when: at(c.expiresAt) })}</p>
        {contactLine(c.contact)}
      </>
    );
  };

  return (
    <Root theme={theme} className={className === undefined ? 'cw-appeal-page' : `cw-appeal-page ${className}`}>
      <h1 ref={heading} tabIndex={-1} className="cw-title">
        {t('player.appealPage.title')}
      </h1>
      {/* Always there, so what is written into it is announced. */}
      <div role="status" className="cw-live">
        {view.kind === 'loading' && <p className="cw-state">{t('player.appealPage.loading')}</p>}
      </div>
      {view.kind === 'invalid' && (
        <>
          <p>{t('player.appealPage.invalid')}</p>
          {contactLine(contact)}
        </>
      )}
      {view.kind === 'failed' && (
        <>
          <p role="alert" className="cw-error">
            {t(view.busy ? 'player.appealPage.refused.busy' : 'player.appealPage.refused.failed')}
          </p>
          {contactLine(contact)}
        </>
      )}
      {view.kind === 'case' && caseBody(view.case)}
    </Root>
  );
}

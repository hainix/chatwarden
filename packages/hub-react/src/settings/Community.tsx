import { useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import { relativeTime } from '../format.js';
import { useHubData } from '../hooks.js';
import type { HubT, HubText } from '../i18n.js';
import { errorText } from '../labels.js';
import { languageLabel } from '../terms/languages.js';
import { useToasts } from '../toasts.js';
import type { CommunityStatus, CommunitySummary } from '../types.js';
import { Fetched, Notice } from '../ui.js';

// Settings > Community list (design 14, door 2). It exists only where the server wired `community`: the Settings screen asks once and
// hands the answer in. It shows which version is in use and whether a newer one waits, what is in the list (counts, never words), the
// licence, when it was last checked and, in words, what went wrong. "Check now" asks the loader; "Apply version X" (an owner) shows what
// it will do and asks once more. "Find a word" opens one row in Terms. There is no list of words and no export: browsing the shared list
// is not something the hub offers. No string here holds a term.

const PROBLEM: Record<string, HubText> = {
  offline: 'hub.community.problem.offline',
  timeout: 'hub.community.problem.timeout',
  too_large: 'hub.community.problem.too_large',
  bad_index: 'hub.community.problem.bad_index',
  unknown_key: 'hub.community.problem.unknown_key',
  revoked_key: 'hub.community.problem.revoked_key',
  bad_signature: 'hub.community.problem.bad_signature',
  rollback: 'hub.community.problem.rollback',
  index_expired: 'hub.community.problem.index_expired',
  no_such_version: 'hub.community.problem.no_such_version',
  revoked_release: 'hub.community.problem.revoked_release',
  kit_too_old: 'hub.community.problem.kit_too_old',
  hash_mismatch: 'hub.community.problem.hash_mismatch',
  bad_zip: 'hub.community.problem.bad_zip',
  bad_manifest: 'hub.community.problem.bad_manifest',
  bad_pack: 'hub.community.problem.bad_pack',
  cache_failed: 'hub.community.problem.cache_failed',
  no_trusted_keys: 'hub.community.problem.no_trusted_keys',
};

/** What went wrong, in words: a code the hub does not know reads as "something went wrong" and is never shown. */
function problemText(t: HubT, code: string): string {
  return t('hub.community.problem', { reason: t(Object.hasOwn(PROBLEM, code) ? (PROBLEM[code] as HubText) : 'hub.community.problem.unknown') });
}

const summaryText = (t: HubT, s: CommunitySummary): string => t('hub.community.summary', { ...s });

/** Why an apply did not happen. */
function applyFailure(t: HubT, e: HubError): string {
  if (e.code === 'nothing_to_apply') return t('hub.community.apply.error.none');
  if (e.code === 'apply_refused') return t('hub.community.apply.error.refused');
  return errorText(t, e);
}

/** The section: reads `GET /community`, then draws it. */
export function CommunitySettings() {
  const { t, client } = useHub();
  const status = useHubData('community', () => client.community());
  if (status.data !== undefined) return <Body initial={status.data} />;
  return (
    <div className="cw-screen cw-community">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.community.title')}
        </h2>
      </div>
      <Fetched state={status} what={t('hub.state.what.community')}>
        {() => null}
      </Fetched>
    </div>
  );
}

function Body({ initial }: { initial: CommunityStatus }) {
  const { t, client, can, now, locale, go, session } = useHub();
  const toasts = useToasts();
  const base = useId();
  const [status, setStatus] = useState<CommunityStatus>(initial);
  const [busy, setBusy] = useState<'check' | 'apply' | 'find' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [missing, setMissing] = useState(false);
  const working = useRef(false);
  const applyButton = useRef<HTMLButtonElement>(null);
  const canCheck = can('terms.write');
  const isOwner = can('settings');

  /** One request at a time: a second press while one runs does nothing. */
  const run = async (what: 'check' | 'apply' | 'find', job: () => Promise<void>, fail: (e: HubError) => string): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setBusy(what);
    setNotice(null);
    try {
      await job();
    } catch (e) {
      setNotice(fail(toHubError(e)));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const check = (): Promise<void> =>
    run('check', async () => setStatus(await client.refreshCommunity()), (e) => errorText(t, e));

  const apply = (): Promise<void> =>
    run(
      'apply',
      async () => {
        const done = await client.applyCommunity();
        setConfirming(false);
        toasts.push({ text: t('hub.community.applied', { version: done.version }) });
        setStatus(await client.community());
      },
      (e) => {
        setConfirming(false);
        queueMicrotask(() => applyButton.current?.focus());
        return applyFailure(t, e);
      },
    );

  const find = (): Promise<void> => {
    setAttempted(true);
    setMissing(false);
    const text = word.trim();
    if (text === '') return Promise.resolve();
    return run(
      'find',
      async () => {
        let row;
        try {
          row = await client.lookupTerm(text);
        } catch (e) {
          if (toHubError(e).status === 404) {
            setMissing(true);
            return;
          }
          throw e;
        }
        // The word stays here; Terms is given the row's id, and fetches that one row.
        session.handoff.set({ kind: 'term', id: row.id, from: 'find' });
        go({ name: 'terms' });
      },
      (e) => errorText(t, e),
    );
  };

  const problem = status.lastError === null ? null : problemText(t, status.lastError.code);
  const stale = status.state === 'stale';
  const waiting = status.available;
  const counts = status.counts;
  const languages = status.languages;

  return (
    <div className="cw-screen cw-community">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.community.title')}
        </h2>
        {canCheck && (
          <div className="cw-bar-actions">
            <button type="button" className="cw-btn" aria-disabled={busy !== null} aria-busy={busy === 'check'} onClick={() => void check()}>
              {busy === 'check' ? t('hub.community.checking') : t('hub.community.check')}
            </button>
          </div>
        )}
      </div>
      <p className="cw-hint">{t('hub.community.intro')}</p>

      {stale && <Notice tone="warn" role="status">{t('hub.community.stale')}</Notice>}
      {!stale && problem !== null && (
        <Notice tone={status.state === 'failed' ? 'bad' : 'warn'} role={status.state === 'failed' ? 'alert' : 'status'}>
          {problem}
        </Notice>
      )}
      {notice !== null && (
        <Notice tone="bad" role="alert">
          {notice}
        </Notice>
      )}

      <section className="cw-panel cw-panel-pad cw-community-status" aria-label={t('hub.community.title')}>
        <p>{status.applied === null ? t('hub.community.version.none') : t('hub.community.version.applied', { version: status.applied })}</p>
        {waiting !== null ? (
          <p>{t('hub.community.version.waiting', { version: waiting })}</p>
        ) : (
          status.applied !== null && <p>{t('hub.community.version.upToDate')}</p>
        )}
        <p className="cw-hint">{status.lastCheckedAt === null ? t('hub.community.neverChecked') : t('hub.community.lastChecked', { time: relativeTime(status.lastCheckedAt, now(), locale) })}</p>
        {counts !== null && languages.length > 0 && (
          <>
            <h3>{t('hub.community.counts.title')}</h3>
            <ul className="cw-community-counts" aria-label={t('hub.community.counts.title')}>
              {languages.map((code) => (
                <li key={code}>
                  {t('hub.community.counts.row', {
                    language: languageLabel(code, locale),
                    terms: t('hub.community.counts.terms', { count: counts.terms[code] ?? 0 }),
                    exceptions: t('hub.community.counts.exceptions', { count: counts.exceptions[code] ?? 0 }),
                  })}
                </li>
              ))}
            </ul>
          </>
        )}
        {status.license !== null && (
          <>
            <p>{t('hub.community.license', { spdx: status.license.spdx })}</p>
            <p className="cw-hint">{status.license.attribution}</p>
          </>
        )}
      </section>

      {waiting !== null &&
        (isOwner ? (
          <section className="cw-panel cw-panel-pad cw-community-apply" aria-label={t('hub.community.apply', { version: waiting })}>
            {!confirming ? (
              <button ref={applyButton} type="button" className="cw-btn cw-btn--primary" onClick={() => setConfirming(true)}>
                {t('hub.community.apply', { version: waiting })}
              </button>
            ) : (
              <div role="group" aria-labelledby={`${base}-sure`}>
                {status.pending !== null && <p>{summaryText(t, status.pending)}</p>}
                <p className="cw-hint">{t('hub.community.apply.what')}</p>
                <p id={`${base}-sure`}>{t('hub.community.apply.sure')}</p>
                <div className="cw-action-foot">
                  <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy !== null} aria-busy={busy === 'apply'} onClick={() => void apply()}>
                    {busy === 'apply' ? t('hub.community.applying') : t('hub.community.apply.go')}
                  </button>
                  <button
                    type="button"
                    className="cw-btn"
                    onClick={() => {
                      setConfirming(false);
                      queueMicrotask(() => applyButton.current?.focus());
                    }}
                  >
                    {t('hub.community.apply.cancel')}
                  </button>
                </div>
              </div>
            )}
          </section>
        ) : (
          <p className="cw-hint">{t('hub.community.apply.owner')}</p>
        ))}

      <section className="cw-panel cw-panel-pad" aria-label={t('hub.community.find.title')}>
        <h3>{t('hub.community.find.title')}</h3>
        <form
          className="cw-form cw-community-find"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void find();
          }}
        >
          <Field
            id={`${base}-find`}
            label={t('hub.community.find.label')}
            hint={t('hub.community.find.hint')}
            problem={attempted && word.trim() === '' ? { key: 'hub.community.find.empty' } : undefined}
          >
            {(a) => (
              <input
                {...a}
                type="text"
                className="cw-input"
                autoComplete="off"
                spellCheck={false}
                value={word}
                onChange={(e) => {
                  setWord(e.target.value);
                  setMissing(false);
                }}
              />
            )}
          </Field>
          <button type="submit" className="cw-btn" aria-disabled={busy !== null} aria-busy={busy === 'find'}>
            {t('hub.community.find.run')}
          </button>
        </form>
        <div role="status">{missing && <p className="cw-hint">{t('hub.community.find.none')}</p>}</div>
      </section>
    </div>
  );
}

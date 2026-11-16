import { useEffect, useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import { Masked } from '../case/Transcript.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import type { HubT, HubText } from '../i18n.js';
import { useFeatures } from '../features.js';
import { errorText } from '../labels.js';
import type { ShareCategory, ShareState, ShareTarget } from '../types.js';
import { communityStatus } from './communityStatus.js';

// "Share with the community list" (design 14, door 1): one disclosure under the term editor, shown only when the server reports
// `sharing: true` and the row is the adopter's own. Closed by default. Opened, it shows exactly what will be sent (the word masked until
// the screen's Show words is on), the consent text, a category, a target for a slur, an optional note and one Send. Closing it throws the
// draft away. After a send it says where the term stands, in words. The browser never talks to the community service: it asks its own
// server, which signs and sends. No string here holds a term, and nothing the service says is ever shown, only a closed set of words.

/** @experimental */
export interface ShareTermProps {
  /** The row being edited (its id is the only thing in the address). */
  termId: string;
  /** The saved word, shown in the preview. */
  word: string;
  language: string;
  /** The screen's "Show words" switch. */
  showWords: boolean;
}

const NOTE_MAX = 200;
const CATEGORIES: readonly ShareCategory[] = ['slur', 'abuse', 'sexual', 'other'];
const TARGETS: readonly ShareTarget[] = ['ethnicity', 'religion', 'gender', 'sexuality', 'disability', 'nationality', 'other'];

const CATEGORY_WORD: Record<ShareCategory, HubText> = {
  slur: 'hub.community.share.category.slur',
  abuse: 'hub.community.share.category.abuse',
  sexual: 'hub.community.share.category.sexual',
  other: 'hub.community.share.category.else',
};
const TARGET_WORD: Record<ShareTarget, HubText> = {
  ethnicity: 'hub.community.share.target.ethnicity',
  religion: 'hub.community.share.target.religion',
  gender: 'hub.community.share.target.gender',
  sexuality: 'hub.community.share.target.sexuality',
  disability: 'hub.community.share.target.disability',
  nationality: 'hub.community.share.target.nationality',
  other: 'hub.community.share.target.else',
};
const STATUS_WORD: Record<ShareState['status'], HubText> = {
  received: 'hub.community.share.status.received',
  known: 'hub.community.share.status.known',
  duplicate: 'hub.community.share.status.duplicate',
  in_review: 'hub.community.share.status.in_review',
  accepted: 'hub.community.share.status.accepted',
  declined: 'hub.community.share.status.declined',
  merged: 'hub.community.share.status.merged',
};
const REASON_WORD: Record<NonNullable<ShareState['reason']>, HubText> = {
  known_innocent: 'hub.community.share.reason.known_innocent',
  not_a_term: 'hub.community.share.reason.not_a_term',
  duplicate: 'hub.community.share.reason.duplicate',
  needs_context: 'hub.community.share.reason.needs_context',
  other: 'hub.community.share.reason.noReason',
};

/** Where a shared term stands, in words. A status or a reason outside the closed lists reads as the plainest word ("waiting for review", "not added"). */
export function shareStatusWords(t: HubT, state: Pick<ShareState, 'status'> & { reason?: unknown }): string {
  const known = Object.hasOwn(STATUS_WORD, state.status) ? state.status : 'received';
  if (known === 'declined' && typeof state.reason === 'string' && Object.hasOwn(REASON_WORD, state.reason)) {
    return t('hub.community.share.status.declined.reason', { reason: t(REASON_WORD[state.reason as keyof typeof REASON_WORD]) });
  }
  return t(STATUS_WORD[known]);
}

/** What the person is told when a send fails: never the service's text, only these. */
function sendFailure(t: HubT, error: HubError): string {
  if (error.code === 'network' || error.code === 'share_unavailable' || error.status >= 500) return t('hub.community.share.error.offline');
  if (error.status === 429) return t('hub.community.share.error.rateLimited');
  if (error.code === 'share_refused') return t('hub.community.share.error.refused');
  if (error.status === 400) return t('hub.community.share.error.invalid');
  return errorText(t, error);
}

/** The disclosure. Draws nothing until the server has said sharing is on. */
export function ShareTerm({ termId, word, language, showWords }: ShareTermProps) {
  const { t, client } = useHub();
  // Only a server that wired the community list is asked whether sharing is on: no other adopter's editor makes a request for it.
  const { community: wired } = useFeatures();
  const panelId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [sharing, setSharing] = useState(false);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ words: string; sent: boolean } | null>(null);

  useEffect(() => {
    if (!wired) return;
    let live = true;
    void communityStatus(client).then(async (status) => {
      if (!live || status === null || !status.sharing) return;
      setSharing(true);
      try {
        const last = await client.shareStatus(termId);
        if (live && last !== null) setState((now) => now ?? { words: shareStatusWords(t, last), sent: false });
      } catch {
        // never shared, or the status could not be read: nothing to say
      }
    });
    return () => {
      live = false;
    };
    // `t` is stable for the life of a hub; the status is read once per editor.
  }, [client, termId, wired]);

  if (!sharing) return null;

  const close = (): void => {
    setOpen(false);
    toggle.current?.focus();
  };

  return (
    <div
      className="cw-share"
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      }}
    >
      <button ref={toggle} type="button" className="cw-linkbtn cw-share-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((o) => !o)}>
        {t('hub.community.share.toggle')}
      </button>
      {state !== null && (
        <p className="cw-hint cw-share-status" role="status">
          {t(state.sent ? 'hub.community.share.sent' : 'hub.community.share.status', { status: state.words })}
        </p>
      )}
      {open && (
        <SharePanel
          id={panelId}
          termId={termId}
          word={word}
          language={language}
          showWords={showWords}
          onSent={(sentState) => {
            setState({ words: shareStatusWords(t, sentState), sent: true });
            close();
          }}
        />
      )}
    </div>
  );
}

function SharePanel({
  id,
  termId,
  word,
  language,
  showWords,
  onSent,
}: ShareTermProps & { id: string; onSent: (state: Pick<ShareState, 'status'>) => void }) {
  const { t, client } = useHub();
  const base = useId();
  const [category, setCategory] = useState<ShareCategory>('abuse');
  const [target, setTarget] = useState<ShareTarget | ''>('');
  const [note, setNote] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
  const targetRef = useRef<HTMLSelectElement>(null);

  const slur = category === 'slur';
  const noTarget = slur && target === '';
  const targetProblem: Problem | undefined = attempted && noTarget ? { key: 'hub.community.share.target.required' } : undefined;
  const trimmed = note.trim();

  const send = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (noTarget) {
      targetRef.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      const answer = await client.shareTerm(termId, {
        category,
        ...(slur && target !== '' ? { target } : {}),
        ...(trimmed === '' ? {} : { note: trimmed }),
      });
      onSent({ status: answer.status });
    } catch (e) {
      setError(sendFailure(t, toHubError(e)));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <div id={id} className="cw-share-panel">
      <p className="cw-share-consent">{t('hub.community.share.consent')}</p>
      <div role="group" aria-label={t('hub.community.share.payload')} className="cw-share-payload">
        <dl>
          <div>
            <dt>{t('hub.community.share.field.word')}</dt>
            <dd>{showWords ? word : <Masked />}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.language')}</dt>
            <dd>{language}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.category')}</dt>
            <dd>{t(CATEGORY_WORD[category])}</dd>
          </div>
          {slur && (
            <div>
              <dt>{t('hub.community.share.field.target')}</dt>
              <dd>{target === '' ? t('hub.community.share.none') : t(TARGET_WORD[target])}</dd>
            </div>
          )}
          <div>
            <dt>{t('hub.community.share.field.note')}</dt>
            <dd>{trimmed === '' ? t('hub.community.share.none') : trimmed}</dd>
          </div>
          <div>
            <dt>{t('hub.community.share.field.key')}</dt>
            <dd>{t('hub.community.share.key')}</dd>
          </div>
        </dl>
      </div>
      <div className="cw-share-fields">
        <div className="cw-field">
          <label htmlFor={`${base}-category`}>{t('hub.community.share.category')}</label>
          <select id={`${base}-category`} value={category} onChange={(e) => setCategory(e.target.value as ShareCategory)}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(CATEGORY_WORD[c])}
              </option>
            ))}
          </select>
        </div>
        {slur && (
          <Field id={`${base}-target`} label={t('hub.community.share.target')} problem={targetProblem}>
            {(a) => (
              <select {...a} ref={targetRef} value={target} onChange={(e) => setTarget(e.target.value as ShareTarget | '')}>
                <option value="">{t('hub.community.share.target.choose')}</option>
                {TARGETS.map((x) => (
                  <option key={x} value={x}>
                    {t(TARGET_WORD[x])}
                  </option>
                ))}
              </select>
            )}
          </Field>
        )}
      </div>
      <Field
        id={`${base}-note`}
        label={t('hub.community.share.note')}
        hint={t('hub.community.share.note.hint', { max: NOTE_MAX })}
        counter={t('hub.terms.form.counter', { count: trimmed.length, max: NOTE_MAX })}
      >
        {(a) => <textarea {...a} rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      {error !== null && (
        <div className="cw-error" role="alert">
          <p>{error}</p>
        </div>
      )}
      <div className="cw-action-foot">
        <button type="button" className="cw-btn cw-btn--primary" aria-disabled={busy} aria-busy={busy} onClick={() => void send()}>
          {busy ? t('hub.community.share.sending') : t('hub.community.share.send')}
        </button>
      </div>
    </div>
  );
}

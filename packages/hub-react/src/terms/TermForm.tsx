import { useEffect, useId, useRef, useState } from 'react';
import { Field } from '../case/ActionEditor.js';
import { Masked } from '../case/Transcript.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import { termErrorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import { HitsConfirm } from './HitsConfirm.js';

/** The longest word or phrase, and note, the server accepts. */
export const WORD_MAX = 200;
export const NOTE_MAX = 500;
/** A language tag as the server takes it: `en`, `es`, `pt-BR`. */
const LANGUAGE_RE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;

export type TermKind = 'term' | 'exception';

/** The row an edit starts from. */
export interface TermRowDraft {
  id: string;
  word: string;
  language: string;
  note: string | null;
}

export interface TermFormProps {
  kind: TermKind;
  /** The row being edited, or null to add. */
  row: TermRowDraft | null;
  /** Language codes already in the list, offered as suggestions. */
  languages: readonly string[];
  /** Filled in from a blocked line (an exception). */
  prefill: { word: string; language: string } | null;
  /** The language a new word starts with. */
  defaultLanguage: string;
  /** The screen's "Show words" switch: when it is on, the word is shown at once. */
  showWords: boolean;
  onClose: () => void;
  /** The change was saved. */
  onSaved: (done: 'added' | 'saved') => void;
}

interface Problems {
  word?: Problem;
  language?: Problem;
  note?: Problem;
}

function problemsOf(word: string, language: string, note: string): Problems {
  const out: Problems = {};
  const w = word.trim();
  if (w === '') out.word = { key: 'hub.terms.form.error.wordRequired' };
  else if (w.length > WORD_MAX) out.word = { key: 'hub.terms.form.error.wordLong', params: { max: WORD_MAX } };
  if (!LANGUAGE_RE.test(language.trim())) out.language = { key: 'hub.terms.form.error.language' };
  if (note.trim().length > NOTE_MAX) out.note = { key: 'hub.terms.form.error.noteLong', params: { max: NOTE_MAX } };
  return out;
}

/**
 * Add or edit a term or an exception. A term is first checked with a dry run (`POST /terms/check`, which writes nothing): with
 * hits, the lines it would block are listed and the save waits for "Save anyway", an in-page confirm. An exception is saved at once
 * (it only lets things through). A refusal keeps everything typed; a network failure offers Try again; a double click sends once.
 */
export function TermForm({ kind, row, languages, prefill, defaultLanguage, showWords, onClose, onSaved }: TermFormProps) {
  const { t, client } = useHub();
  const toasts = useToasts();
  const base = useId();
  const editing = row !== null;
  const [word, setWord] = useState(row?.word ?? prefill?.word.slice(0, WORD_MAX) ?? '');
  const [language, setLanguage] = useState(row?.language ?? prefill?.language ?? defaultLanguage);
  const [note, setNote] = useState(row?.note ?? '');
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<'check' | 'save' | null>(null);
  const [error, setError] = useState<HubError | null>(null);
  const [unchanged, setUnchanged] = useState(false);
  const [hits, setHits] = useState<string[] | null>(null);
  const wordRef = useRef<HTMLInputElement>(null);
  const showRef = useRef<HTMLButtonElement>(null);
  // A word that was already there (an edit, or a blocked line) stays hidden until it is shown here or the screen shows words.
  const [revealed, setRevealed] = useState(false);
  const held = row !== null || prefill !== null;
  const hidden = held && !showWords && !revealed;
  const languageRef = useRef<HTMLInputElement>(null);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  // A second click while one is on its way does nothing: only the first call goes on to the toast and the reload.
  const sending = useRef(false);
  // Whether the last attempt was a confirmed "Save anyway", so Try again repeats that and not the dry run.
  const confirmedRef = useRef(false);

  useEffect(() => {
    (wordRef.current ?? showRef.current)?.focus();
  }, []);
  useEffect(() => {
    if (revealed) wordRef.current?.focus();
  }, [revealed]);

  const problems = problemsOf(word, language, note);
  const shown: Problems = attempted ? problems : {};
  const label = kind === 'term' ? 'hub.terms.form.word' : 'hub.terms.form.phrase';
  const formName = t(editing ? (kind === 'term' ? 'hub.terms.form.editTerm' : 'hub.terms.form.editException') : kind === 'term' ? 'hub.terms.form.addTerm' : 'hub.terms.form.addException');
  const submitLabel = editing ? t('hub.terms.form.submit.save') : t(kind === 'term' ? 'hub.terms.form.submit.addTerm' : 'hub.terms.form.submit.addException');

  const run = async (confirmed: boolean): Promise<void> => {
    if (sending.current) return;
    confirmedRef.current = confirmed;
    setAttempted(true);
    setUnchanged(false);
    // A problem with a hidden word cannot be fixed without seeing it.
    if (problems.word !== undefined && hidden) setRevealed(true);
    const first = problems.word !== undefined ? wordRef : problems.language !== undefined ? languageRef : problems.note !== undefined ? noteRef : null;
    if (first !== null) {
      first.current?.focus();
      return;
    }
    const text = word.trim();
    const lang = language.trim();
    const trimmedNote = note.trim();
    // An edit sends only what changed.
    const wordChanged = !editing || text !== row.word;
    const languageChanged = !editing || lang !== row.language;
    const noteChanged = editing ? trimmedNote !== (row.note ?? '') : trimmedNote !== '';
    if (editing && !wordChanged && !languageChanged && !noteChanged) {
      setUnchanged(true);
      return;
    }
    sending.current = true;
    setError(null);
    try {
      if (kind === 'term' && (wordChanged || languageChanged) && !confirmed) {
        setBusy('check');
        const check = await client.checkTerm({ term: text, language: lang });
        if (check.hits.length > 0) {
          setHits(check.hits);
          return;
        }
      }
      setBusy('save');
      if (editing) {
        const wordField = kind === 'term' ? 'term' : 'phrase';
        const patch = {
          ...(wordChanged ? { [wordField]: text } : {}),
          ...(languageChanged ? { language: lang } : {}),
          ...(noteChanged ? { note: trimmedNote === '' ? null : trimmedNote } : {}),
        };
        await (kind === 'term' ? client.updateTerm(row.id, patch) : client.updateException(row.id, patch));
        toasts.push({ text: t('hub.terms.toast.saved') });
        onSaved('saved');
      } else {
        const input = { ...(kind === 'term' ? { term: text } : { phrase: text }), language: lang, ...(trimmedNote === '' ? {} : { note: trimmedNote }) };
        await (kind === 'term' ? client.addTerm(input as { term: string; language: string; note?: string }) : client.addException(input as { phrase: string; language: string; note?: string }));
        toasts.push({ text: t(kind === 'term' ? 'hub.terms.toast.added.term' : 'hub.terms.toast.added.exception') });
        onSaved('added');
      }
    } catch (e) {
      setError(toHubError(e));
      setHits(null);
    } finally {
      sending.current = false;
      setBusy(null);
    }
  };

  const retryable = error !== null && (error.code === 'network' || error.status >= 500 || error.status === 429);
  const decide = hits !== null;

  return (
    <form
      className="cw-form cw-termform"
      aria-label={formName}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void run(false);
      }}
    >
      <h3 className="cw-form-title">{formName}</h3>
      {prefill !== null && !editing && <p className="cw-hint">{t('hub.terms.form.prefilled')}</p>}
      <fieldset disabled={decide}>
        <div className="cw-termform-fields">
          {hidden ? (
            <div className="cw-field">
              <span className="cw-field-label">
                {t(label)}
              </span>
              <div className="cw-row-actions">
                <Masked />
                <button ref={showRef} type="button" className="cw-linkbtn" aria-label={t(kind === 'term' ? 'hub.terms.form.show.word' : 'hub.terms.form.show.phrase')} onClick={() => setRevealed(true)}>
                  {t('hub.terms.form.show')}
                </button>
              </div>
            </div>
          ) : (
            <Field
              id={`${base}-word`}
              label={t(label)}
              hint={t(kind === 'term' ? 'hub.terms.form.word.hint' : 'hub.terms.form.phrase.hint', { max: WORD_MAX })}
              counter={t('hub.terms.form.counter', { count: word.trim().length, max: WORD_MAX })}
              problem={shown.word}
            >
              {(a) => <input {...a} ref={wordRef} type="text" className="cw-input" autoComplete="off" spellCheck={false} value={word} onChange={(e) => setWord(e.target.value)} />}
            </Field>
          )}
          <Field id={`${base}-language`} label={t('hub.terms.form.language')} hint={t('hub.terms.form.language.hint')} problem={shown.language}>
            {(a) => (
              <>
                <input {...a} ref={languageRef} type="text" className="cw-input" autoComplete="off" spellCheck={false} list={`${base}-codes`} value={language} onChange={(e) => setLanguage(e.target.value)} />
                <datalist id={`${base}-codes`}>
                  {languages.map((code) => (
                    <option key={code} value={code} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
        </div>
        <Field
          id={`${base}-note`}
          label={t('hub.terms.form.note')}
          hint={t('hub.terms.form.note.hint')}
          counter={t('hub.terms.form.counter', { count: note.trim().length, max: NOTE_MAX })}
          problem={shown.note}
        >
          {(a) => <textarea {...a} ref={noteRef} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </fieldset>

      {hits !== null && (
        <HitsConfirm
          hits={hits}
          visible={!hidden}
          busy={busy !== null}
          onReveal={() => setRevealed(true)}
          onSave={() => void run(true)}
          onBack={() => {
            setHits(null);
            queueMicrotask(() => (wordRef.current ?? showRef.current)?.focus());
          }}
        />
      )}

      {unchanged && <p className="cw-field-error">{t('hub.terms.form.error.unchanged')}</p>}
      {error !== null && (
        <div className="cw-error" role="alert">
          <p>{termErrorText(t, error)}</p>
          {retryable && (
            <button type="button" className="cw-btn" onClick={() => void run(confirmedRef.current)}>
              {t('hub.state.retry')}
            </button>
          )}
        </div>
      )}

      <div className="cw-action-foot">
        {!decide && (
          <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy !== null} aria-busy={busy !== null}>
            {busy === 'check' ? t('hub.terms.form.checking') : submitLabel}
          </button>
        )}
        <button type="button" className="cw-btn" onClick={onClose}>
          {t('hub.terms.form.cancel')}
        </button>
      </div>
    </form>
  );
}

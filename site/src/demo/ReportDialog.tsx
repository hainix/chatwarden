import { useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { REPORT_CATEGORIES } from './engine';
import type { ReportCategory } from './engine';

export const CATEGORY_LABEL: Record<ReportCategory, string> = {
  harassment: 'Harassment',
  hate: 'Hate',
  cheating: 'Cheating',
  spam: 'Spam',
  disruption: 'Disrupting the game',
  other: 'Something else',
};

export const NOTE_MAX = 140;

/** What is wrong with a report form, or null. Pure, so it is easy to test. */
export function validateReport(category: ReportCategory | '', note: string): string | null {
  if (category === '') return 'Pick a category.';
  if (category === 'other' && note.trim() === '') return 'Add a note to tell the moderator what happened.';
  if (note.length > NOTE_MAX) return `Keep the note under ${NOTE_MAX} characters.`;
  return null;
}

interface Props {
  handle: string;
  text: string;
  onClose: () => void;
  /** Resolves with a message to show when the report was not filed, or null when it was. */
  onSubmit: (input: { category: ReportCategory; note: string }) => Promise<string | null>;
  /** Where focus goes when the dialog closes. */
  returnFocus: HTMLElement | null;
}

const FOCUSABLE = 'input:not(:disabled), textarea:not(:disabled), button:not(:disabled)';

/** A small modal: a category, an optional note, Send and Cancel. Focus is trapped inside; Escape closes. */
export function ReportDialog({ handle, text, onClose, onSubmit, returnFocus }: Props) {
  const [category, setCategory] = useState<ReportCategory | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    root.current?.querySelector<HTMLElement>('input[type="radio"]')?.focus();
    return () => {
      alive.current = false;
      returnFocus?.focus();
    };
  }, [returnFocus]);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || root.current === null) return;
    const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (first === undefined || last === undefined || active === null) return;
    const inRadios = (el: HTMLElement) => el instanceof HTMLInputElement && el.type === 'radio';
    if (e.shiftKey && (active === first || (inRadios(active) && inRadios(first)))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = validateReport(category, note);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    const refused = await onSubmit({ category: category as ReportCategory, note: note.trim() });
    if (alive.current && refused !== null) {
      setError(refused);
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={root}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-title"
        onKeyDown={onKeyDown}
      >
        <h3 id="report-title">Report {handle}’s line</h3>
        <blockquote className="dialog-line">{text}</blockquote>
        <form onSubmit={submit} noValidate>
          <fieldset className="dialog-cats" aria-describedby={error ? 'report-error' : undefined}>
            <legend>What happened?</legend>
            {REPORT_CATEGORIES.map((c) => (
              <label key={c} className="cat">
                <input
                  type="radio"
                  name="category"
                  value={c}
                  checked={category === c}
                  onChange={() => {
                    setCategory(c);
                    setError(null);
                  }}
                />
                <span>{CATEGORY_LABEL[c]}</span>
              </label>
            ))}
          </fieldset>
          <label className="dialog-note">
            <span>Note {category === 'other' ? '(needed)' : '(optional)'}</span>
            <textarea
              rows={2}
              maxLength={NOTE_MAX}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setError(null);
              }}
            />
            <span className="dialog-count" aria-hidden="true">
              {note.length}/{NOTE_MAX}
            </span>
          </label>
          <p id="report-error" className="dialog-error" role="alert">
            {error}
          </p>
          <div className="dialog-actions">
            <button type="button" className="dbtn dbtn-ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="dbtn dbtn-go" disabled={busy}>
              Send report
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

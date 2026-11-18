import { useEffect, useRef, useState } from 'react';
import type { HubError } from '../client.js';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { relativeTime } from '../format.js';
import { useHubAction } from '../hooks.js';
import { errorText } from '../labels.js';
import { useOptionalQueue } from '../liveQueue.js';
import { charsOf } from '../policy/reporting.js';
import { useFeatures } from '../features.js';
import { useCase } from './CaseContext.js';

// A second look, on the case (design 6): the line "Asked for a look by <name>, <time>" with "Looked at" for anyone allowed to clear it (the asker, or a role at or above the one asked),
// and the small form the case menu opens to ask. Behind `desk.workflow`: off, nothing here draws. Asking never takes the case, changes its claim or blocks a decision.

/** The most characters of a note (the kit's: the same as a comment). */
export const NOTE_MAX = 500;
const RANK = { moderator: 0, senior: 1, owner: 2 } as const;

/** Whether this role may clear a second look asked of `to` by `by`. */
export const mayClear = (me: { role: keyof typeof RANK; actor: string }, ask: { to: 'senior' | 'owner'; by: string }): boolean => ask.by === me.actor || RANK[me.role] >= RANK[ask.to];

export function AskedLine() {
  const { t, locale, now, me, client } = useHub();
  const { reportId, detail } = useCase();
  const queue = useOptionalQueue();
  const { workflow } = useFeatures();
  const clear = useHubAction(async (): Promise<void> => {
    await client.clearEscalation(reportId);
    detail.reload();
    if (queue !== null) await queue.reload();
  });
  const report = detail.data?.report;
  const ask = report?.escalation ?? null;
  if (!workflow || report === undefined || report.status !== 'open' || ask === null) return null;
  return (
    <div className="cw-asked">
      <p className="cw-asked-line">
        {t('hub.desk.asked', { name: actorName(ask.by), time: relativeTime(ask.at, now(), locale) })}
        {ask.to === 'owner' && <span className="cw-hint"> {t('hub.desk.asked.owner')}</span>}
      </p>
      {mayClear(me, ask) && (
        <button type="button" className="cw-btn" aria-disabled={clear.busy} onClick={() => void clear.run()}>
          {t('hub.desk.asked.done')}
        </button>
      )}
      {clear.error !== null && (
        <p className="cw-error" role="alert">
          {errorText(t, clear.error)}
        </p>
      )}
    </div>
  );
}

/** The form behind "Ask a senior to look" and "Escalate to the owner": an optional note, Send and Cancel. `done` closes the menu. */
export function AskForm({ to, label, done }: { to: 'senior' | 'owner'; label: string; done: () => void }) {
  const { t, client } = useHub();
  const { reportId, detail } = useCase();
  const queue = useOptionalQueue();
  const [note, setNote] = useState('');
  const tooLong = charsOf(note) > NOTE_MAX;
  // The menu's item that opened this form is gone from the page: the focus goes to the note, not to the page.
  const noteBox = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    noteBox.current?.focus();
  }, []);
  const send = useHubAction(async (value: string): Promise<void> => {
    await client.escalate(reportId, { to, ...(value.trim() === '' ? {} : { note: value.trim() }) });
    detail.reload();
    if (queue !== null) await queue.reload();
  });
  const failed: HubError | null = send.error;
  return (
    <div className="cw-case-menu-form" role="group" aria-label={label}>
      <div className="cw-field">
        <label htmlFor={`ask-${to}`}>{t('hub.desk.ask.note')}</label>
        <textarea id={`ask-${to}`} ref={noteBox} rows={3} value={note} {...(tooLong ? { 'aria-invalid': true as const } : {})} onChange={(e) => setNote(e.target.value)} />
        {tooLong && <p className="cw-field-error">{t('hub.desk.ask.error.long', { max: NOTE_MAX })}</p>}
      </div>
      <div className="cw-whattodo-actions">
        <button
          type="button"
          className="cw-btn cw-btn--primary"
          aria-disabled={tooLong || send.busy}
          onClick={async () => {
            if (tooLong) return;
            const res = await send.run(note);
            if (res.ok) done();
          }}
        >
          {t('hub.desk.ask.send')}
        </button>
        <button type="button" className="cw-btn" onClick={done}>
          {t('hub.desk.ask.cancel')}
        </button>
      </div>
      {failed !== null && (
        <p className="cw-error" role="alert">
          {errorText(t, failed)}
        </p>
      )}
    </div>
  );
}

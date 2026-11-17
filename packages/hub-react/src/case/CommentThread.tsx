import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { HubError } from '../client.js';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { useHubAction } from '../hooks.js';
import { errorText } from '../labels.js';
import { charsOf } from '../policy/reporting.js';
import type { ReportComment } from '../types.js';
import { Time } from '../ui.js';
import { useCase } from './CaseContext.js';

// The staff thread on a case (design 6, behind `desk.workflow`): who wrote each entry and when, plain text (never markup), a remove button on your own comments (any, for a
// senior or the owner), a 500-character counter in code points, and one line that says what not to do: "Do not paste chat here." The entries that record a second look (the ask, the
// escalation, "looked at") are the trail of that look: they cannot be removed. This part is lazy: the case loads it when the thread is opened.

/** The most characters of a comment (the kit's limit, counted as a person counts: an emoji is one). */
export const COMMENT_MAX = 500;

function failure(t: ReturnType<typeof useHub>['t'], error: HubError): string {
  return error.code === 'comment_limit' ? t('hub.desk.thread.error.full', { max: 50 }) : errorText(t, error);
}

const ROLE = { moderator: 'hub.desk.role.moderator', senior: 'hub.desk.role.senior', owner: 'hub.desk.role.owner' } as const;

function Entry({ entry, canRemove, onRemove, busy }: { entry: ReportComment; canRemove: boolean; onRemove: () => void; busy: boolean }) {
  const { t } = useHub();
  const id = useId();
  const what =
    entry.kind === 'ask' ? t('hub.desk.thread.ask.senior') : entry.kind === 'escalate' ? t('hub.desk.thread.ask.owner') : entry.kind === 'clear' ? t('hub.desk.thread.clear') : null;
  return (
    <li className="cw-thread-entry" data-kind={entry.kind}>
      <p className="cw-thread-head">
        <strong>{actorName(entry.author)}</strong> <span className="cw-hint">{t(ROLE[entry.role])}</span> <Time at={entry.at} />
        {what !== null && <span> {what}</span>}
      </p>
      {entry.text !== null && (
        <p id={id} className="cw-thread-text">
          {entry.text}
        </p>
      )}
      {canRemove && (
        <button type="button" className="cw-linkbtn" aria-disabled={busy} aria-describedby={entry.text === null ? undefined : id} onClick={onRemove}>
          {t('hub.desk.thread.remove')}
        </button>
      )}
    </li>
  );
}

export function CommentThread() {
  const { t, client, me } = useHub();
  const { reportId, detail } = useCase();
  const entries = detail.data?.report.comments ?? [];
  const [text, setText] = useState('');
  const base = useId();
  const count = charsOf(text);
  const tooLong = count > COMMENT_MAX;
  const blank = text.trim() === '';
  const add = useHubAction(async (value: string) => {
    await client.addComment(reportId, value);
    detail.reload();
  });
  const remove = useHubAction(async (commentId: string) => {
    await client.removeComment(reportId, commentId);
    detail.reload();
  });
  const send = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (tooLong || blank || add.busy) return;
    const res = await add.run(text);
    if (res.ok) setText('');
  };
  const failed = add.error ?? remove.error;
  const senior = me.role !== 'moderator';
  return (
    <section className="cw-thread" aria-label={t('hub.desk.thread')}>
      {entries.length === 0 ? (
        <p className="cw-hint">{t('hub.desk.thread.empty')}</p>
      ) : (
        <ol className="cw-thread-list" aria-label={t('hub.desk.thread')}>
          {entries.map((c) => (
            <Entry key={c.id} entry={c} canRemove={c.kind === 'comment' && (senior || c.author === me.actor)} busy={remove.busy} onRemove={() => void remove.run(c.id)} />
          ))}
        </ol>
      )}
      <form className="cw-thread-form" onSubmit={(e) => void send(e)}>
        <div className="cw-field">
          <label htmlFor={`${base}-text`}>{t('hub.desk.thread.add')}</label>
          <textarea
            id={`${base}-text`}
            rows={3}
            value={text}
            aria-describedby={`${base}-count ${base}-warn`}
            {...(tooLong ? { 'aria-invalid': true as const } : {})}
            onChange={(e) => setText(e.target.value)}
          />
          <p id={`${base}-count`} className="cw-hint">
            {t('hub.desk.thread.count', { count, max: COMMENT_MAX })}
          </p>
          {tooLong && <p className="cw-field-error">{t('hub.desk.thread.error.long', { max: COMMENT_MAX })}</p>}
        </div>
        <p id={`${base}-warn`} className="cw-hint">
          {t('hub.desk.thread.noChat')}
        </p>
        <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={tooLong || blank || add.busy}>
          {t('hub.desk.thread.send')}
        </button>
        {failed !== null && (
          <p className="cw-error" role="alert">
            {failure(t, failed)}
          </p>
        )}
      </form>
    </section>
  );
}

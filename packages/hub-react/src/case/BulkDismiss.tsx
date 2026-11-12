import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { actorName, liveClaim } from '../claims.js';
import type { HubError } from '../client.js';
import { toHubError } from '../client.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { useDecisions } from '../decisions.js';
import { Dialog } from '../Dialog.js';
import { personName } from '../excerpt.js';
import type { ReportPerson } from '../excerpt.js';
import { useHubData } from '../hooks.js';
import { errorText } from '../labels.js';
import type { DismissOpenResult, ReporterRecord } from '../types.js';
import { useCase } from './CaseContext.js';

// "Close more reports at once": the one advanced door for sweeps. A collapsed disclosure at the bottom of the decision bar with two
// rows, every open report about this person (their case) and every open report from this report's reporter. Choosing one opens a
// window that counts the open reports live (a dry run), says what stays open because another moderator has it, and asks. Confirming
// holds the sweep for the Undo window like any decision. No key reaches any of it: it starts from a click and is confirmed from a
// button that does not have focus when the window opens.

type Scope = 'person' | 'reporter';

interface Ask {
  scope: Scope;
  /** The staff ref of the person or the reporter. */
  ref: string;
  /** How they are named. */
  name: string;
}

type Preview = { status: 'counting' } | { status: 'ready'; result: DismissOpenResult } | { status: 'failed'; error: HubError };

/** The window: counts, says what stays open, and asks. */
function Confirm({ ask, onClose, onConfirm }: { ask: Ask; onClose: () => void; onConfirm: (count: number, takeOver: boolean) => void }) {
  const { t, can, now } = useHub();
  const { group } = useCase();
  const decisions = useDecisions();
  const [preview, setPreview] = useState<Preview>({ status: 'counting' });
  const cancel = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);

  // The live count is asked when the window opens, and again for nothing else: the server decides on the set it finds at confirm time.
  useEffect(() => {
    let cancelled = false;
    decisions.previewDismiss(ask.scope, ask.ref).then(
      (result) => {
        if (!cancelled) setPreview({ status: 'ready', result });
      },
      (e: unknown) => {
        if (!cancelled) setPreview({ status: 'failed', error: toHubError(e) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const result = preview.status === 'ready' ? preview.result : null;
  const open = result?.open ?? 0;
  const held = result?.skipped.claimed ?? 0;
  // A person's case held by someone else is not "nothing to do": the count is what they hold, and a senior may take it over.
  const takeOver = ask.scope === 'person' && open === 0 && held > 0;
  const count = open > 0 ? open : takeOver ? held : 0;
  const holder = group === null ? null : liveClaim(group.claim, now());

  let label: string;
  if (preview.status === 'counting') label = t('hub.bulk.confirm.counting');
  else if (count > 0) label = t(`hub.bulk.confirm.title.${ask.scope}`, { count, name: ask.name });
  else label = t('hub.bulk.confirm.none');

  // The window opens on its Close button while it counts; once the count is in, focus goes to Cancel (never to the button that confirms).
  useEffect(() => {
    if (preview.status === 'counting') return;
    (count > 0 && result !== null ? cancel.current : close.current)?.focus();
  }, [preview.status]);

  return (
    <Dialog label={label} onClose={onClose} initialFocus={close} className="cw-bulk-dialog">
      {preview.status !== 'counting' && <h2 className="cw-bulk-title">{label}</h2>}
      {preview.status === 'counting' && (
        <p className="cw-hint" role="status">
          {t('hub.bulk.confirm.counting')}
        </p>
      )}
      {preview.status === 'failed' && <p role="alert">{errorText(t, preview.error)}</p>}
      {result !== null && count > 0 && (
        <div>
          {takeOver ? (
            <p>{holder === null || holder.by === '' ? t('hub.bulk.confirm.claimed', { count: held }) : t('hub.bulk.confirm.heldBy', { name: actorName(holder.by) })}</p>
          ) : (
            <p>{t('hub.bulk.confirm.body', { seconds: 5 })}</p>
          )}
          {takeOver && <p>{t('hub.bulk.confirm.body', { seconds: 5 })}</p>}
          {!takeOver && held > 0 && <p>{t('hub.bulk.confirm.claimed', { count: held })}</p>}
          {result.more && <p className="cw-hint">{t('hub.bulk.more')}</p>}
        </div>
      )}
      <div className="cw-bulk-buttons">
        {result !== null && count > 0 && (
          <>
            <button ref={cancel} type="button" className="cw-btn" onClick={onClose}>
              {t('hub.bulk.confirm.cancel')}
            </button>
            {takeOver ? (
              can('claims.override') && (
                <button type="button" className="cw-btn cw-btn--primary" onClick={() => onConfirm(count, true)}>
                  {t('hub.bulk.confirm.takeOver', { count })}
                </button>
              )
            ) : (
              <button type="button" className="cw-btn cw-btn--primary" onClick={() => onConfirm(count, false)}>
                {t('hub.bulk.confirm.go', { count })}
              </button>
            )}
          </>
        )}
        {(result === null || count === 0) && (
          <button ref={close} type="button" className="cw-btn" onClick={onClose}>
            {t(preview.status === 'counting' ? 'hub.bulk.confirm.cancel' : 'hub.bulk.confirm.close')}
          </button>
        )}
      </div>
    </Dialog>
  );
}

/** The disclosure at the bottom of the decision bar. Shown only to a role that may decide and may sweep, on an open case. */
export function BulkDismiss() {
  const { t, can, session } = useHub();
  const c = useCase();
  const decisions = useDecisions();
  const actions = useCaseActions();
  const [ask, setAsk] = useState<Ask | null>(null);
  const anchor = useRef<HTMLDetailsElement>(null);
  const report = c.detail.data?.report;
  const reporterRef = report?.reporterPerson;
  const wantsRecord = can('history.read') && reporterRef !== undefined;
  const record = useHubData<ReporterRecord | null>(wantsRecord ? `reporter:${reporterRef}` : 'reporter:idle', () => (wantsRecord ? session.reporter(reporterRef) : Promise.resolve(null)));

  if (report === undefined || report.status !== 'open' || !can('reports.decide') || !can('reports.decide.bulk')) return null;

  const people: ReportPerson[] = c.people;
  const target = people.find((p) => p.role === 'target');
  const reporter = people.find((p) => p.ref === report.reporterPerson);
  const personLabel = target === undefined ? '' : personName(target, people, t);
  const reporterLabel = reporter === undefined ? '' : personName(reporter, people, t);
  const openAbout = c.group?.open ?? 1;
  const noticeable = record.data?.accuracy?.noticeable === true;

  const confirm = (a: Ask, count: number, takeOver: boolean): void => {
    setAsk(null);
    const ids = a.scope === 'person' ? (c.group?.reportIds ?? [report.id]) : [];
    void decisions.dismissOpen({ scope: a.scope, ref: a.ref, person: report.targetPerson, name: a.name, reportIds: ids, count, ...(takeOver ? { takeOver: true } : {}) });
    // The person's case is gone from the screen: go on to the next, as after any decision. A reporter's sweep leaves it where it is.
    if (a.scope === 'person') void actions.continueFrom({ reportId: report.id, person: report.targetPerson }, { quick: true });
  };

  // The window is drawn at the hub's root, not inside the bar (which scrolls and stacks): a window must cover the page.
  const dialog = ask === null ? null : <Confirm ask={ask} onClose={() => setAsk(null)} onConfirm={(count, takeOver) => confirm(ask, count, takeOver)} />;
  const root = anchor.current?.closest('.cw-hub') ?? null;

  return (
    <details className="cw-bulk" ref={anchor}>
      <summary>{t('hub.bulk.open')}</summary>
      <div className="cw-bulk-rows">
        {openAbout >= 2 && (
          <button type="button" className="cw-btn" onClick={() => setAsk({ scope: 'person', ref: report.targetPerson, name: personLabel })}>
            {t('hub.bulk.person', { count: openAbout, name: personLabel })}
          </button>
        )}
        <div className="cw-bulk-row">
          <button
            type="button"
            className="cw-btn"
            {...(noticeable ? { 'aria-describedby': `${anchorId(report.id)}-habitual` } : {})}
            onClick={() => setAsk({ scope: 'reporter', ref: report.reporterPerson, name: reporterLabel })}
          >
            {t('hub.bulk.reporter', { name: reporterLabel })}
          </button>
          {noticeable && (
            <p id={`${anchorId(report.id)}-habitual`} className="cw-hint">
              {t('hub.bulk.reporter.habitual')}
            </p>
          )}
        </div>
      </div>
      {dialog !== null && (root === null ? dialog : createPortal(dialog, root))}
    </details>
  );
}

const anchorId = (id: string): string => `cw-bulk-${id}`;

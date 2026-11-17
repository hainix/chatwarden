import { useId } from 'react';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { relativeTime } from '../format.js';
import { LazyWhatToDo } from '../lazyParts.js';
import { useCase } from './CaseContext.js';
import { useUrgentPanelOpen } from './useUrgent.js';

/**
 * One line at the top of an urgent case (design 5.2): "Urgent: <reason>" in words, the note that it was passed to the game's safety team (who and when) once it was, and the
 * disclosure for the "What to do" panel (open until the moderator collapses it; the panel's code is a lazy part). An ordinary case, and a decided one, has none.
 */
export function UrgentStrip() {
  const { t, locale, now } = useHub();
  const { detail } = useCase();
  const [open, setOpen] = useUrgentPanelOpen();
  const id = useId();
  const report = detail.data?.report;
  if (report === undefined || report.urgent !== true || report.status !== 'open') return null;
  const label = report.reportedReason === null || report.reportedReason === undefined ? null : (report.reportedReasonLabel ?? report.reportedReason);
  const handoff = report.handoff ?? null;
  const when = handoff === null ? '' : relativeTime(handoff.at, now(), locale);
  return (
    <section className="cw-urgent-strip" aria-label={t('hub.urgent.strip.label')}>
      <div className="cw-urgent-strip-row">
        <p className="cw-urgent-strip-line">
          <strong>{label === null ? t('hub.urgent.strip.none') : t('hub.urgent.strip', { reason: label })}</strong>
        </p>
        {handoff !== null && (
          <p className="cw-hint cw-urgent-strip-done">{handoff.by === null ? t('hub.urgent.handedOff.unknown', { time: when }) : t('hub.urgent.handedOff', { name: actorName(handoff.by), time: when })}</p>
        )}
        <button type="button" className="cw-linkbtn cw-urgent-strip-toggle" aria-expanded={open} aria-controls={`${id}-panel`} onClick={() => setOpen(!open)}>
          {t('hub.safety.panel')}
        </button>
      </div>
      {open && <LazyWhatToDo id={`${id}-panel`} />}
    </section>
  );
}

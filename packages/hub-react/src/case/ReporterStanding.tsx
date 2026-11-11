import { useHub } from '../context.js';
import { absoluteTime } from '../format.js';
import { reasonAccuracy } from '../simple.js';
import type { ReporterRecord } from '../types.js';
import { Tag } from '../ui.js';

/**
 * How the reports someone filed have gone: how many, how many held up (a plain bar and the words), the bad-faith ones, and a
 * reporting suspension that is still running. One component for the reporter rows beside a case and for the person page, which
 * already holds the record from the person's history.
 */
export function ReporterStanding({ record: r }: { record: ReporterRecord }) {
  const { t, locale, now } = useHub();
  const decided = r.actioned + r.dismissed;
  const accuracy = reasonAccuracy(r);
  const suspendedUntil = r.suspendedUntil !== null && r.suspendedUntil > now() ? r.suspendedUntil : null;
  return (
    <>
      <meter className="cw-meter" min={0} max={Math.max(1, decided)} value={r.actioned} aria-label={t('hub.reporters.meter', { upheld: r.actioned, decided })} />
      {accuracy !== null && <p className="cw-hint">{t('hub.reporters.accuracy', accuracy)}</p>}
      {r.badFaith > 0 && <p className="cw-hint">{t('hub.report.reporter.badFaith', { count: r.badFaith })}</p>}
      {suspendedUntil !== null && (
        <p>
          <Tag tone="warn">{t('hub.report.reporter.suspended', { time: absoluteTime(suspendedUntil, locale) })}</Tag>
        </p>
      )}
    </>
  );
}

/** The one-line summary of a reporter's record: "No reports yet" or "3 reports, 2 upheld". */
export function ReporterTotals({ record: r }: { record: ReporterRecord }) {
  const { t } = useHub();
  return <span className="cw-hint">{r.reports === 0 ? t('hub.reporters.none') : t('hub.reporters.record', { count: r.reports, upheld: r.actioned })}</span>;
}

import { useHub } from '../context.js';
import { useCase } from './CaseContext.js';

// The report-surge line (design 9.4): one line on the case, only when the server sends a `surge` (the person has had many reports in a short time and the owner turned it on). It is a hint:
// it says the numbers, and says in the same breath that it is not a reason to set a report aside. It is never in the queue, an event or a decision input.

export function SurgeLine() {
  const { t } = useHub();
  const surge = useCase().detail.data?.report.surge;
  if (surge === undefined) return null;
  const tail = surge.newAccounts === null ? '' : `, ${t('hub.case.surge.new', { count: surge.newAccounts, days: surge.newAccountDays })}`;
  return (
    <div className="cw-surge" role="note" aria-label={t('hub.case.surge.label')}>
      <p>
        {t('hub.case.surge', {
          reports: t('hub.case.surge.reports', { count: surge.reports }),
          minutes: t('hub.case.surge.minutes', { count: surge.windowMinutes }),
          players: t('hub.case.surge.players', { count: surge.reporters }),
          tail,
        })}
      </p>
      <p className="cw-hint">{t('hub.case.surge.hint')}</p>
    </div>
  );
}

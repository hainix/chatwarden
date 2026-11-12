import { isDefaultNoActionReason } from '@chatwarden/core';
import { useHub } from '../context.js';
import { absoluteTime, relativeTime } from '../format.js';
import type { ReportDetail } from '../types.js';
import { Tag } from '../ui.js';

/** What was decided, for a report that is closed. */
export function Decided({ detail }: { detail: ReportDetail }) {
  const { t, locale, now } = useHub();
  const r = detail.report;
  return (
    <div className="cw-decided">
      <div className="cw-decided-head">
        <Tag>{t(`hub.reports.tag.${r.status}`)}</Tag>
        {r.badFaith && <Tag tone="warn">{t('hub.report.tag.badFaith')}</Tag>}
      </div>
      {r.actionedBy !== null && r.actionedAt !== null && (
        <p title={absoluteTime(r.actionedAt, locale)}>{t('hub.decide.decided.by', { actor: r.actionedBy, time: relativeTime(r.actionedAt, now(), locale) })}</p>
      )}
      <dl className="cw-decided-notes">
        {r.modNote !== null && (
          <>
            <dt>{t('hub.decide.decided.reason')}</dt>
            <dd>{isDefaultNoActionReason(r.modNote) ? t('hub.decided.reason.default') : r.modNote}</dd>
          </>
        )}
        {r.badFaithEvidence !== null && (
          <>
            <dt>{t('hub.decide.decided.evidence')}</dt>
            <dd>{r.badFaithEvidence}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

import { useHub } from '../context.js';
import { safeHref } from '../links.js';
import { useCase } from './CaseContext.js';

// The gameplay-evidence pointer (design 11): one row, "Match or replay", on a case whose report carries the game's opaque ref. The ref is a link only when the server's url is a plain https
// address (checked again here); otherwise it is plain text. The kit never fetches or previews it. Nothing at all for a report with no ref.

export function EvidenceRow() {
  const { t } = useHub();
  const evidence = useCase().detail.data?.report.evidence;
  if (evidence === undefined || evidence === null || evidence.ref === '') return null;
  const href = safeHref(evidence.url);
  return (
    <p className="cw-evidence">
      <span className="cw-hint">{t('hub.case.evidence')}</span>{' '}
      {href === null ? (
        <span className="cw-evidence-ref">{evidence.ref}</span>
      ) : (
        <a className="cw-link cw-evidence-ref" href={href} target="_blank" rel="noopener noreferrer">
          {evidence.ref}
        </a>
      )}
    </p>
  );
}

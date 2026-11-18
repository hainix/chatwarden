import type { AppealCause } from '@chatwarden/core';
import { useContext, useState } from 'react';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { filterKeyLabel } from '../labels.js';
import { NameRevealContext } from '../names.js';
import type { TermsList } from '../types.js';
import { Link, Masked } from '../ui.js';

// "What caused this" (appeals landing, 6.1): one closed disclosure in the Detailed appeal card, after what the person was shown. It says in a sentence where the
// sanction came from and links to the place to look. It is read only: it never changes a term, a filter or an AI setting. The term of an automatic restriction
// stays hidden until "Show" (its own place in the page's reveal state), and it is read only for a role that may read terms, and only once the disclosure is open.

const TERM = 'term';

export function CauseDisclosure({ cause }: { cause: AppealCause }) {
  const { t } = useHub();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="cw-appeal-cause"
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== open) setOpen(now);
      }}
    >
      <summary>{t('hub.appeals.cause.title')}</summary>
      <div className="cw-appeal-cause-body">
        {cause.source === 'term' && <TermCause cause={cause} open={open} />}
        {cause.source === 'filter' && <FilterCause cause={cause} />}
        {cause.source === 'report' && <ReportCause cause={cause} />}
        {cause.source === 'other' && <p>{t(cause.via === 'coop' ? 'hub.appeals.cause.other.coop' : 'hub.appeals.cause.other.api')}</p>}
      </div>
    </details>
  );
}

function TermCause({ cause, open }: { cause: Extract<AppealCause, { source: 'term' }>; open: boolean }) {
  const { t, can, client } = useHub();
  const reveal = useContext(NameRevealContext);
  // The terms list is read once, when the disclosure is first opened, and only to name this term: a role without `terms.read`, and a restriction written before
  // the term was kept (a null id), have nothing to look up.
  const wants = open && can('terms.read') && cause.termId !== null;
  const list = useHubData<TermsList | null>(wants ? 'appeal-cause-terms' : 'appeal-cause-terms:idle', () => (wants ? client.listTerms() : Promise.resolve(null)));
  const word = cause.termId === null ? null : (list.data?.terms.find((r) => r.id === cause.termId)?.term ?? null);
  const all = reveal?.all === true;
  const shown = all || reveal?.shows(TERM) === true;
  return (
    <>
      <p>{t('hub.appeals.cause.term', { count: cause.strikes })}</p>
      <p className="cw-appeal-cause-word">
        <span>{t('hub.appeals.cause.term.word')}</span>{' '}
        {word === null ? (
          <span className="cw-hint">{t('hub.appeals.cause.term.unknown')}</span>
        ) : (
          <>
            {shown ? <span>{word}</span> : <Masked />}{' '}
            {!all && reveal !== null && (
              <button type="button" className="cw-linkbtn" aria-pressed={shown} aria-label={t(shown ? 'hub.appeals.cause.term.hide' : 'hub.appeals.cause.term.show')} onClick={() => reveal.toggle(TERM)}>
                {t(shown ? 'hub.mask.hide' : 'hub.mask.show')}
              </button>
            )}
          </>
        )}
      </p>
      <p className="cw-facts">
        <Link to={{ name: 'terms' }} className="cw-link" omit>
          {t('hub.appeals.cause.term.open')}
        </Link>
      </p>
    </>
  );
}

function FilterCause({ cause }: { cause: Extract<AppealCause, { source: 'filter' }> }) {
  const { t, can } = useHub();
  return (
    <>
      <p>{t('hub.appeals.cause.filter', { filter: filterKeyLabel(t, cause.filterKey, undefined) })}</p>
      <p className="cw-facts">
        <Link to={{ name: 'settings', section: 'advanced' }} className="cw-link" omit>
          {t('hub.appeals.cause.filter.open')}
        </Link>
        {can('reports.read') && (
          <Link to={{ name: 'report', id: cause.reportId }} className="cw-link" omit>
            {t('hub.appeals.cause.report.open')}
          </Link>
        )}
      </p>
    </>
  );
}

function ReportCause({ cause }: { cause: Extract<AppealCause, { source: 'report' }> }) {
  const { t, can } = useHub();
  return (
    <>
      <p>{t(cause.decidedBy === 'ai' ? 'hub.appeals.cause.report.ai' : 'hub.appeals.cause.report.human')}</p>
      {can('reports.read') && (
        <p className="cw-facts">
          <Link to={{ name: 'report', id: cause.reportId }} className="cw-link" omit>
            {t('hub.appeals.cause.report.open')}
          </Link>
        </p>
      )}
    </>
  );
}

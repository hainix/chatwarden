import { actorName } from '../claims.js';
import { useCaseActions } from '../cases.js';
import { useHub } from '../context.js';
import { listOf } from '../format.js';
import { Avatar } from '../ui.js';
import { useCase } from './CaseContext.js';

// Who is handling the case, and who else is looking. Handling is the claim (it can stop a decision); viewing never blocks anyone.

/** The claim banner under the case header: yours, someone else's (with Take over for a senior), or nobody's. */
export function ClaimBanner() {
  const { t, can } = useHub();
  const { group, holder, detail, entry } = useCase();
  const actions = useCaseActions();
  const report = detail.data?.report;
  if (report === undefined || report.status !== 'open') return null;
  // A decision on its way has let go of the claim: there is nothing to say about who is handling it.
  if (entry !== undefined && (entry.state.status === 'held' || entry.state.status === 'sending')) return null;
  if (group === null) {
    return (
      <div className="cw-claim" data-claim="closed">
        <p>{t('hub.case.closed')}</p>
      </div>
    );
  }
  const person = group.person;
  return (
    <div className="cw-claim" data-claim={holder.kind} role="group" aria-label={t('hub.claim.label')}>
      {holder.kind !== 'none' && <Avatar actor={holder.by} you={holder.kind === 'you'} />}
      <p className="cw-claim-text">
        {holder.kind === 'you' && (
          <>
            <strong>{t('hub.claim.you')}</strong> {t('hub.claim.idle')}
          </>
        )}
        {holder.kind === 'other' && (
          <>
            <strong>{t('hub.claim.theirs', { name: actorName(holder.by) })}</strong> {can('claims.override') ? t('hub.claim.theirsSenior') : t('hub.claim.theirsRead')}
          </>
        )}
        {holder.kind === 'none' && <strong>{t('hub.claim.none')}</strong>}
      </p>
      {holder.kind === 'you' && (
        <button type="button" className="cw-btn" onClick={() => void actions.release(person)}>
          {t('hub.case.release')}
        </button>
      )}
      {holder.kind === 'other' && can('claims.override') && (
        <button type="button" className="cw-btn" onClick={() => void actions.takeOver(person)}>
          {t('hub.claim.takeOver')}
        </button>
      )}
      {holder.kind === 'none' && can('reports.decide') && (
        <button type="button" className="cw-btn" onClick={() => void actions.claim(person)}>
          {t('hub.claim.take')}
        </button>
      )}
    </div>
  );
}

/** "Ana is viewing": the other staff with this case open, named. Empty when nobody else is. */
export function Viewing() {
  const { t, locale } = useHub();
  const { group } = useCase();
  const names = [...new Set(group?.viewing ?? [])].map(actorName);
  if (names.length === 0) return null;
  const first = group?.viewing[0] ?? '';
  return (
    <p className="cw-viewing">
      <Avatar actor={first} size="s" />
      <span>{t(names.length === 1 ? 'hub.claim.viewingOne' : 'hub.claim.viewingMany', { names: listOf(names, locale) })}</span>
    </p>
  );
}

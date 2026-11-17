import { DEFAULT_SAFETY_GUIDANCE } from '@chatwarden/core';
import type { HubError } from '../client.js';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import type { HubT } from '../i18n.js';
import { errorText } from '../labels.js';
import { Skeleton } from '../ui.js';
import { useCase } from './CaseContext.js';
import { useUrgentActions } from './useUrgent.js';

// The "What to do" panel (design 5.3): the owner's own words for an urgent case, read-only. The guidance paragraphs as plain text (never markup), the studio contact when
// there is one, the two buttons, and one plain line of what the kit does not do. Its code is a lazy part: it is fetched when an urgent case opens with the panel showing.
// The kit judges nothing here and contacts no one; the hand-off button only records that a person passed the case on.

/** Why a mark did not go through, in words: a case someone else holds says who. */
function failure(t: HubT, error: HubError): string {
  if (error.code === 'claimed') return error.heldBy === undefined ? t('hub.safety.claimedUnknown') : t('hub.safety.claimed', { name: actorName(error.heldBy) });
  return errorText(t, error);
}

export function WhatToDo({ id }: { id: string }) {
  const { t, can, session } = useHub();
  const { detail } = useCase();
  // The owner's text needs the settings: a role without `policy.read` reads the kit's own default guidance, and never the studio contact.
  const allowed = can('policy.read');
  const safety = useHubData(allowed ? 'safety:view' : 'safety:idle', () => (allowed ? session.safety() : Promise.resolve(null)));
  const { setUrgent, handoff } = useUrgentActions();
  const report = detail.data?.report;
  if (allowed && safety.data === undefined && safety.error === null) {
    return (
      <div className="cw-whattodo" id={id}>
        <p role="status" className="cw-sr">
          {t('hub.state.loading')}
        </p>
        <Skeleton lines={3} />
      </div>
    );
  }
  const guidance = allowed && safety.data != null && safety.data.guidance.trim() !== '' ? safety.data.guidance : DEFAULT_SAFETY_GUIDANCE;
  const contact = allowed && safety.data != null ? safety.data.contact.trim() : '';
  const paragraphs = guidance.split(/\n[ \t]*\n/).map((p) => p.trim()).filter((p) => p !== '');
  const handedOff = (report?.handoff ?? null) !== null;
  const failed = handoff.error ?? setUrgent.error;
  return (
    <div className="cw-whattodo" role="region" aria-label={t('hub.safety.panel')} id={id}>
      <div className="cw-whattodo-body">
        {paragraphs.map((p, i) => (
          <p key={i} className="cw-whattodo-text">
            {p}
          </p>
        ))}
      </div>
      {contact !== '' && (
        <div className="cw-whattodo-body">
          <p className="cw-hint">{t('hub.safety.contact')}</p>
          <p className="cw-whattodo-text">{contact}</p>
        </div>
      )}
      <div className="cw-whattodo-actions">
        {can('reports.handoff') && !handedOff && (
          <button type="button" className="cw-btn cw-btn--primary" aria-disabled={handoff.busy} onClick={() => void handoff.run()}>
            {t('hub.safety.handoff')}
          </button>
        )}
        {can('reports.urgent') && (
          <button type="button" className="cw-btn" aria-disabled={setUrgent.busy} onClick={() => void setUrgent.run(false)}>
            {t('hub.safety.notUrgent')}
          </button>
        )}
      </div>
      {can('reports.handoff') && !handedOff && <p className="cw-hint">{t('hub.safety.handoff.hint')}</p>}
      {failed !== null && (
        <p className="cw-error" role="alert">
          {failure(t, failed)}
        </p>
      )}
      <p className="cw-hint">{t('hub.safety.limits')}</p>
    </div>
  );
}

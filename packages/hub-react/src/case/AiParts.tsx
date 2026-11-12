import { useId } from 'react';
import { useAiT } from '../ai/i18n.js';
import type { AiText } from '../ai/i18n.js';
import type { AiWhy } from '../ai/offer.js';
import { useHub } from '../context.js';
import { personName } from '../excerpt.js';
import { choiceLabel } from '../labels.js';
import { useQuickKeys } from '../quickKeys.js';
import { stepLabel } from '../simple.js';
import { UNDO_MS } from '../toasts.js';
import { Card, Kbd } from '../ui.js';
import { useCase } from './CaseContext.js';
import type { QuickActions } from './useQuickActions.js';

// The AI's suggestion on a case (level 2), in the places it shows: the header of the decision bar (Detailed), and on the Simple card the
// suggestion, the Accept button and, when it cannot be accepted, the reason. One lazy part with a `part` prop, so it is one chunk and one
// fetch. Accepting goes through `QuickActions.sendPrimary` (the same hold, the same guards, the same go-on-to-the-next as the ladder's step);
// nothing here sends anything by itself, and a button whose gate is shut does nothing.

export interface AiPartsProps {
  part: 'bar' | 'suggest' | 'accept' | 'why';
  q: QuickActions;
  /** Open the editor (the bar's, or the card's "Something else"). */
  onEdit?: () => void;
}

const WHY: Record<Exclude<AiWhy, 'edited'>, AiText> = {
  claimed: 'hub.ai.why.claimed',
  role: 'hub.ai.why.role',
  rules: 'hub.ai.why.rules',
  stale: 'hub.ai.why.stale',
  step: 'hub.ai.why.step',
  invalid: 'hub.ai.why.invalid',
};

const SECONDS = UNDO_MS / 1000;

/** The sentence for a shut gate, or null when the form was only edited (it says so in its label and needs no excuse). */
function useWhy(q: QuickActions): string | null {
  const t = useAiT();
  if (q.ai === null || q.ai.gate.ok || q.ai.gate.why === 'edited') return null;
  const why = q.ai.gate.why;
  return t(why === 'step' && q.ai.from.held === null ? 'hub.ai.why.nostep' : WHY[why]);
}

/** "Accept AI suggestion: Restrict chat, 24 hours", or "...: no action needed". Null when the suggestion names no step to accept. */
function useAcceptLabel(q: QuickActions): string | null {
  const t = useAiT();
  const { t: hubT, locale } = useHub();
  if (q.ai === null) return null;
  const { from } = q.ai;
  if (from.kind === 'dismiss') return t('hub.ai.accept.dismiss');
  return from.choice === null ? null : t('hub.ai.accept.with', { step: stepLabel(hubT, locale, from.choice) });
}

function Bar({ q, onEdit }: { q: AiPartsProps['q']; onEdit: (() => void) | undefined }) {
  const t = useAiT();
  const { shortcuts } = useHub();
  const quickOn = useQuickKeys().on;
  const keys = shortcuts && quickOn;
  const c = useCase();
  const hint = useId();
  const why = useWhy(q);
  const label = useAcceptLabel(q);
  const group = t('hub.ai.bar.label');
  if (q.ai === null) {
    // Level 2, a read, and nothing the AI is sure enough to fill: the bar is the ladder's, with a quiet word about it.
    return (
      <div className="cw-aibar" role="group" aria-label={group}>
        <p className="cw-hint">{t('hub.ai.bar.unsure')}</p>
      </div>
    );
  }
  const edited = c.draft.source === 'edited';
  const ok = q.ai.gate.ok;
  return (
    <div className="cw-aibar" role="group" aria-label={group}>
      <div className="cw-aibar-head">
        <span className="cw-aitag">{t('hub.ai.tag')}</span>
        <strong>{t(edited ? 'hub.ai.bar.edited' : 'hub.ai.bar.suggested')}</strong>
        {!edited && label !== null && (
          <button
            type="button"
            className="cw-btn cw-btn--primary cw-ai-accept"
            aria-disabled={!ok || !q.usable || !q.cooled}
            {...(!ok ? { 'aria-describedby': hint } : {})}
            {...(keys ? { 'aria-keyshortcuts': 'A' } : {})}
            onClick={(e) => ok && q.sendPrimary(e)}
          >
            <span>{label}</span>
            {keys && (
              <span aria-hidden="true">
                <Kbd>A</Kbd>
              </span>
            )}
          </button>
        )}
        {!edited && onEdit !== undefined && (
          <button type="button" className="cw-btn cw-ai-edit" {...(keys ? { 'aria-keyshortcuts': 'E' } : {})} onClick={onEdit}>
            <span>{t('hub.ai.edit')}</span>
            {keys && (
              <span aria-hidden="true">
                <Kbd>E</Kbd>
              </span>
            )}
          </button>
        )}
      </div>
      {!edited && why !== null && (
        <p id={hint} className="cw-hint">
          {why}
        </p>
      )}
    </div>
  );
}

/** On the Simple card: what the AI suggests, in the place the ladder's suggestion goes, and what the player will see. */
function Suggest({ q }: { q: AiPartsProps['q'] }) {
  const t = useAiT();
  const { t: hubT, locale } = useHub();
  const { people } = useCase();
  const id = useId();
  if (q.ai === null) return null;
  const { from } = q.ai;
  const target = people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, people, hubT);
  return (
    <div className="cw-suggest" role="group" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="cw-sr">
        {t('hub.ai.suggest.title')}
      </h3>
      <div className="cw-suggest-main">
        {from.choice !== null && <Card kind={from.choice.kind} />}
        <div className="cw-suggest-text">
          <p className="cw-suggest-label">{from.choice === null ? hubT('hub.simple.noAction') : choiceLabel(hubT, locale, from.choice)}</p>
          {from.kind !== 'dismiss' && (
            <p className="cw-hint cw-scard-fine">
              {from.choice !== null && from.choice.kind === 'note'
                ? hubT('hub.simple.sees.note', { name, seconds: SECONDS })
                : hubT('hub.simple.sees', { name, rule: from.rule === '' ? 0 : from.rule, count: from.lines.length, seconds: SECONDS })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** On the Simple card: the primary button, "Accept AI suggestion" and the step in words. */
function Accept({ q }: { q: AiPartsProps['q'] }) {
  const { shortcuts } = useHub();
  const quickOn = useQuickKeys('simple').on;
  const keyed = shortcuts && quickOn;
  const label = useAcceptLabel(q);
  if (label === null || q.ai === null) return null;
  const ok = q.ai.gate.ok;
  return (
    <button
      type="button"
      className="cw-btn cw-btn--primary cw-ai-accept"
      aria-disabled={!ok || !q.fresh || !q.cooled}
      {...(ok && q.fresh && !q.cooled ? { 'data-cooling': 'true' } : {})}
      {...(keyed ? { 'aria-keyshortcuts': 'A 1' } : {})}
      onClick={(e) => ok && q.sendPrimary(e)}
    >
      <span>{label}</span>
      {keyed && (
        <span className="cw-scard-key" aria-hidden="true">
          <Kbd>A</Kbd>
        </span>
      )}
    </button>
  );
}

function Why({ q }: { q: AiPartsProps['q'] }) {
  const why = useWhy(q);
  return why === null ? null : <p className="cw-hint cw-scard-fine">{why}</p>;
}

export function AiParts({ part, q, onEdit }: AiPartsProps) {
  switch (part) {
    case 'bar':
      return <Bar q={q} onEdit={onEdit} />;
    case 'suggest':
      return <Suggest q={q} />;
    case 'accept':
      return <Accept q={q} />;
    case 'why':
      return <Why q={q} />;
  }
}

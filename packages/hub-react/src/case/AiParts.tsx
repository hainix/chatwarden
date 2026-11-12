import { useId } from 'react';
import { useAiT } from '../ai/i18n.js';
import type { AiText } from '../ai/i18n.js';
import { useAiHidden } from '../ai/hide.js';
import type { AiWhy } from '../ai/offer.js';
import { readsOf } from '../ai/rank.js';
import { useHub } from '../context.js';
import { personName } from '../excerpt.js';
import { choiceLabel } from '../labels.js';
import { useQuickKeys } from '../quickKeys.js';
import type { QueueGroup } from '../queue.js';
import { stepLabel } from '../simple.js';
import { UNDO_MS } from '../toasts.js';
import { Card, Kbd } from '../ui.js';
import { AiCase } from './AiCase.js';
import { useCase } from './CaseContext.js';

// The AI's pieces that are drawn inside parts of the hub that are always there: the queue's chip, the tick on a cited line, the decision bar's
// header, the Simple card's suggestion, Accept button and reason, and the AI's part of the case itself (`case`, which draws nothing). One lazy
// part with a `part` prop, so it is one chunk and one fetch. Accepting goes through `AiCaseApi.accept` (the same hold, the same guards, the same
// go-on-to-the-next as the ladder's step); a button whose gate is shut does nothing.

export interface AiPartsProps {
  part: 'case' | 'bar' | 'suggest' | 'accept' | 'why' | 'chip' | 'tick';
  /** The queue row's person (the chip). */
  group?: QueueGroup;
  /** The line (the tick). */
  lineId?: string;
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

/** What the AI's part of the case published, unless the moderator hid the AI on this case. */
function useApi() {
  const c = useCase();
  const [hidden] = useAiHidden(c.reportId);
  return { c, api: hidden ? null : c.aiCase };
}

/** The sentence for a shut gate, or null when the form was only edited (it says so in its label and needs no excuse). */
function useWhy(): string | null {
  const t = useAiT();
  const { api } = useApi();
  if (api === null || api.gate === null || api.gate.ok || api.gate.why === 'edited') return null;
  const why = api.gate.why;
  return t(why === 'step' && api.from?.held === null ? 'hub.ai.why.nostep' : WHY[why]);
}

/** "Accept AI suggestion: Restrict chat, 24 hours", or "...: no action needed". Null when the suggestion names no step to accept. */
function useAcceptLabel(): string | null {
  const t = useAiT();
  const { t: hubT, locale } = useHub();
  const { api } = useApi();
  const from = api?.from;
  if (from === null || from === undefined) return null;
  if (from.kind === 'dismiss') return t('hub.ai.accept.dismiss');
  return from.choice === null ? null : t('hub.ai.accept.with', { step: stepLabel(hubT, locale, from.choice) });
}

function Bar() {
  const t = useAiT();
  const { shortcuts } = useHub();
  const quickOn = useQuickKeys().on;
  const keys = shortcuts && quickOn;
  const { c, api } = useApi();
  const hint = useId();
  const why = useWhy();
  const label = useAcceptLabel();
  const group = t('hub.ai.bar.label');
  if (api === null) return null;
  if (api.from === null) {
    // Level 2, a read, and nothing the AI is sure enough to fill: the bar is the ladder's, with a quiet word about it.
    return (
      <div className="cw-aibar" role="group" aria-label={group}>
        <p className="cw-hint">{t('hub.ai.bar.unsure')}</p>
      </div>
    );
  }
  const edited = api.source === 'edited';
  const ok = api.gate?.ok === true;
  return (
    <div className="cw-aibar" role="group" aria-label={group}>
      <div className="cw-aibar-head">
        <span className="cw-aitag">{t('hub.ai.tag')}</span>
        <strong>{t(edited ? 'hub.ai.bar.edited' : 'hub.ai.bar.suggested')}</strong>
        {!edited && label !== null && (
          <button
            type="button"
            className="cw-btn cw-btn--primary cw-ai-accept"
            aria-disabled={!ok || !api.usable || !c.cooled}
            {...(!ok ? { 'aria-describedby': hint } : {})}
            {...(keys ? { 'aria-keyshortcuts': 'A' } : {})}
            onClick={(e) => ok && api.accept(e)}
          >
            <span>{label}</span>
            {keys && (
              <span aria-hidden="true">
                <Kbd>A</Kbd>
              </span>
            )}
          </button>
        )}
        {!edited && (
          <button type="button" className="cw-btn cw-ai-edit" {...(keys ? { 'aria-keyshortcuts': 'E' } : {})} onClick={() => c.aiBus.edit.current?.()}>
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
function Suggest() {
  const t = useAiT();
  const { t: hubT, locale } = useHub();
  const { c, api } = useApi();
  const id = useId();
  const from = api?.from;
  if (from === null || from === undefined) return null;
  const target = c.people.find((p) => p.role === 'target');
  const name = target === undefined ? '' : personName(target, c.people, hubT);
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
function Accept() {
  const { shortcuts } = useHub();
  const quickOn = useQuickKeys('simple').on;
  const keyed = shortcuts && quickOn;
  const label = useAcceptLabel();
  const { c, api } = useApi();
  if (label === null || api === null) return null;
  const ok = api.gate?.ok === true;
  return (
    <button
      type="button"
      className="cw-btn cw-btn--primary cw-ai-accept"
      aria-disabled={!ok || !api.usable || !c.cooled}
      {...(ok && api.usable && !c.cooled ? { 'data-cooling': 'true' } : {})}
      {...(keyed ? { 'aria-keyshortcuts': 'A 1' } : {})}
      onClick={(e) => ok && api.accept(e)}
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

function Why() {
  const why = useWhy();
  return why === null ? null : <p className="cw-hint cw-scard-fine">{why}</p>;
}

/** The queue's one AI chip: the conduct level the AI read, in a word, neutral with a dashed outline. It says nothing of the evidence. */
function Chip({ group }: { group: QueueGroup }) {
  const t = useAiT();
  const { t: hubT } = useHub();
  const { ai } = readsOf(group);
  if (ai === null) return null;
  return (
    <span className="cw-aichip" title={hubT('hub.ai.label')}>
      <span className="cw-sr">{t('hub.ai.chip')} </span>
      {hubT(`hub.decide.suggest.level.${ai.severity}`)}
    </span>
  );
}

/** A small mark on a line the AI cited. Not a control; its words are for a screen reader and the tooltip. */
function Tick({ lineId }: { lineId: string }) {
  const t = useAiT();
  const c = useCase();
  const [hidden] = useAiHidden(c.reportId);
  if (hidden || c.aiRead?.evidenceLineIds.includes(lineId) !== true) return null;
  return (
    <span className="cw-aitick" title={t('hub.ai.tick')}>
      <span aria-hidden="true">✓</span>
      <span className="cw-sr">{t('hub.ai.tick')}</span>
    </span>
  );
}

export function AiParts({ part, group, lineId }: AiPartsProps) {
  switch (part) {
    case 'case':
      return <AiCase />;
    case 'bar':
      return <Bar />;
    case 'suggest':
      return <Suggest />;
    case 'accept':
      return <Accept />;
    case 'why':
      return <Why />;
    case 'chip':
      return group === undefined ? null : <Chip group={group} />;
    case 'tick':
      return lineId === undefined ? null : <Tick lineId={lineId} />;
  }
}

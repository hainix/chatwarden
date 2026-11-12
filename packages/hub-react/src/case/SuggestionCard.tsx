import { useId } from 'react';
import { useHub } from '../context.js';
import { MAX_ACTIONS, needsBanPermission, outcomeChoice } from '../decision.js';
import type { Problem } from '../decision.js';
import { decideErrorText, outcomeLabel } from '../labels.js';
import { Card, Notice, Segmented } from '../ui.js';
import { Field, RuleOptions } from './ActionEditor.js';
import type { DecisionDraft } from './useDecisionForm.js';

const LEVELS = ['banter', 'rude', 'hostile', 'severe'] as const;

/** The ladder's suggestion as a card, with the rule of its action, and Change, which opens the full editor. */
export function SuggestionCard({
  draft,
  editing,
  setEditing,
  dismissal,
  panelId,
  problemsOf,
  nameOfTarget,
}: {
  draft: DecisionDraft;
  editing: boolean;
  setEditing: (on: boolean) => void;
  dismissal: boolean;
  panelId: string;
  problemsOf: (uid: string) => { rule?: Problem } | undefined;
  nameOfTarget: string;
}) {
  const { t, locale } = useHub();
  const id = useId();
  const choice = outcomeChoice(draft.suggestion.outcome);
  const added = draft.suggestionIndex >= 0 ? draft.form.actions[draft.suggestionIndex] : undefined;
  const permanentBlocked = choice !== null && needsBanPermission(choice) && !draft.ctx.canPermanent;
  const canAdd = choice !== null && draft.ctx.canApply && added === undefined && !permanentBlocked && !dismissal && draft.cannotAdd === null;

  let why: string | null = null;
  if (choice !== null && added === undefined && draft.ctx.canApply) {
    if (dismissal) why = t('hub.decide.suggest.fairOnly');
    else if (permanentBlocked) why = t('hub.decide.suggest.needsSenior');
    else if (draft.cannotAdd === 'limit') why = t('hub.decide.suggest.cannot.limit', { max: MAX_ACTIONS });
    else if (draft.cannotAdd === 'unsupported') why = t('hub.decide.suggest.cannot.unsupported');
  }

  return (
    <div className="cw-suggest" role="group" aria-labelledby={`${id}-title`} data-added={added === undefined ? 'false' : 'true'}>
      <h3 id={`${id}-title`} className="cw-sr">
        {t('hub.decide.suggest.title')}
      </h3>
      <div className="cw-suggest-main">
        {choice !== null && <Card kind={choice.kind} />}
        <div className="cw-suggest-text">
          <p className="cw-suggest-label">{outcomeLabel(t, locale, draft.suggestion.outcome)}</p>
          <p className="cw-hint">{draft.suggestion.why}</p>
        </div>
        <button type="button" className="cw-btn" aria-expanded={editing} aria-controls={panelId} onClick={() => setEditing(!editing)}>
          {t(editing ? 'hub.decide.done' : 'hub.decide.change')}
        </button>
      </div>
      {added !== undefined && !editing && (
        <div className="cw-suggest-rule">
          <Field id={`${id}-rule`} label={t('hub.decide.action.rule')} problem={problemsOf(added.uid)?.rule}>
            {(a) => (
              <select {...a} value={added.rule} onChange={(e) => draft.patchAction(added.uid, { rule: e.target.value })}>
                <RuleOptions rules={draft.rules} />
              </select>
            )}
          </Field>
          <p className="cw-hint">{added.lineIds.length === 0 ? t('hub.decide.action.lines.noneChosen', { name: nameOfTarget }) : t('hub.decide.action.lines.summary', { count: added.lineIds.length, name: nameOfTarget })}</p>
        </div>
      )}
      {editing && (
        <div className="cw-suggest-level" aria-busy={draft.levelBusy}>
          <Segmented
            label={t('hub.decide.suggest.level')}
            value={draft.level ?? ''}
            options={LEVELS.map((l) => ({ value: l as string, label: t(`hub.decide.suggest.level.${l}`) }))}
            onChange={(v) => draft.pickLevel(v as (typeof LEVELS)[number])}
          />
        </div>
      )}
      {draft.levelError !== null && (
        <Notice tone="bad" role="alert">
          <span>{t('hub.decide.suggest.failed')}</span> <span>{decideErrorText(t, draft.levelError)}</span>
        </Notice>
      )}
      {canAdd && (
        <button type="button" className="cw-btn" aria-disabled={draft.levelBusy} onClick={() => !draft.levelBusy && draft.useSuggestion()}>
          {t(draft.aiFrom === null ? 'hub.decide.suggest.use' : 'hub.ai.addStep')}
        </button>
      )}
      {why !== null && <p className="cw-hint">{why}</p>}
    </div>
  );
}

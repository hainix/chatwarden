import { useState } from 'react';
import type { PhraseRuleSettings } from '@chatwarden/core';
import { FILTER_LIMITS, FILTER_RULE_DEFAULTS } from '@chatwarden/core';
import { useHub } from '../context.js';
import { idFromName, newPhrase } from '../policy/filters.js';
import { ActionChoice, Card, ProblemLine, RuleField } from './parts.js';
import type { Problem } from './parts.js';

const AUTO_ID = /^rule\d+$/;

/** Phrases: up to 20 rules, each a name, patterns (one to a line), an action and a Community Rule. The patterns are the kit's own small vocabulary, never a regular expression. */
export function PhraseCard({ value, onChange, problem, flagCap }: { value: PhraseRuleSettings[]; onChange: (v: PhraseRuleSettings[]) => void; problem: Problem | null; flagCap: number }) {
  const { t } = useHub();
  // The switch is on while there are rules, and also right after it is switched on with none yet (a card with no rule has nothing to say).
  const [open, setOpen] = useState(false);
  const on = open || value.length > 0;
  const set = (i: number, patch: Partial<PhraseRuleSettings>): void => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Card
      title={t('hub.settings.filters.phrases.title')}
      hint={t('hub.settings.filters.phrases.hint')}
      on={on}
      onToggle={(next) => {
        setOpen(next);
        if (!next) onChange([]);
      }}
    >
      {value.map((p, i) => {
        const name = p.label !== undefined && p.label !== '' ? p.label : t('hub.settings.filters.phrases.unnamed', { n: i + 1 });
        return (
          <fieldset key={i} className="cw-fphrase">
            <legend>{t('hub.settings.filters.phrases.rule', { n: i + 1 })}</legend>
            <div className="cw-field">
              <label htmlFor={`cw-fph-${i}-name`}>{t('hub.settings.filters.phrases.name')}</label>
              <input
                id={`cw-fph-${i}-name`}
                type="text"
                maxLength={FILTER_LIMITS.labelChars}
                value={p.label ?? ''}
                onChange={(e) => {
                  // A rule with an automatic id takes its counter id from its name; one that has its own id keeps it (its counts and queue chips stay with it).
                  const label = e.target.value;
                  set(i, AUTO_ID.test(p.id) || p.id === '' ? { label, id: idFromName(label, value.filter((_, j) => j !== i).map((x) => x.id), `rule${i + 1}`) } : { label });
                }}
              />
            </div>
            <div className="cw-field">
              <label htmlFor={`cw-fph-${i}-pat`}>{t('hub.settings.filters.phrases.patterns')}</label>
              <textarea id={`cw-fph-${i}-pat`} rows={3} value={p.phrases.join('\n')} onChange={(e) => set(i, { phrases: e.target.value.split('\n') })} />
            </div>
            <ActionChoice
              value={p.action}
              onChange={(action) => set(i, { action })}
              about={(a) => (a === 'flag' ? t('hub.settings.filters.action.flag.about', { count: flagCap }) : t(`hub.settings.filters.action.${a}.about` as never))}
            />
            <RuleField value={p.rule ?? FILTER_RULE_DEFAULTS.phrases} onChange={(rule) => set(i, { rule })} />
            <button type="button" className="cw-btn" aria-label={t('hub.settings.filters.phrases.remove', { name })} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              {t('hub.settings.filters.phrases.removeShort')}
            </button>
          </fieldset>
        );
      })}
      <p className="cw-hint">{t('hub.settings.filters.phrases.help')}</p>
      {value.length < FILTER_LIMITS.rules && (
        <button type="button" className="cw-btn" onClick={() => onChange([...value, newPhrase(value)])}>
          {t('hub.settings.filters.phrases.add')}
        </button>
      )}
      <ProblemLine problem={problem} card="phrases" />
    </Card>
  );
}

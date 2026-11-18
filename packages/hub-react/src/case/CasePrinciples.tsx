import { useId, useState } from 'react';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import type { PolicyDocs } from '../types.js';
import { useCase } from './CaseContext.js';
import { caseLevel, notesForRule, tierForLevel } from './principles.js';

// "Principles for this case": in the Detailed case pane, under the facts row, one collapsed disclosure showing the principle that matches the case's conduct level (the moderator's pick, else the
// AI read's, else the ladder's default: hostile for chat, rude for play and names) in the team's own words, and the team notes tied to the case's Community Rule. Plain text, never markup. Only for a role that may read the policy; the policy is
// the one the session already keeps. A failed read shows nothing: the case never waits on it.

export function CasePrinciples({ rule }: { rule: number | 'uncovered' }) {
  const { t, can, session } = useHub();
  const { draft, aiRead } = useCase();
  const allowed = can('policy.read');
  const [open, setOpen] = useState(false);
  const id = useId();
  const read = useHubData<PolicyDocs | null>(allowed ? 'case:principles' : 'case:principles:idle', () => (allowed ? session.policy() : Promise.resolve(null)));
  const docs = read.data;
  if (!allowed || docs == null) return null;
  const level = caseLevel(draft.level, aiRead?.severity, draft.evidence);
  const tier = tierForLevel(docs.profile.guidelines, level);
  const notes = notesForRule(docs.profile.teamNotes ?? [], rule, docs.rules);
  return (
    <div className="cw-case-principles">
      <button type="button" className="cw-btn cw-section-toggle" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen(!open)}>
        {t('hub.case.principles.title')}
      </button>
      {open && (
        <div id={`${id}-body`} className="cw-case-principles-body">
          <p className="cw-hint">{t('hub.case.principles.wrote')}</p>
          {tier === null ? (
            <p className="cw-hint">{t('hub.case.principles.none')}</p>
          ) : (
            <>
              <p>
                <strong>{tier.title}</strong>
              </p>
              <p>{tier.description}</p>
              {tier.examples.length > 0 && (
                <>
                  <p id={`${id}-examples`} className="cw-hint">
                    {t('hub.case.principles.examples')}
                  </p>
                  <ul aria-labelledby={`${id}-examples`}>
                    {tier.examples.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              )}
              <p>{t('hub.case.principles.outcome', { outcome: tier.outcome })}</p>
            </>
          )}
          {notes.length > 0 && (
            <>
              <p id={`${id}-notes`} className="cw-hint">
                {t('hub.case.principles.notes')}
              </p>
              <ul aria-labelledby={`${id}-notes`}>
                {notes.map((n, i) => (
                  <li key={i}>{n.text}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}

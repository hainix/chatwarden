import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ReportFlow } from '@chatwarden/core';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import type { HubText } from '../i18n.js';
import type { CommunityRule } from '../types.js';
import { Panel } from '../ui.js';
import { RulePicker } from './panels.js';
import type { Problems } from './panels.js';
import { MAX_REPORT_REASONS, addReason, canMove, groupsOf, isLocked, moveReason, patchReason, playerGroups, positionOf, removeReason } from './reporting.js';
import type { ReasonDraft, ReportingDraft } from './reporting.js';

// The panels of the Reporting screen. Each edits the local draft; none of them sends anything. A field carries `data-field`, the key the
// screen uses to put keyboard focus on it when the kit refuses it. Every word is from the catalog.

export type SetReporting = (update: (draft: ReportingDraft) => ReportingDraft) => void;

function FieldError({ id, problem }: { id: string; problem: Problem | undefined }) {
  const { t } = useHub();
  return problem === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(problem.key, problem.params)}
    </p>
  );
}

const FLOWS: ReadonlyArray<{ value: ReportFlow; title: HubText; line: HubText }> = [
  { value: 'one_tap', title: 'hub.reporting.flow.one_tap', line: 'hub.reporting.flow.one_tap.line' },
  { value: 'reason_first', title: 'hub.reporting.flow.reason_first', line: 'hub.reporting.flow.reason_first.line' },
  { value: 'reason_required', title: 'hub.reporting.flow.reason_required', line: 'hub.reporting.flow.reason_required.line' },
];

// ---- How players report ----------------------------------------------------------------------------------------------------

export function FlowPanel({ draft, set, problems }: { draft: ReportingDraft; set: SetReporting; problems: Problems }) {
  const { t } = useHub();
  const base = useId();
  const problem = problems['flow'];
  return (
    <Panel title={t('hub.reporting.flow.title')}>
      <div className="cw-form cw-panel-pad">
        <fieldset className="cw-flowopts" role="radiogroup" data-field="flow" tabIndex={-1} {...(problem === undefined ? {} : { 'aria-invalid': true as const })}>
          <legend className="cw-sr">{t('hub.reporting.flow.title')}</legend>
          {FLOWS.map((f) => (
            <label key={f.value} className="cw-choice cw-flowopt">
              <input type="radio" name={`${base}-flow`} value={f.value} checked={draft.flow === f.value} aria-labelledby={`${base}-${f.value}-t`} aria-describedby={`${base}-${f.value}-l`} onChange={() => set((d) => ({ ...d, flow: f.value }))} />
              <span>
                <strong id={`${base}-${f.value}-t`}>{t(f.title)}</strong>
                <span id={`${base}-${f.value}-l`} className="cw-hint cw-flowopt-line">
                  {t(f.line)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <FieldError id={`${base}-flow-err`} problem={problem} />
        <p className="cw-hint">{t('hub.reporting.flow.hint')}</p>
      </div>
    </Panel>
  );
}

// ---- Reasons ---------------------------------------------------------------------------------------------------------------

function ReasonRow({
  r,
  draft,
  set,
  problems,
  rules,
  onMoved,
  onRemoved,
}: {
  r: ReasonDraft;
  draft: ReportingDraft;
  set: SetReporting;
  problems: Problems;
  rules: readonly CommunityRule[];
  onMoved: (key: string, dir: 'up' | 'down') => void;
  onRemoved: () => void;
}) {
  const { t } = useHub();
  const id = useId();
  const [showRules, setShowRules] = useState(false);
  const name = r.label.trim() === '' ? t('hub.reporting.reason.new') : r.label.trim();
  const locked = isLocked(r);
  const field = (part: 'label' | 'hint' | 'group'): string => `reason-${r.key}-${part}`;
  const mark = (part: 'label' | 'hint' | 'group'): Record<string, unknown> => {
    const p = problems[field(part)];
    return p === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': `${id}-${part}-err` };
  };
  const patch = (p: Partial<Omit<ReasonDraft, 'key' | 'id'>>): void => set((d) => patchReason(d, r.key, p));
  const rulesProblem = problems[`reason-${r.key}-rules`];
  const groupList = `${id}-groups`;
  return (
    <li className="cw-reason">
      <div role="group" aria-label={t('hub.reporting.reason.row', { name })}>
        <div className="cw-reason-fields">
          <div className="cw-field">
            <label htmlFor={`${id}-label`}>{t('hub.reporting.reason.label')}</label>
            <input id={`${id}-label`} type="text" data-field={field('label')} value={r.label} onChange={(e) => patch({ label: e.target.value })} {...mark('label')} />
            <FieldError id={`${id}-label-err`} problem={problems[field('label')]} />
          </div>
          <div className="cw-field">
            <label htmlFor={`${id}-hint`}>{t('hub.reporting.reason.hint')}</label>
            <input id={`${id}-hint`} type="text" data-field={field('hint')} value={r.hint} onChange={(e) => patch({ hint: e.target.value })} {...mark('hint')} />
            <FieldError id={`${id}-hint-err`} problem={problems[field('hint')]} />
          </div>
          <div className="cw-field">
            <label htmlFor={`${id}-group`}>{t('hub.reporting.reason.group')}</label>
            <input id={`${id}-group`} type="text" list={groupList} data-field={field('group')} value={r.group} onChange={(e) => patch({ group: e.target.value })} {...mark('group')} />
            <datalist id={groupList}>
              {groupsOf(draft).map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
            <FieldError id={`${id}-group-err`} problem={problems[field('group')]} />
          </div>
        </div>
        <div className="cw-reason-flags">
          <label className="cw-tick">
            <input type="checkbox" checked={r.enabled || locked} disabled={locked} onChange={(e) => patch({ enabled: e.target.checked })} />
            <span>{t('hub.reporting.reason.on')}</span>
          </label>
          <label className="cw-tick">
            <input type="checkbox" checked={r.asksNote} onChange={(e) => patch({ asksNote: e.target.checked })} />
            <span>{t('hub.reporting.reason.asksNote')}</span>
          </label>
          <button type="button" className="cw-btn" aria-expanded={showRules} onClick={() => setShowRules(!showRules)}>
            {t('hub.reporting.reason.rules', { count: r.rules.length })}
          </button>
          <span className="cw-reason-moves">
            {!locked && (
              <>
                <button
                  type="button"
                  className="cw-btn"
                  data-act={`${r.key}-up`}
                  aria-disabled={!canMove(draft, r.key, -1)}
                  aria-label={t('hub.reporting.reason.up', { name })}
                  onClick={() => {
                    if (!canMove(draft, r.key, -1)) return;
                    set((d) => moveReason(d, r.key, -1));
                    onMoved(r.key, 'up');
                  }}
                >
                  <span aria-hidden="true">↑</span>
                </button>
                <button
                  type="button"
                  className="cw-btn"
                  data-act={`${r.key}-down`}
                  aria-disabled={!canMove(draft, r.key, 1)}
                  aria-label={t('hub.reporting.reason.down', { name })}
                  onClick={() => {
                    if (!canMove(draft, r.key, 1)) return;
                    set((d) => moveReason(d, r.key, 1));
                    onMoved(r.key, 'down');
                  }}
                >
                  <span aria-hidden="true">↓</span>
                </button>
              </>
            )}
            {!locked && (
              <button
                type="button"
                className="cw-btn"
                aria-label={t('hub.reporting.reason.remove', { name })}
                onClick={() => {
                  set((d) => removeReason(d, r.key));
                  onRemoved();
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            )}
          </span>
        </div>
        {locked && <p className="cw-hint">{t('hub.reporting.reason.locked')}</p>}
        {showRules && (
          <div className="cw-reason-rules">
            <p className="cw-hint">{t('hub.reporting.reason.rules.hint')}</p>
            <RulePicker field={`reason-${r.key}-rules`} legend={t('hub.reporting.reason.rules.legend')} picked={r.rules} rules={rules} onChange={(next) => patch({ rules: next })} problem={rulesProblem} />
          </div>
        )}
      </div>
    </li>
  );
}

export function ReasonsPanel({ draft, set, problems, rules }: { draft: ReportingDraft; set: SetReporting; problems: Problems; rules: readonly CommunityRule[] }) {
  const { t } = useHub();
  const list = useRef<HTMLUListElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  // What to focus after the list changes: a new row's name, the button of a row that moved, or the Add button after a removal.
  const [after, setAfter] = useState<{ kind: 'new' } | { kind: 'moved'; key: string; dir: 'up' | 'down' } | { kind: 'removed' } | null>(null);
  const added = useRef<string | null>(null);
  // Where a row went after a move, for a screen reader (the focus stays on the button, so nothing else says it).
  const [moved, setMoved] = useState('');
  useEffect(() => {
    if (after === null) return;
    if (after.kind === 'new' && added.current !== null) list.current?.querySelector<HTMLElement>(`[data-field="reason-${added.current}-label"]`)?.focus();
    else if (after.kind === 'moved') list.current?.querySelector<HTMLElement>(`[data-act="${after.key}-${after.dir}"]`)?.focus();
    else if (after.kind === 'removed') addButton.current?.focus();
    setAfter(null);
  }, [after]);
  const full = draft.reasons.length >= MAX_REPORT_REASONS;
  const problem = problems['reasons'];
  return (
    <Panel title={t('hub.reporting.reasons.title')}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.reporting.reasons.hint')}</p>
        {problem !== undefined && <FieldError id="cw-reasons-err" problem={problem} />}
        <ul ref={list} className="cw-reasons" aria-label={t('hub.reporting.reasons.list')} data-field="reasons" tabIndex={-1}>
          {draft.reasons.map((r) => (
            <ReasonRow
              key={r.key}
              r={r}
              draft={draft}
              set={set}
              problems={problems}
              rules={rules}
              onMoved={(key, dir) => {
                setAfter({ kind: 'moved', key, dir });
                const at = positionOf(moveReason(draft, key, dir === 'up' ? -1 : 1), key);
                const label = draft.reasons.find((x) => x.key === key)?.label.trim() ?? '';
                if (at !== null) setMoved(t('hub.reporting.reason.moved', { name: label === '' ? t('hub.reporting.reason.new') : label, n: at.n, total: at.total }));
              }}
              onRemoved={() => setAfter({ kind: 'removed' })}
            />
          ))}
        </ul>
        <p role="status" className="cw-sr">
          {moved}
        </p>
        <div className="cw-action-foot">
          <button
            ref={addButton}
            type="button"
            className="cw-btn"
            aria-disabled={full}
            onClick={() => {
              // At the limit `addReason` gives no row (the button is also marked unavailable).
              const next = addReason(draft);
              if (next.key === null) return;
              added.current = next.key;
              set(() => next.draft);
              setAfter({ kind: 'new' });
            }}
          >
            {t('hub.reporting.reasons.add')}
          </button>
          <p className="cw-hint">{t('hub.reporting.reasons.count', { count: draft.reasons.length, max: MAX_REPORT_REASONS })}</p>
        </div>
      </div>
    </Panel>
  );
}

// ---- Thank-you -------------------------------------------------------------------------------------------------------------

export function ThanksPanel({ draft, set, problems }: { draft: ReportingDraft; set: SetReporting; problems: Problems }) {
  const { t } = useHub();
  const id = useId();
  const problem = problems['thanks'];
  return (
    <Panel title={t('hub.reporting.thanks.title')}>
      <div className="cw-form cw-panel-pad">
        <div className="cw-field">
          <label htmlFor={id}>{t('hub.reporting.thanks.label')}</label>
          <p className="cw-hint">{t('hub.reporting.thanks.hint')}</p>
          <textarea id={id} data-field="thanks" rows={2} value={draft.thanks} {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-err` })} onChange={(e) => set((d) => ({ ...d, thanks: e.target.value }))} />
          <FieldError id={`${id}-err`} problem={problem} />
        </div>
      </div>
    </Panel>
  );
}

// ---- What players see ------------------------------------------------------------------------------------------------------

/**
 * A rough picture of the player's report window with the draft's settings, drawn from the draft (text only, nothing to press). The
 * window is one step in every flow: the question, the line, "Why?" (a select, the reasons by group; required in `reason_required`),
 * a door to a note, Report and Cancel; then "Report sent" and the thank-you. With no reason to offer there is just the question and Report.
 */
export function PlayersSee({ draft }: { draft: ReportingDraft }) {
  const { t } = useHub();
  const groups = playerGroups(draft);
  const hasReasons = groups.length > 0;
  const required = hasReasons && draft.flow === 'reason_required';
  const thanks = draft.thanks.trim();
  const body: ReactNode = (
    <>
      <p className="cw-mock-title">{t('hub.reporting.preview.oneTap.title')}</p>
      <p className="cw-mock-quote">{t('hub.reporting.preview.line')}</p>
      {hasReasons && (
        <div className="cw-mock-field">
          <p className="cw-mock-legend">
            {required ? t('hub.reporting.preview.whyRequired') : t('hub.reporting.preview.why')}
            {required && (
              <span className="cw-mock-req" aria-hidden="true">
                {' *'}
              </span>
            )}
          </p>
          <p className="cw-mock-select">{required ? t('hub.reporting.preview.chooseRequired') : t('hub.reporting.preview.choose')}</p>
          {groups.map((g, i) => (
            <div key={`${g.name}-${i}`} className="cw-mock-group">
              {g.name !== '' && <p className="cw-mock-heading">{g.name}</p>}
              <ul>
                {g.labels.map((label, j) => (
                  <li key={`${label}-${j}`}>{label}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      {hasReasons && <p className="cw-mock-door">{t('hub.reporting.preview.addNote')}</p>}
      <p>
        <span className="cw-mock-btn cw-mock-btn--primary">{t('hub.reporting.preview.report')}</span>
        <span className="cw-mock-btn">{t('hub.reporting.preview.cancel')}</span>
      </p>
    </>
  );
  return (
    <Panel title={t('hub.reporting.preview.title')}>
      <div className="cw-panel-pad">
        <p className="cw-hint">{t('hub.reporting.preview.hint')}</p>
        <div className="cw-mock">
          <p className="cw-mock-tag">{t('hub.reporting.preview.example')}</p>
          {body}
          <div className="cw-mock-after">
            <p className="cw-hint">{t('hub.reporting.preview.after')}</p>
            <p className="cw-mock-title">{t('hub.reporting.preview.sent')}</p>
            <p className="cw-mock-thanks">{thanks}</p>
          </div>
        </div>
      </div>
    </Panel>
  );
}

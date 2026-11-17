import { useId } from 'react';
import type { ReactNode } from 'react';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import type { PanelProps } from '../lazyParts.js';
import { deskDirty, deskDraftOf, deskFieldKey, deskProblems, deskSection, firstDeskField } from '../policy/desk.js';
import type { DeskDraft } from '../policy/desk.js';
import { SectionShell, useSectionEditor } from '../policy/useSectionEditor.js';

// Settings > Advanced > "The desk": three switches, each with one sentence (staff comments and asking for a second look, the Insights page, naming a report surge on a case) and the
// surge's three numbers. Everything is off until the owner turns it on. Saved through the same policy machinery as the other panels; the owner edits, everyone else reads.

function Row({ id, label, line, on, onToggle, children }: { id: string; label: string; line: string; on: boolean; onToggle: (on: boolean) => void; children?: ReactNode }) {
  return (
    <div className="cw-pace-row">
      <label className="cw-choice cw-flowopt">
        <input type="checkbox" checked={on} aria-labelledby={`${id}-t`} aria-describedby={`${id}-line`} onChange={(e) => onToggle(e.target.checked)} />
        <span>
          <strong id={`${id}-t`}>{label}</strong>
          <span id={`${id}-line`} className="cw-hint cw-flowopt-line">
            {line}
          </span>
        </span>
      </label>
      {children !== undefined && <div className="cw-pace-fields">{children}</div>}
    </div>
  );
}

function NumberField({ id, field, label, value, problem, onChange }: { id: string; field: string; label: string; value: string; problem: Problem | undefined; onChange: (v: string) => void }) {
  const { t } = useHub();
  return (
    <div className="cw-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="text" inputMode="numeric" data-field={field} value={value} onChange={(e) => onChange(e.target.value)} {...(problem === undefined ? {} : { 'aria-invalid': true as const, 'aria-describedby': `${id}-err` })} />
      {problem !== undefined && (
        <p id={`${id}-err`} className="cw-field-error">
          {t(problem.key, problem.params)}
        </p>
      )}
    </div>
  );
}

export function DeskSettings({ state, policy }: PanelProps) {
  const { t } = useHub();
  const id = useId();
  const editor = useSectionEditor<DeskDraft>({
    state,
    policy,
    section: 'desk',
    reset: 'desk',
    draftOf: (s) => deskDraftOf(s.effective.desk),
    problemsOf: deskProblems,
    // A section that means what the profile in code says is left out of the layer, so it keeps following the code.
    sectionOf: (d, s) => (JSON.stringify(deskSection(d)) === JSON.stringify(deskSection(deskDraftOf(s.base.desk))) ? null : deskSection(d)),
    dirtyOf: (d, s) => deskDirty(d, s.effective.desk),
    fieldOf: (path) => deskFieldKey(path),
    firstOf: firstDeskField,
    saved: 'hub.settings.desk.saved',
  });
  const { draft, set, problems } = editor;
  return (
    <SectionShell editor={editor} title={t('hub.settings.desk.title')} intro={t('hub.settings.desk.intro')} saveLabel={t('hub.settings.desk.save.form')}>
      <Row id={`${id}-wf`} label={t('hub.settings.desk.workflow')} line={t('hub.settings.desk.workflow.line')} on={draft.workflow} onToggle={(workflow) => set((d) => ({ ...d, workflow }))} />
      <Row id={`${id}-in`} label={t('hub.settings.desk.insights')} line={t('hub.settings.desk.insights.line')} on={draft.insights} onToggle={(insights) => set((d) => ({ ...d, insights }))} />
      <Row id={`${id}-su`} label={t('hub.settings.desk.surge')} line={t('hub.settings.desk.surge.line')} on={draft.surge} onToggle={(surge) => set((d) => ({ ...d, surge }))}>
        <NumberField id={`${id}-reports`} field="reports" label={t('hub.settings.desk.surge.reports')} value={draft.reports} problem={problems['reports']} onChange={(reports) => set((d) => ({ ...d, reports }))} />
        <NumberField id={`${id}-minutes`} field="minutes" label={t('hub.settings.desk.surge.minutes')} value={draft.minutes} problem={problems['minutes']} onChange={(minutes) => set((d) => ({ ...d, minutes }))} />
        <NumberField id={`${id}-days`} field="days" label={t('hub.settings.desk.surge.days')} value={draft.days} problem={problems['days']} onChange={(days) => set((d) => ({ ...d, days }))} />
      </Row>
    </SectionShell>
  );
}

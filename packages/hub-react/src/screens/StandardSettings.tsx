import { useId } from 'react';
import { useHub } from '../context.js';
import type { PanelProps } from '../lazyParts.js';
import { MAX_AI_CONTEXT, firstStandardField, standardDirty, standardDraftOf, standardFieldKey, standardProblems, standardSection } from '../policy/standard.js';
import type { StandardDraft } from '../policy/standard.js';
import { charsOf } from '../policy/reporting.js';
import { SectionShell, useSectionEditor } from '../policy/useSectionEditor.js';

// Settings > Advanced > "The AI's standard": the plain-language standard the AI read weighs reports against, together with the principles. Collapsed until opened, a lazy chunk, edited by the
// owner and read by everyone else; saved through the same policy machinery as the others. A text equal to the profile in code is left out of the layer, so it keeps following the code.

export function StandardSettings({ state, policy }: PanelProps) {
  const { t } = useHub();
  const id = useId();
  const editor = useSectionEditor<StandardDraft>({
    state,
    policy,
    section: 'aiContext',
    reset: 'standard',
    draftOf: standardDraftOf,
    problemsOf: standardProblems,
    sectionOf: standardSection,
    dirtyOf: standardDirty,
    fieldOf: standardFieldKey,
    firstOf: firstStandardField,
    saved: 'hub.settings.standard.saved',
  });
  const { draft, set, problems, isDirty } = editor;
  const problem = problems['standard'];
  // The kit screened the saved standard out of the AI read: said next to the box, and only while the text is as saved (an edit may have changed what is flagged).
  const flagged = !isDirty && state.promptExcluded?.aiContext === true;
  return (
    <SectionShell editor={editor} title={t('hub.settings.standard.title')} intro={t('hub.settings.standard.intro')} saveLabel={t('hub.settings.standard.save.form')} disclosure={t('hub.settings.standard.open')}>
      <div className="cw-field">
        <label htmlFor={`${id}-text`}>{t('hub.settings.standard.label')}</label>
        <textarea
          id={`${id}-text`}
          rows={8}
          data-field="standard"
          value={draft.text}
          aria-describedby={[`${id}-count`, problem !== undefined && `${id}-err`, flagged && `${id}-ai`].filter(Boolean).join(' ')}
          {...(problem === undefined ? {} : { 'aria-invalid': true as const })}
          onChange={(e) => set(() => ({ text: e.target.value }))}
        />
        <p id={`${id}-count`} className="cw-hint cw-counter">
          {t('hub.settings.principle.count', { count: charsOf(draft.text.trim()), max: MAX_AI_CONTEXT })}
        </p>
        {problem !== undefined && (
          <p id={`${id}-err`} className="cw-field-error">
            {t(problem.key, problem.params)}
          </p>
        )}
        {flagged && (
          <p id={`${id}-ai`} className="cw-field-warn">
            {t('hub.settings.standard.excluded')}
          </p>
        )}
      </div>
    </SectionShell>
  );
}

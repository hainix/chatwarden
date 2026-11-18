import { useId } from 'react';
import { useHub } from '../context.js';
import type { PanelProps } from '../lazyParts.js';
import type { Problem } from '../decision.js';
import { DEFAULT_SAFETY_GUIDANCE, SAFETY_GUIDANCE_MAX, SAFETY_RESOURCES_MAX, firstSafetyField, freshResource, safetyDirty, safetyDraftOf, safetyFieldKey, safetyLayer, safetyProblems } from '../policy/safety.js';
import type { SafetyDraft } from '../policy/safety.js';
import { charsOf } from '../policy/reporting.js';
import { SectionShell, useSectionEditor } from '../policy/useSectionEditor.js';

// Settings > Advanced > "Safety and urgent cases": the owner's own words for an urgent case. The guidance a moderator reads in the "What to do" panel (the kit's default is only the
// placeholder here and is not saved unless the owner types their own), one studio contact line for staff, and up to five resources a reporter is shown. The kit judges nothing and
// contacts no one; the panel says so. Collapsed until opened, a lazy chunk, edited by the owner and read by everyone else; saved through the same policy machinery as the others.

function FieldError({ id, problem }: { id: string; problem: Problem | undefined }) {
  const { t } = useHub();
  return problem === undefined ? null : (
    <p id={id} className="cw-field-error">
      {t(problem.key, problem.params)}
    </p>
  );
}

export function SafetySettings({ state, policy }: PanelProps) {
  const { t } = useHub();
  const id = useId();
  const editor = useSectionEditor<SafetyDraft>({
    state,
    policy,
    section: 'safety',
    reset: 'safety',
    draftOf: (s) => safetyDraftOf(s.effective.safety),
    problemsOf: safetyProblems,
    // A section the same as the profile in code is left out of the layer, so it keeps following the code.
    sectionOf: (d, s) => {
      const mine = safetyLayer(d);
      return JSON.stringify(mine) === JSON.stringify(safetyLayer(safetyDraftOf(s.base.safety))) ? null : mine;
    },
    dirtyOf: (d, s) => safetyDirty(d, s.effective.safety),
    fieldOf: safetyFieldKey,
    firstOf: firstSafetyField,
    saved: 'hub.settings.safety.saved',
  });
  const { draft, set, problems, editable } = editor;
  const mark = (field: string, errId: string): Record<string, unknown> => (problems[field] === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': errId });
  const full = draft.resources.length >= SAFETY_RESOURCES_MAX;
  const patchResource = (key: string, patch: Partial<Record<'label' | 'detail' | 'url', string>>): void => set((d) => ({ ...d, resources: d.resources.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));

  return (
    <SectionShell editor={editor} title={t('hub.settings.safety.title')} intro={t('hub.settings.safety.intro')} saveLabel={t('hub.settings.safety.save.form')} disclosure={t('hub.settings.safety.open')}>
      <div className="cw-field">
        <label htmlFor={`${id}-guidance`}>{t('hub.settings.safety.guidance')}</label>
        <p id={`${id}-guidance-hint`} className="cw-hint">
          {t('hub.settings.safety.guidance.hint')}
        </p>
        <textarea
          id={`${id}-guidance`}
          rows={6}
          data-field="guidance"
          value={draft.guidance}
          placeholder={DEFAULT_SAFETY_GUIDANCE}
          aria-describedby={`${id}-guidance-hint ${id}-guidance-count${problems['guidance'] === undefined ? '' : ` ${id}-guidance-err`}`}
          {...(problems['guidance'] === undefined ? {} : { 'aria-invalid': true as const })}
          onChange={(e) => set((d) => ({ ...d, guidance: e.target.value }))}
        />
        <p id={`${id}-guidance-count`} className="cw-hint">
          {t('hub.settings.reporting.thanks.count', { count: charsOf(draft.guidance), max: SAFETY_GUIDANCE_MAX })}
        </p>
        <FieldError id={`${id}-guidance-err`} problem={problems['guidance']} />
      </div>
      <div className="cw-field">
        <label htmlFor={`${id}-contact`}>{t('hub.settings.safety.contact')}</label>
        <p id={`${id}-contact-hint`} className="cw-hint">
          {t('hub.settings.safety.contact.hint')}
        </p>
        <input id={`${id}-contact`} type="text" data-field="contact" value={draft.contact} aria-describedby={`${id}-contact-hint${problems['contact'] === undefined ? '' : ` ${id}-contact-err`}`} {...mark('contact', `${id}-contact-err`)} onChange={(e) => set((d) => ({ ...d, contact: e.target.value }))} />
        <FieldError id={`${id}-contact-err`} problem={problems['contact']} />
      </div>
      <fieldset className="cw-safety-resources">
        <legend>{t('hub.settings.safety.resources')}</legend>
        <p className="cw-hint">{t('hub.settings.safety.resources.hint', { max: SAFETY_RESOURCES_MAX })}</p>
        <ul className="cw-safety-list" aria-label={t('hub.settings.safety.resources')}>
          {draft.resources.map((r, i) => {
            const n = i + 1;
            const f = (part: 'label' | 'detail' | 'url'): string => `resource-${r.key}-${part}`;
            return (
              <li key={r.key} className="cw-safety-resource">
                <div className="cw-field">
                  <label htmlFor={`${id}-${r.key}-label`}>{t('hub.settings.safety.resource.name', { n })}</label>
                  <input id={`${id}-${r.key}-label`} type="text" data-field={f('label')} value={r.label} {...mark(f('label'), `${id}-${r.key}-label-err`)} onChange={(e) => patchResource(r.key, { label: e.target.value })} />
                  <FieldError id={`${id}-${r.key}-label-err`} problem={problems[f('label')]} />
                </div>
                <div className="cw-field">
                  <label htmlFor={`${id}-${r.key}-detail`}>{t('hub.settings.safety.resource.detail', { n })}</label>
                  <input id={`${id}-${r.key}-detail`} type="text" data-field={f('detail')} value={r.detail} {...mark(f('detail'), `${id}-${r.key}-detail-err`)} onChange={(e) => patchResource(r.key, { detail: e.target.value })} />
                  <FieldError id={`${id}-${r.key}-detail-err`} problem={problems[f('detail')]} />
                </div>
                <div className="cw-field">
                  <label htmlFor={`${id}-${r.key}-url`}>{t('hub.settings.safety.resource.link', { n })}</label>
                  <input id={`${id}-${r.key}-url`} type="text" inputMode="url" data-field={f('url')} value={r.url} {...mark(f('url'), `${id}-${r.key}-url-err`)} onChange={(e) => patchResource(r.key, { url: e.target.value })} />
                  <FieldError id={`${id}-${r.key}-url-err`} problem={problems[f('url')]} />
                </div>
                {editable && (
                  <button type="button" className="cw-btn" aria-label={t('hub.settings.safety.resource.remove', { n })} onClick={() => set((d) => ({ ...d, resources: d.resources.filter((x) => x.key !== r.key) }))}>
                    <span aria-hidden="true">{'\u00d7'}</span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {editable && (
          <button type="button" className="cw-btn" aria-disabled={full} onClick={() => !full && set((d) => ({ ...d, resources: [...d.resources, freshResource()] }))}>
            {t('hub.settings.safety.resource.add')}
          </button>
        )}
        {full && <p className="cw-hint">{t('hub.settings.safety.error.resources', { max: SAFETY_RESOURCES_MAX })}</p>}
      </fieldset>
      <p className="cw-hint">{t('hub.safety.limits')}</p>
    </SectionShell>
  );
}

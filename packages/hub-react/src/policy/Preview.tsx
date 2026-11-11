import { useId } from 'react';
import { useHub } from '../context.js';
import type { HubText } from '../i18n.js';
import type { CommunityRule, ConductLevel, PolicySamples, SanctionKind } from '../types.js';
import { Card, Loading, Panel, Scroll } from '../ui.js';

// What the draft would suggest, for sample records and each conduct level, before anything is saved. The samples are the kit's: the
// screen only draws them. A suggestion is a referee card and the kit's own words for it.

/** The last samples the kit answered (none yet: loading), and why the draft has no newer ones, if so: a setting to fix, or a layer the kit refuses. */
export interface PreviewState {
  samples: PolicySamples | null;
  note: 'blocked' | 'failed' | null;
}

const LEVELS: readonly ConductLevel[] = ['banter', 'rude', 'hostile', 'severe'];
const SAMPLES: ReadonlyArray<{ key: keyof PolicySamples; label: HubText }> = [
  { key: 'clean', label: 'hub.settings.preview.sample.clean' },
  { key: 'oneWarning', label: 'hub.settings.preview.sample.oneWarning' },
  { key: 'chat24h', label: 'hub.settings.preview.sample.chat24h' },
  { key: 'ban7d', label: 'hub.settings.preview.sample.ban7d' },
];
const LEVEL_TEXT: Record<ConductLevel, HubText> = {
  banter: 'hub.decide.suggest.level.banter',
  rude: 'hub.decide.suggest.level.rude',
  hostile: 'hub.decide.suggest.level.hostile',
  severe: 'hub.decide.suggest.level.severe',
};

export function Preview({ state, rules, rule, onRule }: { state: PreviewState; rules: readonly CommunityRule[]; rule: number | null; onRule: (rule: number | null) => void }) {
  const { t } = useHub();
  const id = useId();
  const samples = state.samples;
  const active = rules.filter((r) => r.retired !== true).sort((a, b) => a.number - b.number);
  return (
    <Panel title={t('hub.settings.preview.title')}>
      <div className="cw-form cw-panel-pad">
        <p className="cw-hint">{t('hub.settings.preview.hint')}</p>
        <div className="cw-field cw-preview-rule">
          <label htmlFor={id}>{t('hub.settings.preview.rule')}</label>
          <select id={id} value={rule === null ? '' : String(rule)} onChange={(e) => onRule(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">{t('hub.settings.preview.rule.none')}</option>
            {active.map((r) => (
              <option key={r.number} value={String(r.number)}>
                {t('hub.guide.rule.named', { number: r.number, title: r.title })}
              </option>
            ))}
          </select>
        </div>
        {state.note === 'blocked' && <p className="cw-hint">{t('hub.settings.preview.blocked')}</p>}
        {state.note === 'failed' && <p className="cw-hint">{t('hub.settings.preview.failed')}</p>}
      </div>
      {state.samples === null && state.note === null && <Loading />}
      {samples !== null && (
        <Scroll label={t('hub.settings.preview.table')}>
          <table className="cw-table cw-grid">
            <thead>
              <tr>
                <th scope="col">{t('hub.settings.preview.record')}</th>
                {LEVELS.map((level) => (
                  <th key={level} scope="col">
                    {t(LEVEL_TEXT[level])}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SAMPLES.map((sample) => (
                <tr key={sample.key}>
                  <th scope="row">{t(sample.label)}</th>
                  {LEVELS.map((level) => {
                    const o = samples[sample.key][level];
                    return (
                      <td key={level}>
                        <span className="cw-ladder-cell">
                          {o.kind !== 'none' && <Card kind={o.kind as SanctionKind} />}
                          <span>{o.kind === 'none' ? t('hub.settings.preview.none') : o.label}</span>
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Scroll>
      )}
    </Panel>
  );
}

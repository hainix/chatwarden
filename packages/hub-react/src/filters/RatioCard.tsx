import type { RatioSettings } from '@chatwarden/core';
import { FILTER_RULE_DEFAULTS, RATIO_DEFAULTS } from '@chatwarden/core';
import { useHub } from '../context.js';
import { ActionChoice, Card, NumField, ProblemLine, RuleField } from './parts.js';
import type { Problem } from './parts.js';

/** Shouting and repeats: capitals, one character repeated, emoji and mentions, each its own check with its own number. */
export function RatioCard({ value, onChange, problem, flagCap }: { value: RatioSettings | null; onChange: (v: RatioSettings | null) => void; problem: Problem | null; flagCap: number }) {
  const { t } = useHub();
  const v = value;
  const set = (patch: Partial<RatioSettings>): void => {
    if (v !== null) onChange({ ...v, ...patch });
  };
  return (
    <Card
      title={t('hub.settings.filters.ratio.title')}
      hint={t('hub.settings.filters.ratio.hint')}
      on={v !== null}
      onToggle={(on) =>
        onChange(
          on
            ? {
                action: 'count',
                rule: FILTER_RULE_DEFAULTS.ratio,
                caps: { ...RATIO_DEFAULTS.caps },
                repeats: { ...RATIO_DEFAULTS.repeats },
                emoji: { ...RATIO_DEFAULTS.emoji },
                mentions: { ...RATIO_DEFAULTS.mentions },
              }
            : null,
        )
      }
    >
      {v !== null && (
        <>
          <ActionChoice
            value={v.action}
            onChange={(action) => set({ action })}
            about={(a) => (a === 'flag' ? t('hub.settings.filters.action.flag.about', { count: flagCap }) : a === 'mask' ? t('hub.settings.filters.action.mask.soften') : t(`hub.settings.filters.action.${a}.about` as never))}
          />
          <RuleField value={v.rule} onChange={(rule) => set({ rule })} />
          <label className="cw-choice">
            <input type="checkbox" checked={v.caps != null} onChange={(e) => set({ caps: e.target.checked ? { ...RATIO_DEFAULTS.caps } : null })} />
            <span>{t('hub.settings.filters.ratio.caps')}</span>
          </label>
          {v.caps != null && (
            <div className="cw-fsub">
              <NumField label={t('hub.settings.filters.ratio.caps.percent')} value={v.caps.maxPercent} onChange={(maxPercent) => set({ caps: { ...v.caps, maxPercent } })} min={50} max={100} />
              <NumField label={t('hub.settings.filters.ratio.caps.letters')} value={v.caps.minLetters} onChange={(minLetters) => set({ caps: { ...v.caps, minLetters } })} min={8} max={200} />
            </div>
          )}
          <label className="cw-choice">
            <input type="checkbox" checked={v.repeats != null} onChange={(e) => set({ repeats: e.target.checked ? { ...RATIO_DEFAULTS.repeats } : null })} />
            <span>{t('hub.settings.filters.ratio.repeats')}</span>
          </label>
          {v.repeats != null && (
            <div className="cw-fsub">
              <NumField label={t('hub.settings.filters.ratio.repeats.run')} value={v.repeats.maxRun} onChange={(maxRun) => set({ repeats: { maxRun } })} min={3} max={50} />
            </div>
          )}
          <label className="cw-choice">
            <input type="checkbox" checked={v.emoji != null} onChange={(e) => set({ emoji: e.target.checked ? { ...RATIO_DEFAULTS.emoji } : null })} />
            <span>{t('hub.settings.filters.ratio.emoji')}</span>
          </label>
          {v.emoji != null && (
            <div className="cw-fsub">
              <NumField label={t('hub.settings.filters.ratio.emoji.max')} value={v.emoji.max} onChange={(max) => set({ emoji: { max } })} min={1} max={50} />
            </div>
          )}
          <label className="cw-choice">
            <input type="checkbox" checked={v.mentions != null} onChange={(e) => set({ mentions: e.target.checked ? { ...RATIO_DEFAULTS.mentions } : null })} />
            <span>{t('hub.settings.filters.ratio.mentions')}</span>
          </label>
          {v.mentions != null && (
            <div className="cw-fsub">
              <NumField label={t('hub.settings.filters.ratio.mentions.max')} value={v.mentions.max} onChange={(max) => set({ mentions: { max } })} min={1} max={20} />
            </div>
          )}
          <ProblemLine problem={problem} card="ratio" />
        </>
      )}
    </Card>
  );
}

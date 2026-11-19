import { useId, useRef, useState } from 'react';
import type { GameKind } from '@chatwarden/core';
import { useHub } from '../context.js';
import { useHubAction } from '../hooks.js';
import { errorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import type { SetupOption } from '../types.js';
import { Notice, Panel } from '../ui.js';
import { ladderSummary } from './summary.js';
import { useSetup } from './setupHooks.js';

// The first-run panel: "What kind of game is this?", at the top of the Overview and of the Simple home, for the owner of a kit nobody has set up yet. One calm card: four plain choices (none
// chosen), a preview of what the choice would set up, "Use these principles" (off until a choice is made) and "Keep the current ones". It draws nothing while it loads, when it failed, for
// anyone but the owner, and once the kit has settings or the panel was dismissed. A lazy part.

const TITLE_OF: Record<GameKind, 'hub.setup.choice.competitive' | 'hub.setup.choice.social' | 'hub.setup.choice.kids' | 'hub.setup.choice.creator'> = {
  competitive: 'hub.setup.choice.competitive',
  social: 'hub.setup.choice.social',
  kids: 'hub.setup.choice.kids',
  creator: 'hub.setup.choice.creator',
};

/** The titles of the principles an option would save (the whole form of the guidelines section; any other shape has none to list). */
const tierTitles = (option: SetupOption): string[] => {
  const g = option.layer.guidelines;
  return g !== undefined && !Array.isArray(g) ? g.tiers.map((t) => t.title) : [];
};

export function FirstRun() {
  const { t, locale, client, session } = useHub();
  const toasts = useToasts();
  const { state, reload } = useSetup();
  const [gone, setGone] = useState(false);
  const [choice, setChoice] = useState<GameKind | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const group = useId();
  const apply = useHubAction(async (game: GameKind, version: number) => {
    const res = await client.applySetup({ game, version });
    // The steps and principles changed: the next decision bar or settings screen reads them again.
    session.invalidatePolicy();
    return res;
  });
  const keep = useHubAction(() => client.dismissSetup());

  if (state === null || gone) return null;
  const option = state.options.find((o) => o.game === choice) ?? null;
  const busy = apply.busy || keep.busy;

  /** The panel is done: it goes, and the focus goes to the title of the screen it sat on (found before the panel leaves). */
  const finish = (): void => {
    const title = root.current?.closest('.cw-screen')?.querySelector<HTMLElement>('.cw-screen-title') ?? null;
    setGone(true);
    queueMicrotask(() => title?.focus());
  };
  const use = async (): Promise<void> => {
    if (option === null || busy) return;
    keep.clearError();
    const res = await apply.run(option.game, state.version);
    if (!res.ok) return;
    toasts.push({ text: t('hub.setup.toast') });
    finish();
  };
  const dismiss = async (): Promise<void> => {
    if (busy) return;
    apply.clearError();
    const res = await keep.run();
    if (res.ok) finish();
  };
  const conflict = apply.error?.code === 'conflict';
  const error = apply.error ?? keep.error;

  return (
    <div ref={root}>
      <Panel title={t('hub.setup.title')} className="cw-setup">
        <div className="cw-form cw-panel-pad">
          <p className="cw-hint">{t('hub.setup.intro')}</p>
          <fieldset className="cw-setup-choices">
            <legend>{t('hub.setup.group')}</legend>
            {state.options.map((o) => (
              <label key={o.game} className="cw-tick">
                <input type="radio" name={group} value={o.game} checked={choice === o.game} onChange={() => setChoice(o.game)} />
                <span>{t(TITLE_OF[o.game])}</span>
              </label>
            ))}
          </fieldset>
          <div className="cw-setup-preview" aria-live="polite">
            {option !== null && (
              <>
                <p className="cw-hint">{t('hub.setup.preview.principles')}</p>
                <ul className="cw-setup-list">
                  {tierTitles(option).map((title, i) => (
                    <li key={i}>{title}</li>
                  ))}
                </ul>
                {(option.layer.teamNotes ?? []).map((n, i) => (
                  <p key={i}>{t('hub.setup.preview.note', { text: n.text })}</p>
                ))}
                <p>{ladderSummary(option, t, locale)}</p>
              </>
            )}
          </div>
          {error !== null && (
            <Notice tone="bad" role="alert">
              {conflict ? (
                <>
                  <span>{t('hub.setup.conflict')}</span>{' '}
                  <button
                    type="button"
                    className="cw-btn"
                    onClick={() => {
                      apply.clearError();
                      reload();
                    }}
                  >
                    {t('hub.setup.reload')}
                  </button>
                </>
              ) : (
                <span>{errorText(t, error)}</span>
              )}
            </Notice>
          )}
          <div className="cw-action-foot">
            <button type="button" className="cw-btn cw-btn--primary" aria-disabled={option === null || busy} aria-busy={apply.busy} onClick={() => void use()}>
              {t('hub.setup.use')}
            </button>
            <button type="button" className="cw-btn" aria-disabled={busy} onClick={() => void dismiss()}>
              {t('hub.setup.keep')}
            </button>
          </div>
          <p className="cw-hint">{t('hub.setup.hint')}</p>
        </div>
      </Panel>
    </div>
  );
}

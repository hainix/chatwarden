import { useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useAiT } from '../ai/i18n.js';
import type { AiT } from '../ai/i18n.js';
import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import { ruleLabel } from '../labels.js';
import { SaveBar } from '../policy/SaveBar.js';
import { useDraftSync } from '../policy/useDraftSync.js';
import { useSaveFlow } from '../policy/useSaveFlow.js';
import { useUnsavedGuard } from '../policy/useUnsavedGuard.js';
import { usePolicy } from '../policyHooks.js';
import type { UsePolicy } from '../policyHooks.js';
import { useToasts } from '../toasts.js';
import type { AiStatusView, PolicyLayer, PolicyState } from '../types.js';
import { ErrorBlock, Fetched, Notice, Panel, Scroll } from '../ui.js';

// Settings > AI. The level (Off, Read, Recommend), a status line, and one Advanced disclosure with the numbers. The level lives in the
// policy layer beside the steps and the reporting section, so it is saved, versioned and audited the same way: a reason is asked for, a
// conflict offers a reload, and only the owner can save. The daily spending limit and the adapter are set in the server's code and are read-only
// here (the ceiling on calls a day is the owner's). Levels 3 and 4 do not exist yet and are not shown.

type Level = 0 | 1 | 2;

const LEVELS: ReadonlyArray<{ level: Level; label: 'hub.settings.ai.level.off' | 'hub.settings.ai.level.read' | 'hub.settings.ai.level.recommend'; hint: 'hub.settings.ai.level.off.hint' | 'hub.settings.ai.level.read.hint' | 'hub.settings.ai.level.recommend.hint' }> = [
  { level: 0, label: 'hub.settings.ai.level.off', hint: 'hub.settings.ai.level.off.hint' },
  { level: 1, label: 'hub.settings.ai.level.read', hint: 'hub.settings.ai.level.read.hint' },
  { level: 2, label: 'hub.settings.ai.level.recommend', hint: 'hub.settings.ai.level.recommend.hint' },
];

interface AiDraft {
  level: Level;
  learn: boolean;
}

/** The AI section as the kit reports it in force. A server from before the AI sends none: Off, learning on. */
const draftOf = (state: PolicyState): AiDraft => {
  const ai = (state.effective as { ai?: { level?: number; learn?: boolean } }).ai;
  return { level: ai?.level === 1 || ai?.level === 2 ? ai.level : 0, learn: ai?.learn !== false };
};

/** The layer to save: everything already saved, and the `ai` section with the level and the learning switch (what else it holds is kept). */
const layerOf = (state: PolicyState, draft: AiDraft): PolicyLayer => ({ ...state.layer, ai: { ...(state.layer.ai ?? {}), level: draft.level, learn: draft.learn } });

const Rate = ({ value, none, locale }: { value: number | null; none: string; locale: string }) => <span>{value === null ? none : new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(value)}</span>;

function StatusLine({ status, notSetUp, t }: { status: AiStatusView | undefined; notSetUp: boolean; t: AiT }) {
  let line: string;
  let hint: string | null = null;
  if (notSetUp) {
    line = t('hub.settings.ai.status.notSetUp');
    hint = t('hub.settings.ai.status.notSetUp.hint');
  } else if (status === undefined) return null;
  else if (status.state === 'paused_budget') line = t('hub.settings.ai.status.paused');
  else if (status.state === 'unavailable') {
    line = t('hub.settings.ai.status.unavailable');
    hint = t('hub.settings.ai.status.unavailable.hint');
  } else line = t(status.state === 'off' ? 'hub.settings.ai.status.off' : 'hub.settings.ai.status.working');
  return (
    <div className="cw-ai-status" role="status">
      <span className="cw-hint">{t('hub.settings.ai.status.label')}</span>
      <strong>{line}</strong>
      {hint !== null && <span className="cw-hint">{hint}</span>}
    </div>
  );
}

function Numbers({ status, draft, editable, onLearn, t }: { status: AiStatusView | undefined; draft: AiDraft; editable: boolean; onLearn: (on: boolean) => void; t: AiT }) {
  const { locale, t: hubT } = useHub();
  const id = useId();
  const money = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' });
  const none = t('hub.settings.ai.rate.none');
  const stats = status?.stats;
  return (
    <div className="cw-ai-numbers cw-panel-pad" id={`${id}-numbers`}>
      <label className="cw-choice cw-flowopt">
        <input type="checkbox" checked={draft.learn} disabled={!editable} aria-labelledby={`${id}-learn-t`} aria-describedby={`${id}-learn`} onChange={(e) => onLearn(e.target.checked)} />
        <span>
          <strong id={`${id}-learn-t`}>{t('hub.settings.ai.learn')}</strong>
          <span id={`${id}-learn`} className="cw-hint cw-flowopt-line">
            {t('hub.settings.ai.learn.hint')}
          </span>
        </span>
      </label>
      {status !== undefined && status.available && (
        <ul className="cw-ai-facts-list">
          <li>{t('hub.settings.ai.reads', { count: status.reads, max: status.capCalls })}</li>
          <li>{t('hub.settings.ai.spend', { spent: money.format(status.spentMicros / 1_000_000), cap: money.format(status.capMicros / 1_000_000) })}</li>
          <li>
            <span>{t('hub.settings.ai.cache')}</span>: <Rate value={status.cacheHitRate} none={t('hub.settings.ai.cache.none')} locale={locale} />
          </li>
        </ul>
      )}
      {stats !== undefined && (
        <>
          <ul className="cw-ai-facts-list">
            <li>
              <span>{t('hub.settings.ai.agreement')}</span>: <Rate value={stats.agreementRate} none={none} locale={locale} />
            </li>
            <li>
              <span>{t('hub.settings.ai.oneClick')}</span>: <Rate value={stats.oneClickRate} none={none} locale={locale} />
            </li>
          </ul>
          <h3>{t('hub.settings.ai.rules')}</h3>
          {stats.rules.length === 0 ? (
            <p className="cw-hint">{t('hub.settings.ai.rules.none')}</p>
          ) : (
            <Scroll label={t('hub.settings.ai.rules')}>
              <table className="cw-table" aria-label={t('hub.settings.ai.rules')}>
                <thead>
                  <tr>
                    <th scope="col">{t('hub.settings.ai.col.rule')}</th>
                    <th scope="col">{t('hub.settings.ai.col.decided')}</th>
                    <th scope="col">{t('hub.settings.ai.col.agree')}</th>
                    <th scope="col">{t('hub.settings.ai.col.override')}</th>
                    <th scope="col">{t('hub.settings.ai.col.falsePositives')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.rules.map((r) => (
                    <tr key={String(r.rule)}>
                      <th scope="row">{ruleLabel(hubT, r.rule)}</th>
                      <td>{r.decided}</td>
                      <td>{r.agree}</td>
                      <td>{r.override}</td>
                      <td>{r.falsePositives}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Scroll>
          )}
          <p className="cw-hint">{t('hub.settings.ai.rules.appeals')}</p>
        </>
      )}
      <p className="cw-hint">{t('hub.settings.ai.readonly')}</p>
    </div>
  );
}

function Editor({ state, policy }: { state: PolicyState; policy: UsePolicy }) {
  const t = useAiT();
  const { client, t: hubT } = useHub();
  const toasts = useToasts();
  const base = useId();
  const status = useHubData<AiStatusView | null>('ai:status', () => client.aiStatus());
  const [draft, setDraftState] = useState<AiDraft>(() => draftOf(state));
  const [advanced, setAdvanced] = useState(false);

  const pending = useDraftSync(state, policy, {
    all: (next) => setDraftState(draftOf(next)),
    sections: (sections, next) => {
      if (sections.includes('ai')) setDraftState(draftOf(next));
    },
  });

  // "Not set up": the kit says it has no adapter, or an older kit has no AI routes at all.
  const notSetUp = (status.data !== undefined && status.data !== null && !status.data.available) || status.error?.status === 404;
  const readStatus = status.data ?? undefined;
  const editable = policy.canEdit && !notSetUp;
  const maxLevel = readStatus?.available === true ? readStatus.maxLevel : 2;

  const layer = useMemo(() => layerOf(state, draft), [state, draft]);
  const saved = draftOf(state);
  const isDirty = draft.level !== saved.level || draft.learn !== saved.learn;

  const save = useSaveFlow({
    policy,
    layer,
    dirty: isDirty,
    editable,
    pending,
    fieldOf: () => null,
    onBlocked: () => undefined,
    onSaved: () => {
      toasts.push({ text: t('hub.settings.ai.saved') });
      status.reload();
    },
    onRefused: () => undefined,
  });
  const discard = (): void => {
    setDraftState(draftOf(state));
    save.close();
  };
  const reload = (): void => {
    pending.current = 'all';
    save.close();
    policy.reload();
  };
  const guard = useUnsavedGuard(isDirty);

  let statusBody: ReactNode;
  if (status.data === undefined && status.error === null) statusBody = <p role="status">{hubT('hub.state.loading')}</p>;
  else if (status.error !== null && status.error.status !== 404) statusBody = <ErrorBlock error={status.error} what={t('hub.settings.ai.what')} onRetry={status.reload} />;
  else statusBody = <StatusLine status={readStatus} notSetUp={notSetUp} t={t} />;

  return (
    <div className="cw-settings">
      {state.layerError !== undefined && <Notice tone="warn">{hubT('hub.settings.layerError')}</Notice>}
      {!state.canSave ? <Notice role="status">{t('hub.settings.ai.unsupported')}</Notice> : !policy.canEdit && <Notice role="status">{hubT('hub.settings.readOnly')}</Notice>}
      {statusBody}
      <Panel title={t('hub.settings.ai.level.legend')}>
        <div className="cw-form cw-panel-pad">
          <fieldset className="cw-flowopts" role="radiogroup" disabled={!editable}>
            <legend className="cw-sr">{t('hub.settings.ai.level.legend')}</legend>
            {LEVELS.map(({ level, label, hint }) => (
              <label key={level} className="cw-choice cw-flowopt">
                <input
                  type="radio"
                  name={`${base}-level`}
                  checked={draft.level === level}
                  disabled={level > maxLevel}
                  aria-labelledby={`${base}-level-${level}-t`}
                  aria-describedby={`${base}-level-${level}-hint`}
                  onChange={() => setDraftState((d) => ({ ...d, level }))}
                />
                <span>
                  <strong id={`${base}-level-${level}-t`}>{t(label)}</strong>
                  <span id={`${base}-level-${level}-hint`} className="cw-hint cw-flowopt-line">
                    {t(hint)}
                  </span>
                  {level > maxLevel && <span className="cw-hint cw-flowopt-line">{t('hub.settings.ai.level.max', { level: t(LEVELS[maxLevel]?.label ?? 'hub.settings.ai.level.off') })}</span>}
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </Panel>
      <div className="cw-ai-advanced">
        <button type="button" className="cw-btn" aria-expanded={advanced} aria-controls={`${base}-advanced`} onClick={() => setAdvanced(!advanced)}>
          {t('hub.settings.ai.advanced')}
        </button>
        {advanced && (
          <div id={`${base}-advanced`}>
            <Numbers status={readStatus} draft={draft} editable={editable} onLearn={(learn) => setDraftState((d) => ({ ...d, learn }))} t={t} />
          </div>
        )}
      </div>
      {editable && <SaveBar policy={policy} save={save} isDirty={isDirty} dirtyCount={1} refusedField={false} idBase={base} onDiscard={discard} onReload={reload} />}
      {guard}
    </div>
  );
}

/** The AI screen: the level, the status and, behind Advanced, the numbers. */
export function AiSettingsScreen() {
  const t = useAiT();
  const { t: hubT } = useHub();
  const policy = usePolicy();
  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.settings.ai.title')}
        </h2>
      </div>
      <p className="cw-hint">{t('hub.settings.ai.intro')}</p>
      <Fetched state={{ data: policy.data, error: policy.error, loading: policy.loading, reload: policy.reload }} what={hubT('hub.state.what.settings')}>
        {(state) => <Editor state={state} policy={policy} />}
      </Fetched>
    </div>
  );
}

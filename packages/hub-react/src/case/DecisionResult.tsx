import type { ReactNode, Ref } from 'react';
import { useHub } from '../context.js';
import type { DecisionState } from '../decisions.js';
import { kindLabel } from '../labels.js';

type Done = Extract<DecisionState, { status: 'done' }>;

/** What a decision came to: closed, whether it was already on record, and the reference code of each action. `children` is the way on. */
export function DecisionResult({ state, innerRef, children }: { state: Done; innerRef?: Ref<HTMLDivElement>; children?: ReactNode }) {
  const { t } = useHub();
  return (
    <div className="cw-result" tabIndex={-1} ref={innerRef}>
      <p>
        <strong>{t('hub.decide.result.done')}</strong>
      </p>
      {state.replay && <p>{t('hub.decide.result.replay')}</p>}
      {state.groups.length === 0 ? (
        <p className="cw-hint">{t('hub.decide.result.none')}</p>
      ) : (
        <ul aria-label={t('hub.decide.result.codes')}>
          {state.groups.map((g) => (
            <li key={g.refCode}>
              <span className="cw-pid">{t('hub.decide.result.code', { code: g.refCode, kind: kindLabel(t, g.kind) })}</span>
            </li>
          ))}
        </ul>
      )}
      {children}
    </div>
  );
}

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Field } from '../case/ActionEditor.js';
import { actorName } from '../claims.js';
import { toHubError } from '../client.js';
import type { HubError } from '../client.js';
import { useHub } from '../context.js';
import type { Problem } from '../decision.js';
import { useHubData } from '../hooks.js';
import { errorText } from '../labels.js';
import { useToasts } from '../toasts.js';
import type { GapRow, PolicyDocs } from '../types.js';
import { Empty, Fetched, Notice, Panel, Tag, Time } from '../ui.js';

/**
 * Closing a gap: one choice, "Made it rule N" for each rule in force or "Not a rule". The rules come from the session (read once,
 * audited as one `policy.view`) only when a form is opened. A rule the server refuses (retired meanwhile) is a field error; a gap
 * someone else closed first reloads the list; a network failure keeps the choice and offers Try again; a double click sends once.
 */
function CloseGap({ gap, onDone, onCancel, onGone }: { gap: GapRow; onDone: () => void; onCancel: () => void; onGone: () => void }) {
  const { t, client, can, session } = useHub();
  const toasts = useToasts();
  const id = useId();
  const [choice, setChoice] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<HubError | null>(null);
  const [badRule, setBadRule] = useState(false);
  const [busy, setBusy] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);
  const sending = useRef(false);
  const wantsRules = can('policy.read');
  const policy = useHubData<PolicyDocs | null>(wantsRules ? 'policy' : 'policy:idle', () => (wantsRules ? session.policy() : Promise.resolve(null)));
  const rules = useMemo(
    () => (policy.data?.rules ?? []).filter((r) => r.retired !== true).sort((a, b) => a.number - b.number),
    [policy.data],
  );
  const rulesFailed = !wantsRules || policy.error !== null;

  useEffect(() => {
    selectRef.current?.focus();
  }, []);

  const problem: Problem | undefined = badRule ? { key: 'hub.gaps.error.rule' } : attempted && choice === '' ? { key: 'hub.gaps.error.choose' } : undefined;

  const submit = async (): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    setBadRule(false);
    if (choice === '') {
      selectRef.current?.focus();
      return;
    }
    sending.current = true;
    setBusy(true);
    setError(null);
    try {
      await client.closeGap(gap.groupId, choice === 'none' ? { status: 'not_a_rule' } : { status: 'ruled', ref: Number(choice.slice('rule:'.length)) });
      toasts.push({ text: t('hub.gaps.toast') });
      onDone();
    } catch (e) {
      const err = toHubError(e);
      if (err.status === 404) {
        toasts.push({ text: t('hub.gaps.gone') });
        onGone();
      } else if (err.status === 400 && err.code === 'invalid_gap_ref') {
        setBadRule(true);
        selectRef.current?.focus();
      } else {
        setError(err);
      }
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  const retryable = error !== null && (error.code === 'network' || error.status >= 500 || error.status === 429);

  return (
    <form
      className="cw-form cw-gap-form"
      aria-label={t('hub.gaps.form', { code: gap.refCode })}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {rulesFailed && policy.loading === false && <Notice tone="warn">{t('hub.gaps.rulesFailed')}</Notice>}
      <Field id={`${id}-how`} label={t('hub.gaps.field')} problem={problem}>
        {(a) => (
          <select {...a} ref={selectRef} value={choice} onChange={(e) => { setChoice(e.target.value); setBadRule(false); }}>
            <option value="">{t('hub.gaps.choose')}</option>
            {rules.map((r) => (
              <option key={r.number} value={`rule:${r.number}`}>
                {t('hub.gaps.option.rule', { number: r.number, title: r.title })}
              </option>
            ))}
            <option value="none">{t('hub.gaps.option.none')}</option>
          </select>
        )}
      </Field>
      {error !== null && (
        <div className="cw-error" role="alert">
          <p>{errorText(t, error)}</p>
          {retryable && (
            <button type="button" className="cw-btn" onClick={() => void submit()}>
              {t('hub.state.retry')}
            </button>
          )}
        </div>
      )}
      <div className="cw-action-foot">
        <button type="submit" className="cw-btn cw-btn--primary" aria-disabled={busy} aria-busy={busy}>
          {t('hub.gaps.submit')}
        </button>
        <button type="button" className="cw-btn" onClick={onCancel}>
          {t('hub.gaps.cancel')}
        </button>
      </div>
    </form>
  );
}

/** One gap: its ref code (what a moderator quotes), who filed it and when, and the private note on what the rules did not cover. */
function GapItem({ gap, children }: { gap: GapRow; children?: ReactNode }) {
  const { t } = useHub();
  return (
    <li className="cw-gap">
      <div className="cw-gap-head">
        <strong>{t('hub.gaps.ref', { code: gap.refCode })}</strong>
        {gap.status !== 'open' && <Tag>{t(gap.status === 'ruled' ? 'hub.gaps.status.ruled' : 'hub.gaps.status.not_a_rule')}</Tag>}
        <span className="cw-facts">
          <span>{t('hub.gaps.filed', { name: actorName(gap.actor) })}</span>
          <Time at={gap.at} />
        </span>
      </div>
      <p className="cw-gap-note">{gap.note}</p>
      {children}
    </li>
  );
}

/** Where the rules fell short: every sanction filed as "No rule covers this", for the rules review. An owner closes them. */
export function Gaps() {
  const { client, t, can } = useHub();
  const state = useHubData('gaps', () => client.listGaps());
  const [form, setForm] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const canClose = can('gaps.close');
  // After a form is cancelled, its Close button is mounted again: keyboard focus goes back to it once it is there.
  const [focusBack, setFocusBack] = useState<string | null>(null);
  useEffect(() => {
    if (focusBack === null) return;
    buttons.current.get(focusBack)?.focus();
    setFocusBack(null);
  }, [focusBack, form]);

  return (
    <div className="cw-screen">
      <div className="cw-bar">
        <h2 className="cw-screen-title" tabIndex={-1} ref={titleRef}>
          {t('hub.gaps.title')}
        </h2>
      </div>
      {!canClose && <p className="cw-hint">{t('hub.gaps.ownerOnly')}</p>}
      <Fetched state={state} what={t('hub.state.what.gaps')}>
        {({ items }) => {
          const open = items.filter((g) => g.status === 'open');
          const closed = items.filter((g) => g.status !== 'open');
          const done = (): void => {
            setForm(null);
            state.reload();
            queueMicrotask(() => titleRef.current?.focus());
          };
          return (
            <>
              <Panel title={t('hub.gaps.open')}>
                {open.length === 0 ? (
                  <Empty>{t('hub.gaps.open.none')}</Empty>
                ) : (
                  <ul className="cw-gaps" aria-label={t('hub.gaps.openList')}>
                    {open.map((g) => (
                      <GapItem key={g.groupId} gap={g}>
                        {canClose &&
                          (form === g.groupId ? (
                            <CloseGap
                              gap={g}
                              onDone={done}
                              onGone={done}
                              onCancel={() => {
                                setForm(null);
                                setFocusBack(g.groupId);
                              }}
                            />
                          ) : (
                            <div className="cw-action-foot">
                              <button
                                type="button"
                                className="cw-btn"
                                aria-label={t('hub.gaps.close.label', { code: g.refCode })}
                                ref={(el) => {
                                  if (el === null) buttons.current.delete(g.groupId);
                                  else buttons.current.set(g.groupId, el);
                                }}
                                onClick={() => setForm(g.groupId)}
                              >
                                {t('hub.gaps.close')}
                              </button>
                            </div>
                          ))}
                      </GapItem>
                    ))}
                  </ul>
                )}
              </Panel>
              <Panel title={t('hub.gaps.closed')}>
                {closed.length === 0 ? (
                  <Empty>{t('hub.gaps.closed.none')}</Empty>
                ) : (
                  <ul className="cw-gaps" aria-label={t('hub.gaps.closedList')}>
                    {closed.map((g) => (
                      <GapItem key={g.groupId} gap={g} />
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          );
        }}
      </Fetched>
    </div>
  );
}

import { useContext, useId, useMemo, useRef, useState } from 'react';
import { actorName } from '../claims.js';
import { useHub } from '../context.js';
import { REASON_MAX } from '../decision.js';
import type { Problem } from '../decision.js';
import { appealErrorText, groupName, kindLabel, lengthPhrase, ruleLabel, sanctionWhat } from '../labels.js';
import { useHubAction, useHubData } from '../hooks.js';
import { useOptionalQueue } from '../liveQueue.js';
import { useMode } from '../mode.js';
import { LocalReveal, NameRevealContext, NameToggle, NameValue } from '../names.js';
import { lengthValue } from '../policy/length.js';
import { LEGACY_LENGTHS, lengthsOf } from '../policy/lengths.js';
import { recordLine } from '../simple.js';
import { useToasts } from '../toasts.js';
import { lighterKinds, lighterLengths } from '../appeals/lighter.js';
import type { LighterKind } from '../appeals/lighter.js';
import type { AppealDecisionInput, AppealDetail, PersonHistory, PolicyDocs, Reason } from '../types.js';
import { Card, Fetched, Link, Masked, Notice, PersonChip, Tag, Time } from '../ui.js';
import { Field } from './ActionEditor.js';
import { ReasonChips } from './DecisionBar.js';

// One appeal, in the case pane (appeals, design 4.9): what was given and why it was contested, in the player's own words (plain text, hidden when it trips the
// term filter), what they were shown, and three ways to rule on it with a private reason. An appeal is decided by one write, so there is no claim and no Undo
// hold: a second moderator is told "someone else has already decided this". A reduction is reversible by hand from the Person page.

const STATEMENT = 'statement';

/** The appeal screen: the card, with the page's own reveal state (nothing is shown at first, and a new appeal starts hidden). */
export function AppealScreen({ id }: { id: string }) {
  return (
    <LocalReveal>
      <AppealCard id={id} />
    </LocalReveal>
  );
}

function AppealCard({ id }: { id: string }) {
  const { t, client } = useHub();
  const detail = useHubData(`appeal:${id}`, () => client.appeal(id));
  return (
    <div className="cw-screen cw-appeal">
      {detail.data === undefined && (
        <h2 className="cw-screen-title" tabIndex={-1}>
          {t('hub.appeals.screen.title')}
        </h2>
      )}
      <Fetched state={detail} what={t('hub.state.what.appeal')}>
        {({ appeal }) => <Body appeal={appeal} />}
      </Fetched>
    </div>
  );
}

function Body({ appeal }: { appeal: AppealDetail }) {
  const { t, locale, can, session, client } = useHub();
  const simple = useMode().mode === 'simple';
  const base = useId();
  const sanction = appeal.sanction;
  const open = appeal.status === 'open';
  const mayDecide = can('appeals.decide');
  const what = sanctionWhat(t, locale, sanction);

  // Their record: in Simple one read of their history gives the one line (and the name to show). Detailed reads nothing for the header: the appeal carries no name,
  // and a name is not worth an audited `history.view` row, so it has the tag and the link to the record. Without `history.read` it is the tag alone.
  const wantsHistory = can('history.read');
  const readsHistory = wantsHistory && simple;
  const history = useHubData<PersonHistory | null>(readsHistory ? `appeal-history:${appeal.person}` : 'appeal-history:idle', () =>
    readsHistory ? client.personHistory(appeal.person, { limit: 1 }) : Promise.resolve(null),
  );
  const handle = history.data?.handle ?? null;
  const nameFlagged = history.data?.handleFlagged === true;
  const wantsReasons = open && mayDecide && can('reasons.read');
  const reasons = useHubData<Reason[] | null>(wantsReasons ? 'reasons' : 'reasons:idle', () => (wantsReasons ? session.reasons() : Promise.resolve(null)));
  // The lengths are the profile's; a role that cannot read the settings is offered the four lengths the forms always had (the server is the judge).
  const wantsPolicy = open && mayDecide && can('policy.read');
  const policy = useHubData<PolicyDocs | null>(wantsPolicy ? 'policy' : 'policy:idle', () => (wantsPolicy ? session.policy() : Promise.resolve(null)));
  const offered = useMemo(() => (lengthsOf(policy.data?.profile) ?? LEGACY_LENGTHS).durations, [policy.data]);

  return (
    <>
      <header className="cw-appeal-head">
        <Card kind={sanction.kind} />
        <div className="cw-appeal-title">
          <h2 className="cw-screen-title" tabIndex={-1}>
            {t('hub.appeals.card.title', { what })}
          </h2>
          <p className="cw-facts">
            {simple && (
              <span className="cw-appeal-who">
                <NameValue text={groupName(t, { handle, person: appeal.person }, true)} flagged={nameFlagged} place="head" />
                {nameFlagged && ' '}
                <NameToggle flagged={nameFlagged} place="head" />
              </span>
            )}
            <PersonChip person={appeal.person} />
            <Tag>{ruleLabel(t, sanction.rule)}</Tag>
            <Time at={sanction.startsAt} />
            {!simple && (sanction.automated ? <span>{t('hub.sanction.automatic')}</span> : sanction.decidedBy !== '' && <span>{t('hub.sanction.by', { actor: sanction.decidedBy })}</span>)}
          </p>
        </div>
      </header>

      <Statement appeal={appeal} nameFlagged={nameFlagged} />

      <section className="cw-appeal-shown" aria-labelledby={`${base}-shown`}>
        <h3 id={`${base}-shown`}>{t('hub.appeals.shown.title')}</h3>
        {appeal.shown.length === 0 ? (
          <p className="cw-hint">{t('hub.appeals.shown.none')}</p>
        ) : (
          <ul aria-label={t('hub.appeals.shown.label')}>
            {appeal.shown.map((l, i) => (
              <li key={i}>
                <span className="cw-hint">{l.day}</span> <span className="cw-appeal-line">{l.text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {simple ? (
        wantsHistory && (
          <section className="cw-scard-record" aria-labelledby={`${base}-record`}>
            <h3 id={`${base}-record`}>{t('hub.appeals.card.record')}</h3>
            <Fetched state={history} what={t('hub.state.what.record')}>
              {(h) => <p>{recordLine(t, locale, h === null ? [] : h.sanctions)}</p>}
            </Fetched>
          </section>
        )
      ) : (
        <p className="cw-facts">
          {wantsHistory && (
            <Link to={{ name: 'person', ref: appeal.person }} className="cw-link" omit>
              {t('hub.appeals.card.person.open')}
            </Link>
          )}
          {can('reports.read') && appeal.reportId !== null && (
            <Link to={{ name: 'report', id: appeal.reportId }} className="cw-link" omit>
              {t('hub.appeals.card.report.open')}
            </Link>
          )}
        </p>
      )}

      {!open && <Outcome appeal={appeal} />}
      {open && !mayDecide && <Notice role="status">{t('hub.appeals.decide.seniorOnly')}</Notice>}
      {open && mayDecide && <Decision appeal={appeal} reasons={reasons.data ?? []} offered={offered} />}
    </>
  );
}

/** The player's words: plain text in a block of its own, never HTML or markdown; hidden while the filter flags it, shown for this statement or for the whole page. */
function Statement({ appeal, nameFlagged }: { appeal: AppealDetail; nameFlagged: boolean }) {
  const { t } = useHub();
  const id = useId();
  const reveal = useContext(NameRevealContext);
  const flagged = appeal.statementFlagged;
  const all = reveal?.all === true;
  const shown = !flagged || all || reveal?.shows(STATEMENT) === true;
  return (
    <section className="cw-appeal-said" aria-labelledby={id}>
      <h3 id={id}>{t('hub.appeals.statement.title')}</h3>
      {appeal.statement === null ? (
        <p className="cw-hint">{t('hub.appeals.statement.purged')}</p>
      ) : (
        <p className="cw-appeal-statement">{shown ? appeal.statement : <Masked />}</p>
      )}
      <div className="cw-appeal-reveal">
        {flagged && !all && reveal !== null && appeal.statement !== null && (
          <button type="button" className="cw-linkbtn" aria-pressed={shown} aria-label={t(shown ? 'hub.mask.hideStatement' : 'hub.mask.showStatement')} onClick={() => reveal.toggle(STATEMENT)}>
            {t(shown ? 'hub.mask.hide' : 'hub.mask.show')}
          </button>
        )}
        {(flagged || nameFlagged) && reveal?.setAll !== undefined && (
          <label className="cw-check cw-tr-reveal">
            <input type="checkbox" checked={all} onChange={(e) => reveal.setAll?.(e.target.checked)} />
            <span>{t(nameFlagged ? 'hub.mask.allNames' : 'hub.mask.all')}</span>
          </label>
        )}
      </div>
    </section>
  );
}

/** A decided appeal: what was ruled, by whom, and the private reason (staff only). */
function Outcome({ appeal }: { appeal: AppealDetail }) {
  const { t } = useHub();
  const d = appeal.decided;
  return (
    <section className="cw-appeal-outcome">
      <Notice role="status">
        <p>
          <strong>{t(`hub.appeals.decided.${appeal.status as 'upheld' | 'reduced' | 'revoked' | 'moot'}`)}</strong>
          {d !== null && d.by !== '' && ` ${t('hub.appeals.decided.by', { actor: actorName(d.by) })}`}
        </p>
        {d !== null && d.reason !== '' && <p className="cw-appeal-reason">{d.reason}</p>}
      </Notice>
    </section>
  );
}

const reasonProblem = (reason: string): Problem | undefined => {
  const trimmed = reason.trim();
  if (trimmed === '') return { key: 'hub.decide.error.reasonRequired' };
  return trimmed.length > REASON_MAX ? { key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } } : undefined;
};

/** The three ways to rule, with the one private reason they share. Each is sent at once: there is no hold. */
function Decision({ appeal, reasons, offered }: { appeal: AppealDetail; reasons: readonly Reason[]; offered: readonly number[] }) {
  const { t, locale, client, go } = useHub();
  const toasts = useToasts();
  const queue = useOptionalQueue();
  const base = useId();
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [picking, setPicking] = useState(false);
  const [kind, setKind] = useState<LighterKind | null>(null);
  const [length, setLength] = useState<string | null>(null);
  // The appeal is closed (someone else decided it, or the sanction is gone): nothing is left to send, so the controls go and the words stay with a way back.
  const [settled, setSettled] = useState(false);
  const reasonBox = useRef<HTMLTextAreaElement>(null);
  const sending = useRef(false);
  const action = useHubAction((input: AppealDecisionInput) => client.decideAppeal(appeal.id, input));

  const given = useMemo(
    () => ({ kind: appeal.sanction.kind, length: appeal.sanction.kind === 'warning' || appeal.sanction.endsAt === null ? null : appeal.sanction.endsAt - appeal.sanction.startsAt }),
    [appeal.sanction],
  );
  const kinds = useMemo(() => lighterKinds(given, offered), [given, offered]);
  // Until one is chosen the picker starts on the kind nearest the original, with its longest length.
  const chosenKind: LighterKind | null = kind !== null && kinds.includes(kind) ? kind : (kinds[kinds.length - 1] ?? null);
  const lengths = chosenKind === null ? [] : lighterLengths(chosenKind, given, offered);
  const chosenLength = lengths.some((ms) => lengthValue(ms) === length) ? length : lengths.length === 0 ? null : lengthValue(lengths[lengths.length - 1] ?? null);
  const problem = attempted ? reasonProblem(reason) : undefined;

  const send = async (input: Omit<AppealDecisionInput, 'reason'>): Promise<void> => {
    if (sending.current) return;
    setAttempted(true);
    if (reasonProblem(reason) !== undefined) {
      reasonBox.current?.focus();
      return;
    }
    sending.current = true;
    const result = await action.run({ ...input, reason: reason.trim() }).finally(() => {
      sending.current = false;
    });
    if (!result.ok) {
      if (result.error.code === 'already_decided' || result.error.code === 'gone') {
        setSettled(true);
        setPicking(false);
        if (queue !== null) void queue.reload();
      }
      return;
    }
    toasts.push({ text: t(`hub.appeals.toast.${result.value.status}`) });
    // The queue reads again, so the list and the number drop the appeal at once; the moderator goes back to the list.
    if (queue !== null) void queue.reload();
    go({ name: 'appeals' });
  };

  const confirmLighter = (): void => {
    if (chosenKind === null) return;
    const ms = chosenKind === 'warning' ? null : (lengths.find((l) => lengthValue(l) === chosenLength) ?? null);
    void send({ outcome: 'reduce', to: { kind: chosenKind, durationMs: ms } });
  };

  const failed = action.error;
  return (
    <section className="cw-appeal-decision" aria-label={t('hub.appeals.decide.title')}>
      {!settled && <ReasonChips reasons={reasons} onPick={(r) => setReason((v) => (v.trim() === '' ? r.text : `${v.trimEnd()} ${r.text}`))} />}
      <Field
        id={`${base}-reason`}
        label={t('hub.appeals.reason.label')}
        hint={t('hub.appeals.reason.hint')}
        counter={t('hub.decide.counter', { count: reason.trim().length, max: REASON_MAX })}
        problem={problem}
      >
        {(a) => <textarea {...a} ref={reasonBox} rows={3} value={reason} readOnly={settled} onChange={(e) => setReason(e.target.value)} />}
      </Field>
      {failed !== null && (
        <div className="cw-error" role="alert">
          <p>{appealErrorText(t, failed)}</p>
        </div>
      )}
      {settled ? (
        <div className="cw-appeal-controls">
          <button type="button" className="cw-btn" onClick={() => go({ name: 'appeals' })}>
            {t('hub.appeals.back')}
          </button>
        </div>
      ) : (
        <div className="cw-appeal-controls">
          <button type="button" className="cw-btn cw-btn--primary" aria-disabled={action.busy} onClick={() => void send({ outcome: 'uphold' })}>
            {t('hub.appeals.decide.keep')}
          </button>
          <button type="button" className="cw-btn" aria-expanded={picking} aria-controls={`${base}-pick`} disabled={kinds.length === 0} onClick={() => setPicking((v) => !v)}>
            {t('hub.appeals.decide.lighter')}
          </button>
          <button type="button" className="cw-btn" aria-disabled={action.busy} onClick={() => void send({ outcome: 'revoke' })}>
            {t('hub.appeals.decide.remove')}
          </button>
        </div>
      )}
      {!settled && appeal.sanction.kind === 'warning' && <p className="cw-hint">{t('hub.appeals.decide.warning')}</p>}
      {!settled && picking && chosenKind !== null && (
        <fieldset id={`${base}-pick`} className="cw-appeal-pick">
          <legend>{t('hub.appeals.pick.title')}</legend>
          <div className="cw-field">
            <label htmlFor={`${base}-kind`}>{t('hub.appeals.pick.kind')}</label>
            <select id={`${base}-kind`} value={chosenKind} onChange={(e) => setKind(e.target.value as LighterKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {kindLabel(t, k)}
                </option>
              ))}
            </select>
          </div>
          {chosenKind !== 'warning' && (
            <div className="cw-field">
              <label htmlFor={`${base}-length`}>{t('hub.appeals.pick.length')}</label>
              <select id={`${base}-length`} value={chosenLength ?? ''} onChange={(e) => setLength(e.target.value)}>
                {lengths.map((ms) => (
                  <option key={lengthValue(ms)} value={lengthValue(ms)}>
                    {ms === null ? t('hub.decide.length.permanent') : lengthPhrase(t, locale, ms)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <button type="button" className="cw-btn cw-btn--primary" aria-disabled={action.busy} onClick={confirmLighter}>
            {t('hub.appeals.pick.confirm')}
          </button>
        </fieldset>
      )}
    </section>
  );
}

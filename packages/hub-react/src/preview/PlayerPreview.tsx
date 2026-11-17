import { useId } from 'react';
import type { ReactNode } from 'react';
import { NOTICE_WORDS, noticeView, timeLeft, untilText } from '@chatwarden/core/notice-copy';
import type { EffectCode, NoticeOp, NoticePlan, NoticeView } from '@chatwarden/core/notice-copy';
import type { PlayerNotice } from '@chatwarden/core';
import { useHub } from '../context.js';
import { listOf } from '../format.js';
import { Card } from '../ui.js';
import type { SanctionKind } from '../types.js';
import { effectPerson, effectText } from './effects.js';
import { useAnnouncement, usePlan } from './usePreview.js';

// "What the player sees" (design 4): one quiet panel inside an action. It answers three questions in order: does the player get a notice (the notice as they will
// read it, drawn from core's `noticeView`, or one plain line saying none is sent), who else is told, and what else changes for them. It is a pure picture of the
// form's current choice: nothing in it takes focus (the buttons are drawn as text), the notice block says `lang="en"`, and no moderator-only field is an input.

/** What the panel is given. `op` is null while nothing is chosen. */
export interface PlayerPreviewProps {
  op: NoticeOp | null;
  /** How a recipient is named: their display name (the hidden label while the server flags it). The recipient `'player'` stands for the person the form is about. */
  nameOf: (to: string) => string;
  /** The person who reported: their notice reads "{name}, who reported, sees". */
  reporter?: string;
  /** Sentences the form adds to the effects, already in words (the IP line). */
  extraEffects?: readonly string[];
  /** What to say while `op` is null: choosing something (default), or choosing a rule first. */
  prompt?: 'choose' | 'chooseRule';
  /** Where the polite sentence goes. Without it the panel keeps a polite region of its own. */
  announce?: (sentence: string) => void;
}

/** A template with its `{name}` values filled in. */
const fill = (template: string, values: Record<string, string>): string => template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => (Object.hasOwn(values, name) ? (values[name] as string) : whole));

/** A sanction kind a card is drawn for; any other kind of notice has no card. */
const CARDED: readonly string[] = ['warning', 'chat', 'area', 'ban'];

function NoticeBlock({ notice, view, appeals }: { notice: PlayerNotice; view: NoticeView; appeals: boolean }) {
  const { t } = useHub();
  const button = (label: string) => <span className="cw-pv-btn">{t('hub.preview.button', { label })}</span>;
  return (
    <div className="cw-pv-notice" lang="en">
      <div className="cw-pv-head">
        {CARDED.includes(notice.kind) && <Card kind={notice.kind as SanctionKind} />}
        <h4 className="cw-pv-title">{view.title}</h4>
      </div>
      <p className="cw-pv-body">{view.body}</p>
      {view.facts.length > 0 && (
        <dl className="cw-pv-facts">
          {view.facts.map((f) => (
            <div key={f.id} className="cw-pv-fact">
              <dt>{f.term}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {view.refHint !== null && <p className="cw-pv-hint">{view.refHint}</p>}
      {view.linesLabel !== null && (
        <>
          <p className="cw-pv-lines-label">{view.linesLabel}</p>
          <ul className="cw-pv-lines">
            {view.lines.map((l, i) => (
              <li key={i}>
                <span className="cw-pv-line-day">{l.day}</span> <span className="cw-pv-line-text">{l.text}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {view.sanction && appeals && <p className="cw-pv-appeal">{button(NOTICE_WORDS['player.notice.appeal'])}</p>}
      {view.todo !== null && <p className="cw-pv-hint">{view.todo}</p>}
      <p className="cw-pv-actions">{button(view.button)}</p>
    </div>
  );
}

/** The sentence a screen reader hears after a change. It names what the player is sent, never anything the moderator typed. */
function sentenceOf(plan: NoticePlan | null, views: NoticeView[], t: ReturnType<typeof useHub>['t'], locale: string): string {
  if (plan === null) return t('hub.preview.announce.idle');
  if (views.length === 0) return t('hub.preview.announce.nothing');
  return t('hub.preview.announce.sent', { what: listOf(views.map((v) => v.title), locale) });
}

export function PlayerPreview({ op, nameOf, reporter, extraEffects = [], prompt = 'choose', announce }: PlayerPreviewProps) {
  const { t, locale } = useHub();
  const titleId = useId();
  const { plan, ctx } = usePlan(op);
  const appeals = ctx.appeals;
  const now = ctx.now;
  const views = plan === null ? [] : plan.notices.map((n) => ({ to: n.to, notice: n.notice, view: noticeView(n.notice, { words: NOTICE_WORDS, locale: 'en', now }) }));
  const said = useAnnouncement(sentenceOf(plan, views.map((v) => v.view), t, locale), announce);

  // Each person's notices together, in the order the plan lists them (first appearance); a person with more than one sees them one at a time.
  const people: string[] = [];
  for (const v of views) if (!people.includes(v.to)) people.push(v.to);
  const heading = (to: string, onlyReporter: boolean): string => {
    const name = nameOf(to);
    return onlyReporter && to === reporter ? t('hub.preview.reporterSees', { name }) : t('hub.preview.sees', { name });
  };
  const effects: Array<{ e: EffectCode; text: string }> = plan === null ? [] : plan.effects.map((e) => ({ e, text: effectText(t, locale, e) })).filter((x) => x.text !== '');
  const named = new Set(effects.map((x) => effectPerson(x.e)).filter((p): p is string => p !== null));
  // With more than one person involved, an effect says whose it is.
  const several = new Set([...people, ...named]).size > 1;

  let body: ReactNode;
  if (plan === null) body = <p className="cw-hint cw-pv-line">{t(prompt === 'chooseRule' ? 'hub.preview.chooseRule' : 'hub.preview.choose')}</p>;
  else {
    const direct = plan.nothing === 'direct';
    const revoking = plan.notices.length === 0 && plan.effects.some((e) => e.code === 'lifts');
    const none = plan.notices.length === 0 && plan.nothing === null && plan.effects.length === 0;
    body = (
      <>
        {none && <p className="cw-hint cw-pv-line">{t('hub.preview.choose')}</p>}
        {plan.nothing === 'note' && <p className="cw-pv-line">{t(op?.op === 'revoke' ? 'hub.preview.nothing.noteRevoke' : 'hub.preview.nothing.note')}</p>}
        {plan.nothing === 'dismissal' && <p className="cw-pv-line">{t('hub.preview.nothing.dismissal')}</p>}
        {direct && <p className="cw-pv-line">{t('hub.preview.nothing.direct')}</p>}
        {revoking && <p className="cw-pv-line">{t('hub.preview.revoke.intro')}</p>}
        {people.map((to) => {
          const mine = views.filter((v) => v.to === to);
          const reporterOnly = mine.every((v) => v.notice.kind === 'report_outcome');
          return (
            <div key={to} className="cw-pv-person">
              {(people.length > 1 || reporterOnly) && <p className="cw-pv-who">{heading(to, reporterOnly)}</p>}
              {mine.length > 1 && <p className="cw-hint cw-pv-line">{t('hub.preview.oneAtATime')}</p>}
              {mine.map((v, i) => (
                <div key={v.notice.id} className="cw-pv-one">
                  {mine.length > 1 && <p className="cw-pv-pos">{t('hub.preview.position', { n: i + 1, total: mine.length })}</p>}
                  <NoticeBlock notice={v.notice} view={v.view} appeals={appeals} />
                </div>
              ))}
            </div>
          );
        })}
        {direct && plan.effects.length > 0 && (
          <div className="cw-pv-direct">
            {plan.effects.map((e, i) => {
              if (e.code === 'chat_off') {
                // What the chat box shows them when they next try to type: the kit's own line, with the referee card.
                const line =
                  e.until === null
                    ? NOTICE_WORDS['player.restricted.moderator.noEnd']
                    : fill(NOTICE_WORDS['player.restricted.moderator.until'], { when: untilText(e.until, 'en'), left: timeLeft(e.until, now(), 'en') ?? '' });
                return (
                  <div key={i}>
                    <p className="cw-pv-line">{t('hub.preview.direct.chat')}</p>
                    <p className="cw-pv-chatline" lang="en">
                      <Card kind="chat" /> <span>{line}</span>
                    </p>
                  </div>
                );
              }
              if (e.code === 'area_off' || e.code === 'banned') return <p key={i} className="cw-pv-line">{t('hub.preview.direct.game')}</p>;
              return null;
            })}
          </div>
        )}
        {(effects.length > 0 || extraEffects.length > 0) && (
          <ul className="cw-pv-effects">
            {effects
              .filter((x) => !(direct && (x.e.code === 'chat_off' || x.e.code === 'area_off' || x.e.code === 'banned')))
              .map((x, i) => {
                const person = effectPerson(x.e);
                return <li key={i}>{several && person !== null ? t('hub.preview.effect.for', { name: nameOf(person), text: x.text }) : x.text}</li>;
              })}
            {extraEffects.map((text, i) => (
              <li key={`x${i}`}>{text}</li>
            ))}
          </ul>
        )}
      </>
    );
  }

  return (
    <section className="cw-pv" aria-labelledby={titleId}>
      <h3 id={titleId} className="cw-pv-heading">
        {t('hub.preview.title')}
      </h3>
      <p className="cw-hint cw-pv-caption">{t('hub.preview.caption')}</p>
      {body}
      {announce === undefined && (
        <span className="cw-sr" role="status" aria-live="polite">
          {said === null ? '' : said}
        </span>
      )}
    </section>
  );
}

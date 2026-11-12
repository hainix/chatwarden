import { useId, useMemo, useState } from 'react';
import { useHub } from '../context.js';
import { excerptLines, filterLines, personName } from '../excerpt.js';
import type { ExcerptLine, ReportPerson } from '../excerpt.js';
import { timeOfDay } from '../format.js';
import { displayName } from '../labels.js';
import { LazyAiParts } from '../lazyParts.js';
import { NameToggle, NameValue } from '../names.js';
import type { StaffReport } from '../types.js';
import { Empty, Masked, Notice, Segmented, Tag } from '../ui.js';
import { useCase } from './CaseContext.js';

// The transcript: what was said, in order. The reported line has a red rail, the reported person's lines a neutral tint, and
// blocked words stay hidden until a moderator chooses to see them (one line, or the whole case). A box in the margin of the
// reported person's lines picks which of them the player is shown in their notice (at most five).

/** Which of a person's own lines the player is shown. The boxes edit the decision form, so the transcript and the form agree. */
export interface LinePicks {
  person: string;
  /** How the person is named in a label. */
  name: string;
  chosen: readonly string[];
  max: number;
  onToggle: (lineId: string) => void;
}

export { Masked };

/** How Simple mode draws a line: its own columns, and who said it only when the whole chat is shown. */
export interface SimpleLine {
  whole: boolean;
  /** The line is the reported person's. */
  theirs: boolean;
}

/**
 * One line of the chat, for the Transcript and for the Simple card: the one place that decides when blocked words stay hidden.
 * `simple` draws the card's lighter line (no margin box, no tags but "Reported line"); without it this is the transcript's.
 */
export function Line({ line, picks, name, simple }: { line: ExcerptLine; picks: LinePicks | null; name: (ref: string | null) => string; simple?: SimpleLine }) {
  const { t, locale } = useHub();
  const { reveal, aiRead } = useCase();
  // A line the AI cited carries a small tick (a lazy part, drawn only when the case has a read).
  const tick = aiRead === null ? null : <LazyAiParts part="tick" lineId={line.id} />;
  const showDelivered = line.delivered !== null && line.delivered !== line.raw;
  const shown = reveal.shows(line.id);
  const hidden = line.blocked && !shown;
  const time = timeOfDay(line.ts, locale);
  const theirs = picks !== null && line.person !== null && line.person === picks.person;
  const on = theirs && picks.chosen.includes(line.id);
  const full = picks !== null && picks.chosen.length >= picks.max;
  const reveals = line.blocked && !reveal.all;
  // Who said it: the handle, hidden while the server flags it, with its own Show for this line.
  const place = `line:${line.id}`;
  const who = (
    <span className="cw-line-who">
      <NameValue text={line.handle} flagged={line.handleFlagged} place={place} />
      {line.handleFlagged && ' '}
      <NameToggle flagged={line.handleFlagged} place={place} time={time} />
    </span>
  );
  const toggle = (
    <button
      type="button"
      className="cw-linkbtn"
      aria-pressed={shown}
      aria-label={t(shown ? 'hub.mask.hideLine' : 'hub.mask.showLine', { name: name(line.person) || displayName(t, { handle: line.handle, flagged: line.handleFlagged }), time })}
      onClick={() => reveal.toggle(line.id)}
    >
      {t(shown ? 'hub.mask.hide' : 'hub.mask.show')}
    </button>
  );
  if (simple !== undefined) {
    return (
      <li
        className="cw-line cw-sline"
        {...(line.reported ? { 'data-reported': 'true' } : {})}
        {...(line.blocked ? { 'data-blocked': 'true' } : {})}
        {...(simple.whole ? { 'data-who': 'true' } : {})}
        {...(simple.whole && simple.theirs ? { 'data-theirs': 'true' } : {})}
      >
        <time className="cw-line-time" dateTime={new Date(line.ts).toISOString()}>
          {time}
        </time>
        {simple.whole && who}
        <span className="cw-line-text">{hidden ? <Masked /> : line.raw}{tick}</span>
        {(line.reported || reveals) && (
          <span className="cw-line-meta">
            {line.reported && <Tag tone="bad">{t('hub.report.line.reported')}</Tag>}
            {reveals && toggle}
          </span>
        )}
      </li>
    );
  }
  return (
    <li
      className="cw-line"
      {...(line.reported ? { 'data-reported': 'true' } : {})}
      {...(line.blocked ? { 'data-blocked': 'true' } : {})}
      {...(theirs ? { 'data-theirs': 'true' } : {})}
    >
      <span className="cw-line-pick">
        {theirs && (
          <input
            type="checkbox"
            checked={on}
            disabled={!on && full}
            aria-label={t('hub.report.line.pick', { name: picks.name, time })}
            onChange={() => picks.onToggle(line.id)}
          />
        )}
      </span>
      <time className="cw-line-time" dateTime={new Date(line.ts).toISOString()}>
        {time}
      </time>
      {who}
      <span className="cw-line-text">{hidden ? <Masked /> : line.raw}{tick}</span>
      {(line.reported || line.blocked || line.audience !== null || showDelivered) && (
        <span className="cw-line-meta">
          {line.reported && <Tag tone="bad">{t('hub.report.line.reported')}</Tag>}
          {line.blocked && <Tag>{t('hub.report.line.blocked')}</Tag>}
          {reveals && toggle}
          {line.audience !== null && <Tag>{t('hub.report.line.audience', { count: line.audience.length })}</Tag>}
          {showDelivered && <span className="cw-hint">{t('hub.report.line.delivered', { text: line.delivered ?? '' })}</span>}
        </span>
      )}
    </li>
  );
}

/** The saved chat around the report, with a filter to one person, the blocked-words switch and a warning when someone sent nothing. */
export function Transcript({ report, people, picks }: { report: StaffReport; people: ReportPerson[]; picks: LinePicks | null }) {
  const { t } = useHub();
  const { reveal } = useCase();
  const headingId = useId();
  const [only, setOnly] = useState('');
  const all = useMemo(() => excerptLines(report), [report]);
  const shown = filterLines(all, only === '' ? null : only);
  const named = (ref: string | null): string => {
    const p = people.find((x) => x.ref === ref);
    return p === undefined ? '' : personName(p, people, t);
  };
  // The person to warn about: whoever is picked, else (with Everyone) the reported person. Either may have written nothing.
  const focus = only === '' ? people.find((p) => p.role === 'target') : people.find((p) => p.ref === only);
  const quiet = focus !== undefined && focus.lines === 0 ? focus : undefined;
  // The one switch also serves a flagged name: in a line, or among the people the case names.
  const anyBlocked = all.some((l) => l.blocked || l.handleFlagged) || people.some((p) => p.handleFlagged);
  const count = report.roomId === '' ? t('hub.report.excerpt.count', { count: all.length }) : t('hub.report.excerpt.countRoom', { room: report.roomId, count: all.length });

  return (
    <section className="cw-transcript" aria-labelledby={headingId}>
      <h3 id={headingId} className="cw-sr">
        {t('hub.report.excerpt.title')}
      </h3>
      {all.length === 0 ? (
        <Empty>{t('hub.report.excerpt.empty')}</Empty>
      ) : (
        <>
          <div className="cw-tr-head">
            <p className="cw-hint cw-tr-count">{shown.length === all.length ? count : t('hub.report.excerpt.showingOf', { lines: count, shown: shown.length })}</p>
            <Segmented
              label={t('hub.report.excerpt.filter')}
              value={only}
              options={[
                { value: '', label: t('hub.report.excerpt.everyone') },
                ...people.map((p) => ({ value: p.ref, label: t('hub.report.excerpt.only', { name: personName(p, people, t) }) })),
              ]}
              onChange={setOnly}
            />
            {anyBlocked && (
              <label className="cw-check cw-tr-reveal">
                <input type="checkbox" checked={reveal.all} onChange={(e) => reveal.setAll(e.target.checked)} />
                <span>{t('hub.mask.all')}</span>
              </label>
            )}
            {picks !== null && <p className="cw-hint cw-tr-picks">{t('hub.report.excerpt.picks', { name: picks.name, chosen: picks.chosen.length, max: picks.max })}</p>}
          </div>
          {quiet !== undefined && <Notice tone="warn">{t('hub.report.excerpt.silent', { name: personName(quiet, people, t) })}</Notice>}
          {shown.length > 0 && (
            <ol className="cw-lines" aria-label={t('hub.report.excerpt.label')}>
              {shown.map((l) => (
                <Line key={l.id} line={l} picks={picks} name={named} />
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

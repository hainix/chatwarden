import type { FormEvent, RefObject } from 'react';
import { LINE_MAX } from './engine';
import type { DemoSeat, PlayerNotice, SeatState } from './engine';
import { FlagIcon, SendIcon } from './icons';
import { noticeEnd, noticeKindLabel } from './notice';
import type { FeedItem, PendingBySeat } from './types';

const AVATAR: Record<string, string> = { you: 'avatar-you', ada: 'avatar-a', bo: 'avatar-b' };

export const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Message({ item, tourTarget, onReport }: { item: FeedItem; tourTarget: boolean; onReport: (item: FeedItem, opener: HTMLElement) => void }) {
  const refused = item.refused !== undefined;
  return (
    <div className={`msg ${refused ? 'msg-refused' : ''}`} data-verdict={refused ? 'refused' : 'delivered'} data-seat={item.seat}>
      <span className={`avatar ${AVATAR[item.seat] ?? 'avatar-a'}`} aria-hidden="true">
        {item.name.slice(0, 1)}
      </span>
      <div className="msg-main">
        <div className="bubble">
          <span className={`who ${item.you ? 'who-you' : ''}`}>{item.name}</span>
          <span className="said">{item.text}</span>
          {refused && <span className="stamp">Refused!</span>}
        </div>
        {!item.you && (
          <button
            type="button"
            className="report-btn"
            aria-label={`Report ${item.name}'s line: ${item.text}`}
            data-tour={tourTarget ? 'report' : undefined}
            onClick={(e) => onReport(item, e.currentTarget)}
          >
            <FlagIcon />
            <span>Report</span>
          </button>
        )}
      </div>
      {refused && <p className="msg-notice">Blocked by Community Rule {item.refused?.rule ?? 1}. Only you see this.</p>}
    </div>
  );
}

/** What a reported player sees: their notice, in a small "player's screen" frame. */
function PlayerFrame({ name, you, notice, extra, onAck }: { name: string; you: boolean; notice: PlayerNotice; extra: number; onAck: () => void }) {
  const end = noticeEnd(notice, clock);
  // The visitor's own screen speaks to her; the scripted players' screens are shown from outside.
  const title = you ? 'Your screen' : `${name}’s screen`;
  return (
    <section className="pframe" aria-label={title}>
      <div className="pframe-bar">
        <span className="pframe-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="pframe-title">{title}</span>
        <span className="pframe-sub">{you ? 'what you see' : `what ${name} sees`}</span>
      </div>
      <div className="pframe-body">
        <h4 className="pframe-kind" data-kind={notice.kind}>
          {noticeKindLabel(notice.kind)}
        </h4>
        {notice.ruleLabel !== null && <p className="pframe-rule">{notice.ruleLabel}</p>}
        {end !== '' && <p className="pframe-until">{end}</p>}
        {notice.kind === 'report_outcome' && <p className="pframe-until">A moderator acted on a report you sent.</p>}
        {notice.excerpt.length > 0 && (
          <div className="pframe-quote">
            <span className="pframe-quote-h">Your line</span>
            {notice.excerpt.map((e, i) => (
              <p key={i}>
                <q>{e.text}</q> <small>{e.day}</small>
              </p>
            ))}
          </div>
        )}
        <div className="pframe-foot">
          <small>
            {notice.refCode !== null && <code>{notice.refCode}</code>} Only {you ? 'you get' : `${name} gets`} this: no one else’s chat, no IP, no account or subject id.
            {extra > 0 ? ` ${extra} more waiting.` : ''}
          </small>
          <button type="button" className="pframe-ack" data-tour="ack" onClick={onAck}>
            Acknowledge
          </button>
        </div>
      </div>
    </section>
  );
}

interface Props {
  hidden: boolean;
  feed: FeedItem[];
  seats: SeatState[];
  allSeats: readonly DemoSeat[];
  pending: PendingBySeat;
  draft: string;
  setDraft: (v: string) => void;
  note: string | null;
  tourLineId: string | null;
  onSend: (text: string) => void;
  onBlockedWord: () => void;
  onReport: (item: FeedItem, opener: HTMLElement) => void;
  onAck: (seat: string, notice: PlayerNotice) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  logRef: RefObject<HTMLDivElement | null>;
}

export function GamePane({
  hidden,
  feed,
  seats,
  allSeats,
  pending,
  draft,
  setDraft,
  note,
  tourLineId,
  onSend,
  onBlockedWord,
  onReport,
  onAck,
  inputRef,
  logRef,
}: Props) {
  const frameSeat = allSeats.find((s) => (pending[s.id]?.length ?? 0) > 0);
  const frameNotice = frameSeat ? pending[frameSeat.id]?.[0] : undefined;
  const stateOf = (id: string) => seats.find((s) => s.id === id);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (draft.trim() !== '') onSend(draft);
  }

  return (
    <section className="pane pane-game" data-pane="game" aria-labelledby="pane-game-title" hidden={hidden}>
      <header className="pane-head">
        <h3 id="pane-game-title" tabIndex={-1}>
          The game
        </h3>
        <span className="pane-tag">#lobby</span>
      </header>
      <div className="seats-wrap" data-tour="seats">
        <ul className="seats" aria-label="Players in the lobby">
          {allSeats.map((s) => {
            const until = stateOf(s.id)?.restrictedUntil ?? null;
            return (
              <li key={s.id} className="seat" data-out={until !== null ? 'true' : undefined}>
                <span className={`avatar avatar-sm ${AVATAR[s.id] ?? ''}`} aria-hidden="true">
                  {s.name.slice(0, 1)}
                </span>
                <span className="seat-name">{s.name}</span>
                {until !== null && <span className="seat-flag">timed out until {clock(until)}</span>}
              </li>
            );
          })}
        </ul>
        <p className="seats-note">Ada and Bo are scripted. Only you type.</p>
      </div>
      <div className="chat" role="log" aria-label="Lobby chat" aria-live="off" ref={logRef} tabIndex={0}>
        {feed.map((item) => (
          <Message key={item.id} item={item} tourTarget={item.id === tourLineId} onReport={onReport} />
        ))}
      </div>
      {frameSeat && frameNotice && (
        <PlayerFrame
          key={frameNotice.id}
          name={frameSeat.name}
          you={frameSeat.you}
          notice={frameNotice}
          extra={(pending[frameSeat.id]?.length ?? 1) - 1}
          onAck={() => onAck(frameSeat.id, frameNotice)}
        />
      )}
      <form className="composer" data-tour="composer" onSubmit={submit}>
        <div className="chips" role="group" aria-label="Quick lines">
          <button type="button" className="chip" onClick={() => onSend('gg')}>
            gg
          </button>
          <button type="button" className="chip" onClick={() => onSend('nice one')}>
            nice one
          </button>
          <button type="button" className="chip chip-bad" onClick={onBlockedWord}>
            try a blocked word
          </button>
        </div>
        <div className="composer-row">
          <label className="sr-only" htmlFor="demo-input">
            Chat message
          </label>
          <input
            id="demo-input"
            ref={inputRef}
            type="text"
            value={draft}
            maxLength={LINE_MAX}
            autoComplete="off"
            enterKeyHint="send"
            placeholder="Say something"
            onChange={(e) => setDraft(e.target.value)}
          />
          <span className="count" data-near={draft.length >= LINE_MAX - 20 ? 'true' : undefined} aria-hidden="true">
            {draft.length}/{LINE_MAX}
          </span>
          <button type="submit" className="send" disabled={draft.trim() === ''}>
            <SendIcon />
            <span>Send</span>
          </button>
        </div>
        {note !== null && <p className="composer-note">{note}</p>}
      </form>
    </section>
  );
}

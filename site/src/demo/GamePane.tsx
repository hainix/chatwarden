import type { FormEvent, RefObject } from 'react';
import { LINE_MAX } from './engine';
import type { DemoSeat, SeatState } from './engine';
import { FlagIcon, SendIcon } from './icons';
import { formatUntil } from './notice';
import type { FeedItem } from './types';

const AVATAR: Record<string, string> = { you: 'avatar-you', ada: 'avatar-a', bo: 'avatar-b' };

/** When a timeout ends, in the one format every surface uses (see `formatUntil`). */
export const endTime = (ms: number) => formatUntil(ms, Date.now());

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

/** One button per player who has a notice waiting. The notice itself is player-react's dialog, drawn by the demo. */
function NoticeBar({ seats, waiting, tourSeat, onShow }: { seats: readonly DemoSeat[]; waiting: Record<string, number>; tourSeat: string | null; onShow: (seat: DemoSeat, opener: HTMLElement) => void }) {
  const who = seats.filter((s) => (waiting[s.id] ?? 0) > 0);
  if (who.length === 0) return null;
  return (
    <ul className="notice-bar" aria-label="Players with a notice waiting">
      {who.map((s) => {
        const n = waiting[s.id] ?? 0;
        const what = s.you ? 'you' : s.name;
        return (
          <li key={s.id}>
            <span>
              {s.you ? 'You have' : `${s.name} has`} {n === 1 ? 'a notice' : `${n} notices`} waiting.
            </span>
            <button
              type="button"
              className="notice-btn"
              aria-label={`See what ${what} sees (${n} ${n === 1 ? 'notice' : 'notices'} waiting)`}
              data-tour={s.id === tourSeat ? 'notice' : undefined}
              onClick={(e) => onShow(s, e.currentTarget)}
            >
              See what {what} sees
            </button>
          </li>
        );
      })}
    </ul>
  );
}

interface Props {
  hidden: boolean;
  feed: FeedItem[];
  seats: SeatState[];
  allSeats: readonly DemoSeat[];
  /** How many notices each player has waiting. */
  waiting: Record<string, number>;
  draft: string;
  setDraft: (v: string) => void;
  note: string | null;
  /** Replaces the default line under the seats, e.g. why a timed out player has gone quiet. */
  seatsNote: string | null;
  tourLineId: string | null;
  onSend: (text: string) => void;
  onBlockedWord: () => void;
  onReport: (item: FeedItem, opener: HTMLElement) => void;
  onShowNotices: (seat: DemoSeat, opener: HTMLElement) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  logRef: RefObject<HTMLDivElement | null>;
}

export function GamePane({
  hidden,
  feed,
  seats,
  allSeats,
  waiting,
  draft,
  setDraft,
  note,
  seatsNote,
  tourLineId,
  onSend,
  onBlockedWord,
  onReport,
  onShowNotices,
  inputRef,
  logRef,
}: Props) {
  // The tour points at one notice at a time: the first player who has one.
  const tourSeat = allSeats.find((s) => (waiting[s.id] ?? 0) > 0)?.id ?? null;
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
                {until !== null && <span className="seat-flag">timed out until {endTime(until)}</span>}
              </li>
            );
          })}
        </ul>
        <p className="seats-note">{seatsNote ?? 'Ada and Bo are scripted. Only you type.'}</p>
      </div>
      <div className="chat" role="log" aria-label="Lobby chat" aria-live="off" ref={logRef} tabIndex={0}>
        {feed.map((item) => (
          <Message key={item.id} item={item} tourTarget={item.id === tourLineId} onReport={onReport} />
        ))}
      </div>
      <NoticeBar seats={allSeats} waiting={waiting} tourSeat={tourSeat} onShow={onShowNotices} />
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

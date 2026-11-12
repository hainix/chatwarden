import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { untilText } from '../format.js';
import { createT, en } from '../i18n.js';
import type { PlayerT, PlayerText } from '../i18n.js';
import { RestrictedChatLine } from '../RestrictedChatLine.js';
import { Root, useUi } from '../ui.js';
import type { PlayerUiProps, Ui } from '../ui.js';
import { Composer } from './Composer.js';
import { chatReducer, createChatState } from './state.js';
import { enChat } from './words.js';
import type { ChatClosedWhy, ChatStatus } from './status.js';
import type { ChatConnection, ChatTransport } from './transport.js';
import { readFrame } from './wire.js';
import type { WireLine, WireRefusal, WireRestriction } from './wire.js';

/** What `onRefused` gets: the reason and the known fields. Never the text. */
export type ChatRefusal = WireRefusal;

export interface ChatBoxProps extends PlayerUiProps {
  /** How to reach the room: `sseTransport({ baseUrl: '/chat' })`, or your own. Keep it stable across renders (create it once). */
  transport: ChatTransport;
  /** The room id the server's `join` hook understands. A new `room` closes the connection and opens another. */
  room: string;
  /** The name of the log for assistive technology. Default: the word "Chat". */
  title?: string;
  /** Called when the server says a notice is waiting, or a refusal points at one. Bump your `NoticeQueue` `refreshKey`. */
  onNoticePending?: () => void;
  /** Called with each refusal of the player's own line, for sound or your own telemetry. No text. */
  onRefused?: (refusal: ChatRefusal) => void;
  /** Called when the connection changes. */
  onStatus?: (status: ChatStatus, why?: ChatClosedWhy) => void;
  /** Lines kept in the page. Default 200, at most 5 000 (the oldest go). */
  maxLines?: number;
  /** Focus the input when the box appears. Default false (a chat should not steal focus from a game). */
  autoFocus?: boolean;
  /** No input: a viewer who may read but not speak (a spectator). Default false. */
  readOnly?: boolean;
}

/**
 * The common props, with the chat words behind the host's own: a key the host's `t` has no text for (it answers with the key itself)
 * is worded in English, so a catalog built before the chat existed does not show `player.chat.send` on a button.
 */
function useChatUi(props: ChatBoxProps): Ui {
  const base = useUi(props);
  const { t: host, locale } = props;
  return useMemo(() => {
    const english = createT({ ...en, ...enChat }, locale ?? 'en');
    const t: PlayerT = host === undefined ? english : (key, params) => {
      const out = host(key, params);
      return out === key ? english(key, params) : out;
    };
    return { t, locale: base.locale, now: base.now, timeZone: base.timeZone };
  }, [host, locale, base.locale, base.now, base.timeZone]);
}

/** The reader is at the bottom when they are within this many pixels of it. */
const BOTTOM_PX = 24;
const CLOSED = new Set<string>(['banned', 'forbidden', 'unauthorized', 'room_closed', 'shutdown', 'not_found', 'unsupported']);
/** The longest a timer is set for (a larger delay fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

interface LineViewProps {
  line: WireLine;
  /** The name is shown (the first of a run by one name). */
  first: boolean;
  you: string;
  locale: string;
  timeZone: string | undefined;
}

/** The time of a line for the `<time>` element, or null for a time that is not a date. */
function timeOf(at: number, locale: string, timeZone: string | undefined): { iso: string; title: string } | null {
  try {
    return { iso: new Date(at).toISOString(), title: untilText(at, locale, timeZone) };
  } catch {
    return null;
  }
}

/** One line: "name: text". The name once per run; a screen reader always hears it. Text is a text node, never markup. */
const LineView = memo(function LineView({ line, first, you, locale, timeZone }: LineViewProps) {
  const mine = line.mine === true;
  const name = mine ? you : line.name;
  const when = timeOf(line.at, locale, timeZone);
  return (
    <li className="cw-chat-line" data-mine={mine ? 'true' : undefined}>
      {first ? (
        <span className={mine ? 'cw-chat-name cw-chat-name--you' : 'cw-chat-name'}>
          {name}
          <span className="cw-chat-sr">: </span>
        </span>
      ) : (
        <span className="cw-chat-sr">{name}: </span>
      )}
      <span className="cw-chat-text">{when === null ? line.text : <time dateTime={when.iso} title={when.title}>{line.text}</time>}</span>
    </li>
  );
});

/** What the connection line says: why the chat is closed, that it is reconnecting, or that it is still connecting. Empty when all is well. */
function connectionText(ui: Ui, status: ChatStatus, ready: boolean, closed: string | null): string {
  if (closed !== null) return ui.t(`player.chat.closed.${CLOSED.has(closed) ? closed : 'unsupported'}` as PlayerText);
  if (status === 'reconnecting') return ui.t('player.chat.reconnecting');
  if (!ready && status === 'connecting') return ui.t('player.chat.connecting');
  return '';
}

/**
 * A moderated chat for one room: the list, one input and Send. Lines are checked by the kit on the server; a refusal is shown to its
 * author only. A restricted player sees `RestrictedChatLine` in place of the input, and gets it back when the restriction ends.
 * @experimental
 */
export function ChatBox(props: ChatBoxProps) {
  const { transport, room, title, maxLines, autoFocus = false, readOnly = false, theme, className } = props;
  const ui = useChatUi(props);
  const { t } = ui;
  const [state, dispatch] = useReducer(chatReducer, undefined, () => createChatState(maxLines));
  const connection = useRef<ChatConnection | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const now = useRef(ui.now);
  now.current = ui.now;
  // The log is live only after the first hello has rendered, so joining does not read the snapshot aloud.
  const [live, setLive] = useState(false);
  const [snapshots, setSnapshots] = useState(0);
  const [refusedRestriction, setRefusedRestriction] = useState<WireRestriction | null>(null);
  const [refusedClosed, setRefusedClosed] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (maxLines !== undefined) dispatch({ type: 'maxLines', maxLines });
  }, [maxLines]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setLive(false);
    setRefusedRestriction(null);
    setRefusedClosed(null);
    const conn = transport.open(room, {
      frame: (raw) => {
        const frame = readFrame(raw);
        if (frame === null) return;
        if (frame.type === 'hello') {
          setLive(false);
          setSnapshots((n) => n + 1);
        }
        if (frame.type === 'hello' || frame.type === 'state') setRefusedRestriction(null);
        if (frame.type === 'notices') latest.current.onNoticePending?.();
        dispatch({ type: 'frame', frame });
      },
      status: (status, why) => {
        dispatch({ type: 'status', status, ...(why === undefined ? {} : { why }) });
        latest.current.onStatus?.(status, why);
      },
    });
    connection.current = conn;
    return () => {
      conn.close();
      connection.current = null;
    };
  }, [transport, room]);

  useEffect(() => {
    if (snapshots > 0) setLive(true);
  }, [snapshots]);

  // Scrolling: pinned to the bottom while the reader is at the bottom; once they scroll up the view stays put.
  const log = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const toBottom = (): void => {
    const el = log.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(() => {
    if (pinned.current) toBottom();
  }, [state.lines]);
  const onScroll = (): void => {
    const el = log.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_PX;
    pinned.current = atBottom;
    setAway(!atBottom);
  };

  // A restriction ends by itself: look again when it does.
  const restriction = state.restriction ?? refusedRestriction;
  const until = restriction === null ? null : restriction.until;
  useEffect(() => {
    if (until === null) return;
    const ms = until - now.current();
    if (ms <= 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), Math.min(ms, MAX_TIMER_MS));
    return () => clearTimeout(id);
  }, [until]);
  const active = restriction !== null && (restriction.until === null || restriction.until > ui.now()) ? restriction : null;
  const closed = state.closed === null ? refusedClosed : state.closed.why;

  const onRefused = (refusal: WireRefusal): void => {
    if (refusal.reason === 'restricted') setRefusedRestriction({ until: refusal.until ?? null, byModerator: refusal.byModerator === true });
    if (refusal.reason === 'banned') setRefusedClosed('banned');
    if (refusal.noticeId !== undefined) latest.current.onNoticePending?.();
    latest.current.onRefused?.(refusal);
  };

  const lines = state.lines;
  const you = t('player.chat.you');
  const status = connectionText(ui, state.status, state.ready, closed);

  return (
    <Root theme={theme} className={className}>
      <div className="cw-chat">
        <div className="cw-chat-body">
          <div
            ref={log}
            role="log"
            aria-label={title ?? t('player.chat.label')}
            aria-live={live ? 'polite' : 'off'}
            aria-relevant="additions"
            tabIndex={0}
            className="cw-chat-log"
            onScroll={onScroll}
          >
            {state.ready && lines.length === 0 && <p className="cw-chat-empty">{t('player.chat.empty')}</p>}
            <ul className="cw-chat-lines">
              {lines.map((line, i) => {
                const before = lines[i - 1];
                const first = before === undefined || before.name !== line.name || before.mine !== line.mine;
                return <LineView key={line.id} line={line} first={first} you={you} locale={ui.locale} timeZone={ui.timeZone} />;
              })}
            </ul>
          </div>
          {away && (
            <button
              type="button"
              className="cw-btn cw-chat-jump"
              onClick={() => {
                pinned.current = true;
                setAway(false);
                toBottom();
              }}
            >
              {t('player.chat.jump')}
            </button>
          )}
        </div>
        <div role="status" className="cw-chat-conn">
          {status}
        </div>
        {!readOnly && closed === null && (
          <div className="cw-chat-foot">
            {active !== null ? (
              <RestrictedChatLine
                t={ui.t}
                locale={ui.locale}
                now={ui.now}
                {...(ui.timeZone === undefined ? {} : { timeZone: ui.timeZone })}
                {...(theme === undefined ? {} : { theme })}
                until={active.until}
                byModerator={active.byModerator}
              />
            ) : (
              <Composer
                ui={ui}
                maxLength={state.maxLength}
                autoFocus={autoFocus}
                send={(text) => (connection.current === null ? Promise.reject(new Error('closed')) : connection.current.send(text))}
                onDelivered={(line) => dispatch({ type: 'sent', line })}
                onRefused={onRefused}
              />
            )}
          </div>
        )}
      </div>
    </Root>
  );
}

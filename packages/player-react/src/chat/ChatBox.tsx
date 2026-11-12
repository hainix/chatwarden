import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PlayerReporting, ReportResult } from '@chatwarden/core';
import { PlayerError } from '../client.js';
import { untilText } from '../format.js';
import { createT, en } from '../i18n.js';
import type { PlayerT, PlayerText } from '../i18n.js';
import { ReportDialog } from '../ReportDialog.js';
import type { ReportDraft } from '../ReportDialog.js';
import { RestrictedChatLine } from '../RestrictedChatLine.js';
import { errorText, Root, useUi } from '../ui.js';
import type { DialogHostProps, PlayerUiProps, Ui } from '../ui.js';
import { OptionsButton, OptionsPanel } from './ChatOptions.js';
import { Composer } from './Composer.js';
import { LineOptions } from './LineOptions.js';
import { chatReducer, createChatState } from './state.js';
import type { ChatClosedWhy, ChatStatus } from './status.js';
import type { ChatConnection, ChatTransport } from './transport.js';
import { enChat } from './words.js';
import { readFrame } from './wire.js';
import type { WireLine, WireRefusal, WireRestriction } from './wire.js';

/** What `onRefused` gets: the reason and the known fields. Never the text. */
export type ChatRefusal = WireRefusal;

export interface ChatBoxProps extends PlayerUiProps, DialogHostProps {
  /**
   * How to reach the room: `sseTransport({ baseUrl: '/chat' })`, or your own. The connection opens when the box mounts and when `room`
   * changes, with the transport of that moment: a new transport object on a later render does not reopen it (an inline
   * `sseTransport({...})` is safe). To reconnect with a changed transport (a renewed token), change the box's `key`.
   */
  transport: ChatTransport;
  /** The room id the server's `join` hook understands. A new `room` closes the connection and opens another. */
  room: string;
  /** How reporting works here: `(await client.rules()).reporting`. Passed to `ReportDialog`. Without it a report is one press. */
  reporting?: PlayerReporting;
  /** The name of the log for assistive technology. Default: the word "Chat". */
  title?: string;
  /** Called when the server says a notice is waiting, or a refusal points at one. Bump your `NoticeQueue` `refreshKey`. */
  onNoticePending?: () => void;
  /** Called with each refusal of the player's own line, for sound or your own telemetry. No text. */
  onRefused?: (refusal: ChatRefusal) => void;
  /** Called when the connection changes. */
  onStatus?: (status: ChatStatus, why?: ChatClosedWhy) => void;
  /** When given, "Read the rules" appears in the options panel and calls this. */
  onOpenRules?: () => void;
  /** Lines kept in the page. Default 200, at most 5 000 (the oldest go). */
  maxLines?: number;
  /** Focus the input when the box appears. Default false (a chat should not steal focus from a game). */
  autoFocus?: boolean;
  /** No input: a viewer who may read but not speak (a spectator). Default false. */
  readOnly?: boolean;
}

/** The reader is at the bottom when they are within this many pixels of it. */
const BOTTOM_PX = 24;
/** How long the mute line (with Undo) stays. */
const MUTE_NOTE_MS = 8000;
const CLOSED = new Set<string>(['banned', 'forbidden', 'unauthorized', 'room_closed', 'shutdown', 'not_found', 'unsupported']);
/** The longest a timer is set for (a larger delay fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How long a `restricted` refusal holds the input back whatever the clocks say. */
const HOLD_MS = 60_000;

/** A failure as an error the components can word: anything that is not already a PlayerError is a dropped connection. */
const failureOf = (e: unknown): PlayerError => (e instanceof PlayerError ? e : new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' }));

/**
 * The common props, with the chat words behind the host's own: a key the host's `t` has no text for (it answers with the key itself)
 * is worded in English, so a catalog built before the chat existed does not show `player.chat.send` on a button.
 */
function useChatUi(props: ChatBoxProps): Ui {
  const base = useUi(props);
  const { t: host, locale } = props;
  const t = useMemo<PlayerT>(() => {
    const english = createT({ ...en, ...enChat }, locale ?? 'en');
    return host === undefined
      ? english
      : (key, params) => {
          const out = host(key, params);
          return out === key ? english(key, params) : out;
        };
  }, [host, locale]);
  return { t, locale: base.locale, now: base.now, timeZone: base.timeZone };
}

interface LineViewProps {
  line: WireLine;
  /** The name is shown (the first of a run by one name). */
  first: boolean;
  you: string;
  t: PlayerT;
  locale: string;
  timeZone: string | undefined;
  open: boolean;
  onToggle: (id: string) => void;
  onReport: (line: WireLine) => void;
  onMute: (line: WireLine) => void;
  register: (id: string, el: HTMLButtonElement | null) => void;
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
const LineView = memo(function LineView({ line, first, you, t, locale, timeZone, open, onToggle, onReport, onMute, register }: LineViewProps) {
  const mine = line.mine === true;
  const name = mine ? you : line.name;
  const when = timeOf(line.at, locale, timeZone);
  return (
    <li className="cw-chat-line" data-mine={mine ? 'true' : undefined} title={when === null ? undefined : when.title}>
      {first ? (
        <span className={mine ? 'cw-chat-name cw-chat-name--you' : 'cw-chat-name'}>
          {name}
          <span className="cw-chat-sr">: </span>
        </span>
      ) : (
        <span className="cw-chat-sr">{name}: </span>
      )}
      <span className="cw-chat-text">{line.text}</span>
      {when !== null && <time hidden dateTime={when.iso} />}
      {!mine && <LineOptions t={t} line={line} open={open} onToggle={onToggle} onReport={onReport} onMute={onMute} register={register} />}
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

interface MuteNote {
  name: string;
  /** The refs held when the mute was made: the new one is the entry the next `state` frame adds under this name. */
  before: Set<string>;
  error: PlayerError | null;
}

/**
 * A moderated chat for one room: the list, one input and Send. Lines are checked by the kit on the server; a refusal is shown to its
 * author only. A restricted player sees `RestrictedChatLine` in place of the input, and gets it back when the restriction ends. Per
 * line there is one quiet control (Report, Mute); the one door at the corner (Chat options) holds the muted players and the standard.
 * @experimental
 */
export function ChatBox(props: ChatBoxProps) {
  const { transport, room, reporting, maxLines, autoFocus = false, readOnly = false, theme, className, container, returnFocusTo, onOpenRules } = props;
  const ui = useChatUi(props);
  const { t } = ui;
  const [state, dispatch] = useReducer(chatReducer, undefined, () => createChatState(maxLines));
  const connection = useRef<ChatConnection | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const now = useRef(ui.now);
  now.current = ui.now;
  const current = useRef(state);
  current.current = state;
  // The log is live only after the first hello has rendered, so joining does not read the snapshot aloud.
  const [live, setLive] = useState(false);
  const [snapshots, setSnapshots] = useState(0);
  const [refusedRestriction, setRefusedRestriction] = useState<(WireRestriction & { hold?: number | null }) | null>(null);
  const [attempt, setAttempt] = useState(0);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  // The server's clock minus the player's, as last seen on a live line: a restriction's `until` is the server's.
  const skew = useRef(0);
  const [refusedClosed, setRefusedClosed] = useState<string | null>(null);
  const [, setTick] = useState(0);
  const [openLine, setOpenLine] = useState<string | null>(null);
  const [reportFor, setReportFor] = useState<WireLine | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [muteNote, setMuteNote] = useState<MuteNote | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controls = useRef(new Map<string, HTMLButtonElement>());
  const doorControl = useRef<HTMLButtonElement | null>(null);
  const panelId = useId();

  useEffect(() => {
    if (maxLines !== undefined) dispatch({ type: 'maxLines', maxLines });
  }, [maxLines]);

  useEffect(() => {
    dispatch({ type: 'reset' });
    setLive(false);
    setRefusedRestriction(null);
    setRefusedClosed(null);
    setOpenLine(null);
    setReportFor(null);
    setPanelOpen(false);
    setMuteNote(null);
    skew.current = 0;
    const conn = transportRef.current.open(room, {
      frame: (raw) => {
        const frame = readFrame(raw);
        if (frame === null) return;
        if (frame.type === 'hello') {
          setLive(false);
          setSnapshots((n) => n + 1);
        }
        if (frame.type === 'hello' || frame.type === 'state') setRefusedRestriction(null);
        if (frame.type === 'notices') latest.current.onNoticePending?.();
        if (frame.type === 'line') skew.current = frame.line.at - now.current();
        // The server says what time it is: that is the clock `until` is in (a hello from an older server has none, and skew stays as it was).
        if (frame.type === 'hello' && frame.now !== undefined) skew.current = frame.now - now.current();
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
      clearTimeout(noteTimer.current);
    };
  }, [room, attempt]);

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
  const hold = (restriction as { hold?: number | null } | null)?.hold ?? null;
  // The server's time as the player's clock shows it: `until` is the server's, so it is read against the server's clock (as last seen).
  const serverNow = ui.now() + skew.current;
  useEffect(() => {
    // Look again when the restriction ends (by the server's clock), and when a hold ends.
    const wait = [until === null ? null : until - (now.current() + skew.current), hold === null ? null : hold - now.current()].filter((ms): ms is number => ms !== null && ms > 0);
    if (wait.length === 0) return;
    const id = setTimeout(() => setTick((n) => n + 1), Math.min(Math.max(...wait), MAX_TIMER_MS));
    return () => clearTimeout(id);
  }, [until, hold, state.lines]);
  // A restricted refusal is the server's word: it holds for a minute whatever the player's clock says (a clock that runs ahead must not
  // hand the input back to a player the server just refused), and from then on the server's `until` decides.
  const active = restriction !== null && (restriction.until === null || restriction.until > serverNow || (hold !== null && hold > ui.now())) ? restriction : null;
  // What the countdown is read against: never past the end, so a held restriction says "in a minute", not "ended".
  const lineNow = (): number => (active === null || active.until === null ? ui.now() : Math.min(ui.now() + skew.current, active.until - 1000));
  const closed = state.closed === null ? refusedClosed : state.closed.why;

  const onRefused = (refusal: WireRefusal): void => {
    if (refusal.reason === 'restricted') setRefusedRestriction({ until: refusal.until ?? null, byModerator: refusal.byModerator === true, hold: now.current() + HOLD_MS });
    if (refusal.reason === 'banned') setRefusedClosed('banned');
    if (refusal.noticeId !== undefined) latest.current.onNoticePending?.();
    latest.current.onRefused?.(refusal);
  };

  // ---- Per-line options, report and mute -----------------------------------------------------------------------------
  const register = useCallback((id: string, el: HTMLButtonElement | null): void => {
    if (el === null) controls.current.delete(id);
    else controls.current.set(id, el);
  }, []);
  const toggleRow = useCallback((id: string): void => setOpenLine((open) => (open === id ? null : id)), []);
  const startReport = useCallback((line: WireLine): void => {
    setOpenLine(null);
    setReportFor(line);
  }, []);

  const showNote = (note: MuteNote | null): void => {
    clearTimeout(noteTimer.current);
    setMuteNote(note);
    if (note !== null) noteTimer.current = setTimeout(() => setMuteNote(null), MUTE_NOTE_MS);
  };
  const showNoteRef = useRef(showNote);
  showNoteRef.current = showNote;

  const startMute = useCallback((line: WireLine): void => {
    setOpenLine(null);
    const conn = connection.current;
    if (conn === null) return;
    const before = new Set(current.current.muted.map((m) => m.ref));
    void (async () => {
      try {
        const answer = await conn.mute({ lineId: line.id }, true);
        const changed = typeof answer === 'boolean' ? answer : answer.ok;
        if (changed) {
          // The clicked line goes at once, then exactly the lines the answer names (the same ids as the server's `hide` frame, which covers
          // a reconnect in the gap). Never by name: names are not unique.
          const named = typeof answer === 'boolean' || !Array.isArray(answer.hiddenIds) ? [] : answer.hiddenIds.filter((id) => typeof id === 'string');
          dispatch({ type: 'frame', frame: { type: 'hide', ids: [line.id, ...named] } });
          showNoteRef.current({ name: line.name, before, error: null });
        }
      } catch (e) {
        showNoteRef.current({ name: line.name, before, error: failureOf(e) });
      }
      // The control that had focus is gone with the line: keep focus in the box.
      const at = document.activeElement;
      if (at === null || at === document.body) log.current?.focus();
    })();
  }, []);

  const undoRef = muteNote === null ? undefined : state.muted.find((m) => m.name === muteNote.name && !muteNote.before.has(m.ref))?.ref;
  const unmute = (ref: string): void => {
    connection.current?.mute({ ref }, false).catch(() => undefined);
  };

  const sendReport = (line: WireLine, draft: ReportDraft): Promise<ReportResult> => {
    const conn = connection.current;
    if (conn === null) return Promise.reject(new Error('closed'));
    // A line that aged out of the room, or one this viewer cannot see, is `not_found`: to the player that is a player who left.
    return conn.report(line.id, draft).then((result) => (result.ok === false && (result.refused as string) === 'not_found' ? { ...result, refused: 'not_player' } : result));
  };

  const closeOpen = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Escape') return;
    if (panelOpen) {
      setPanelOpen(false);
      doorControl.current?.focus();
    } else if (openLine !== null) {
      const id = openLine;
      setOpenLine(null);
      controls.current.get(id)?.focus();
    } else return;
    e.stopPropagation();
  };

  const lines = state.lines;
  const you = t('player.chat.you');
  const status = connectionText(ui, state.status, state.ready, closed);
  const undo = muteNote !== null && muteNote.error === null ? muteNote : null;

  return (
    <Root theme={theme} className={className}>
      <div className="cw-chat" onKeyDown={closeOpen}>
        <div className="cw-chat-body">
          <div
            ref={log}
            role="log"
            aria-label={props.title ?? t('player.chat.label')}
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
                return (
                  <LineView
                    key={line.id}
                    line={line}
                    first={first}
                    you={you}
                    t={t}
                    locale={ui.locale}
                    timeZone={ui.timeZone}
                    open={openLine === line.id}
                    onToggle={toggleRow}
                    onReport={startReport}
                    onMute={startMute}
                    register={register}
                  />
                );
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
        <div role="status" className={closed === null ? 'cw-chat-conn' : 'cw-chat-conn cw-chat-conn--closed'}>
          {status}
          {closed !== null && closed !== 'banned' && (
            <>
              {' '}
              <button type="button" className="cw-chat-retry" onClick={() => {
                  setAttempt((n) => n + 1);
                  // The button goes with the closed line: keep focus in the box.
                  log.current?.focus();
                }}>
                {t('player.state.retry')}
              </button>
            </>
          )}
        </div>
        <div role="status" className="cw-chat-note">
          {muteNote !== null && muteNote.error !== null && <p className="cw-chat-failure">{errorText(t, muteNote.error)}</p>}
          {undo !== null && (
            <p>
              {t('player.chat.muted', { name: undo.name })}{' '}
              <button
                type="button"
                className="cw-chat-undo"
                disabled={undoRef === undefined}
                onClick={() => {
                  if (undoRef === undefined) return;
                  showNote(null);
                  unmute(undoRef);
                }}
              >
                {t('player.chat.undo')}
              </button>
            </p>
          )}
        </div>
        {closed === null && (
          <>
            <div className="cw-chat-foot">
              {!readOnly &&
                (active !== null ? (
                  <RestrictedChatLine
                    t={ui.t}
                    locale={ui.locale}
                    now={lineNow}
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
                    onDelivered={(line) => {
                      skew.current = line.at - now.current();
                      dispatch({ type: 'sent', line });
                    }}
                    onRefused={onRefused}
                  />
                ))}
              <OptionsButton
                t={t}
                open={panelOpen}
                panelId={panelId}
                onToggle={() => setPanelOpen((open) => !open)}
                register={(el) => {
                  doorControl.current = el;
                }}
              />
            </div>
            {panelOpen && (
              <OptionsPanel
                t={t}
                id={panelId}
                muted={state.muted}
                summary={state.summary}
                onUnmute={unmute}
                onOpenRules={
                  onOpenRules === undefined
                    ? undefined
                    : () => {
                        setPanelOpen(false);
                        onOpenRules();
                      }
                }
              />
            )}
          </>
        )}
      </div>
      {reportFor !== null && (
        <ReportDialog
          t={ui.t}
          locale={ui.locale}
          now={ui.now}
          {...(ui.timeZone === undefined ? {} : { timeZone: ui.timeZone })}
          {...(theme === undefined ? {} : { theme })}
          {...(className === undefined ? {} : { className })}
          {...(container === undefined ? {} : { container })}
          {...(reporting === undefined ? {} : { reporting })}
          returnFocusTo={() => controls.current.get(reportFor.id) ?? log.current ?? returnFocusTo?.() ?? null}
          targetName={reportFor.name}
          line={reportFor.text}
          onSubmit={(draft) => sendReport(reportFor, draft)}
          onClose={() => setReportFor(null)}
        />
      )}
    </Root>
  );
}

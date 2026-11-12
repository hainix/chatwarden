import type { ChatClosedWhy, ChatStatus } from './status.js';
import type { ChatFrame, WireLine, WireMuted, WireRestriction } from './wire.js';

/** Lines kept when nothing else is asked for (the box's `maxLines` default). */
export const DEFAULT_MAX_LINES = 200;
/** The most lines a box may be asked to keep. */
export const MAX_MAX_LINES = 5000;

/** A usable cap: a whole number from 1; above the bound it is the bound; anything else is the default. */
function capOf(n: number): number {
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_MAX_LINES) : DEFAULT_MAX_LINES;
}

/** Why a stream ended for good. `until` is a ban's end (`bye` with `banned`): epoch ms, or null when it has none. */
export interface ChatClosed {
  why: ChatClosedWhy;
  until?: number | null;
}

/** Everything the box shows, held by `chatReducer`. */
export interface ChatState {
  status: ChatStatus;
  /** The server's epoch from the last `hello`; null before the first. */
  epoch: string | null;
  /** The viewer's own display name, from `hello`. */
  you: { name: string } | null;
  /** The line length limit, from `hello`. */
  maxLength: number;
  /** The profile's one-line standard, from `hello`. */
  summary: string;
  restriction: WireRestriction | null;
  /** Oldest first: by `at`, then by numeric `id`. At most `maxLines`. */
  lines: WireLine[];
  muted: WireMuted[];
  /** Set when the stream ended for good. */
  closed: ChatClosed | null;
  /** False until the first `hello`: the box shows no input and announces nothing before it. */
  ready: boolean;
  maxLines: number;
}

export type ChatAction =
  /** A validated frame from the transport. */
  | { type: 'frame'; frame: ChatFrame }
  /** The transport's status. */
  | { type: 'status'; status: ChatStatus; why?: ChatClosedWhy }
  /** The answer to a send that was delivered: the same line the stream also carries. */
  | { type: 'sent'; line: WireLine }
  /** The box's `maxLines` prop. */
  | { type: 'maxLines'; maxLines: number }
  /** Back to the start (a new room). Keeps `maxLines`. */
  | { type: 'reset' };

/** A fresh state with a given line cap. */
export function createChatState(maxLines: number = DEFAULT_MAX_LINES): ChatState {
  return {
    status: 'connecting',
    epoch: null,
    you: null,
    maxLength: 200,
    summary: '',
    restriction: null,
    lines: [],
    muted: [],
    closed: null,
    ready: false,
    maxLines: capOf(maxLines),
  };
}

export const initialChatState: ChatState = createChatState();

const DIGITS = /^\d+$/;

/** Ids in numeric order ("9" before "10", any length); numeric ids before others; others by code unit. */
function compareIds(a: string, b: string): number {
  const an = DIGITS.test(a);
  const bn = DIGITS.test(b);
  if (an && bn) {
    const x = a.replace(/^0+(?=\d)/, '');
    const y = b.replace(/^0+(?=\d)/, '');
    if (x.length !== y.length) return x.length - y.length;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order lines are shown in: when the server accepted them, then the room's line number. */
function compareLines(a: WireLine, b: WireLine): number {
  return a.at !== b.at ? a.at - b.at : compareIds(a.id, b.id);
}

/** Sorted, cut to the newest `max`. */
function settle(lines: WireLine[], max: number): WireLine[] {
  const sorted = [...lines].sort(compareLines);
  return sorted.length > max ? sorted.slice(sorted.length - max) : sorted;
}

const sameLine = (a: WireLine, b: WireLine): boolean => a.id === b.id && a.at === b.at && a.name === b.name && a.text === b.text && a.mine === b.mine;

/** Lines in by id; a line already held is replaced by the incoming copy, and stays `mine` if it was. */
function merge(held: WireLine[], incoming: WireLine[], max: number): WireLine[] {
  const byId = new Map<string, WireLine>();
  for (const l of held) byId.set(l.id, l);
  for (const l of incoming) {
    const old = byId.get(l.id);
    byId.set(l.id, old?.mine === true && l.mine !== true ? { ...l, mine: true } : l);
  }
  return settle([...byId.values()], max);
}

/** One line in: replaced in place when its id is held, else inserted where it belongs. No sort; the common case is an append. */
function addLine(state: ChatState, line: WireLine): ChatState {
  const held = state.lines;
  const at = held.findIndex((l) => l.id === line.id);
  if (at !== -1) {
    const old = held[at] as WireLine;
    if (sameLine(old, line)) return state;
    const next = old.mine === true && line.mine !== true ? { ...line, mine: true as const } : line;
    const lines = [...held];
    lines.splice(at, 1);
    return withLine(state, lines, next);
  }
  return withLine(state, held, line);
}

function withLine(state: ChatState, others: WireLine[], line: WireLine): ChatState {
  let i = others.length;
  while (i > 0 && compareLines(others[i - 1] as WireLine, line) > 0) i -= 1;
  if (i === 0 && others.length >= state.maxLines) return others === state.lines ? state : { ...state, lines: others };
  const lines = [...others.slice(0, i), line, ...others.slice(i)];
  return { ...state, lines: lines.length > state.maxLines ? lines.slice(lines.length - state.maxLines) : lines };
}

function onHello(state: ChatState, f: Extract<ChatFrame, { type: 'hello' }>): ChatState {
  let lines: WireLine[];
  if (state.epoch !== f.epoch) lines = settle(f.lines, state.maxLines);
  else {
    // Same epoch (a reconnect): merge by id. A held line inside the snapshot's window that the snapshot lacks was hidden while the
    // viewer was away (its author muted), so it goes; lines before the window stay.
    const sorted = [...f.lines].sort(compareLines);
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    const inSnapshot = new Set(f.lines.map((l) => l.id));
    // Only a line inside the snapshot's window, not mine, is judged: older ones may have aged out, newer ones (a late delivery, the
    // answer to a send) the snapshot simply predates, and my own lines are never hidden from me.
    const kept =
      oldest === undefined || newest === undefined
        ? state.lines
        : state.lines.filter((l) => l.mine === true || inSnapshot.has(l.id) || compareLines(l, oldest) < 0 || compareLines(l, newest) > 0);
    lines = merge(kept, f.lines, state.maxLines);
  }
  return {
    ...state,
    status: 'open',
    epoch: f.epoch,
    you: f.you,
    maxLength: f.maxLength,
    summary: f.summary,
    restriction: f.restriction,
    muted: f.muted,
    lines,
    closed: null,
    ready: true,
  };
}

/** The state after a frame, a status change, the answer to a send, or a setting change. Pure; returns the same object when nothing changed. */
export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return createChatState(state.maxLines);
    case 'maxLines': {
      if (!Number.isInteger(action.maxLines) || action.maxLines < 1) return state;
      const max = capOf(action.maxLines);
      if (max === state.maxLines) return state;
      return { ...state, maxLines: max, lines: state.lines.length > max ? state.lines.slice(state.lines.length - max) : state.lines };
    }
    case 'sent':
      return addLine(state, action.line);
    case 'status': {
      const { status, why } = action;
      if (status === 'closed' && why !== undefined) {
        const closed: ChatClosed = state.closed?.why === why ? state.closed : { why };
        return state.status === 'closed' && state.closed === closed ? state : { ...state, status, closed };
      }
      return state.status === status ? state : { ...state, status };
    }
    case 'frame': {
      const f = action.frame;
      if (f.type === 'hello') return onHello(state, f);
      if (f.type === 'bye') {
        const closed: ChatClosed = f.until === undefined ? { why: f.reason } : { why: f.reason, until: f.until };
        return { ...state, status: 'closed', closed };
      }
      // Everything else is about a room the viewer has joined: ignore it before the first hello.
      if (!state.ready) return state;
      switch (f.type) {
        case 'line':
          return addLine(state, f.line);
        case 'hide': {
          const gone = new Set(f.ids);
          const lines = state.lines.filter((l) => !gone.has(l.id));
          return lines.length === state.lines.length ? state : { ...state, lines };
        }
        case 'state':
          return { ...state, restriction: f.restriction, muted: f.muted };
        default:
          return state;
      }
    }
  }
}

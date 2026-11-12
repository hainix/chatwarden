// The chat entry: `@chatwarden/player-react/chat`. The main entry reaches none of this.
//
// All names here are @experimental until 0.2.
export { ChatBox } from './ChatBox.js';
export type { ChatBoxProps, ChatRefusal } from './ChatBox.js';
export { sseTransport } from './transport.js';
export type { ChatClosedWhy, ChatConnection, ChatStatus, ChatTransport, ChatTransportEvents, SseTransportOptions } from './transport.js';
export type { ChatFrame, MuteResult, MuteTarget, SendResult, WireLine, WireMuted, WireRefusal, WireRestriction } from './wire.js';
/** @experimental The pure parts, for a game's own UI: the reducer behind the box, and the frame reader. */
export { chatReducer, createChatState, initialChatState } from './state.js';
export type { ChatAction, ChatState } from './state.js';
export { readFrame } from './wire.js';
/** The English chat words, to copy as the start of a translation: `createT({ ...en, ...enChat, ...yours }, locale)`. */
export { enChat } from './words.js';

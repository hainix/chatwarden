// Server-Sent Events encoding for the chat stream (design 7). Pure, no `node:` import.
import type { ChatFrame } from './wire.js';

/**
 * A heartbeat: an SSE comment, ignored by every reader but enough to keep a proxy from closing an idle stream.
 * @experimental
 */
export const HEARTBEAT = ': ping\n\n';

/** U+2028 and U+2029, built from code points so no editor or tool can turn them into raw line breaks in this file. */
const LS = new RegExp(String.fromCharCode(0x2028), 'g');
const PS = new RegExp(String.fromCharCode(0x2029), 'g');
/** A backslash. */
const ESC = String.fromCharCode(92);

/**
 * One frame as one SSE event: `event: <type>\ndata: <JSON>\n\n`. The JSON has no raw line break (JSON escapes `\n` and `\r`; U+2028 and
 * U+2029 are escaped here as well, for a reader that splits on them), so a line, a name or a summary can never end the event early or
 * start another.
 * @experimental
 */
export function encodeFrame(frame: ChatFrame): string {
  const data = JSON.stringify(frame).replace(LS, ESC + 'u2028').replace(PS, ESC + 'u2029');
  return `event: ${frame.type}\ndata: ${data}\n\n`;
}

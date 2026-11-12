/** One event of a `text/event-stream`: its `event:` name (`message` when there was none) and its `data:` lines joined by a newline. */
export interface SseEvent {
  type: string;
  data: string;
}

export interface SseParserOptions {
  /** The most characters one line, or one event's data, may hold before the event is dropped. Default 262 144 (the frame reader's own 64 KiB limit sits below it). */
  maxEventChars?: number;
}

const DEFAULT_MAX = 256 * 1024;
/** What a line may hold beyond its data: the field name, the colon and a space (`event: ` names are short too). */
const FIELD_ROOM = 32;

/**
 * A parser for the stream's text, fed in chunks cut anywhere. Line ends are `\n`, `\r\n` or `\r` (a `\r\n` split between two chunks is
 * still one end). A comment (a line starting with `:`, a heartbeat) emits nothing; `id`, `retry` and unknown fields are ignored; an event
 * is emitted at its blank line, so an unfinished final event is never emitted. An event over `maxEventChars` is dropped as a whole, and
 * a line that never ends holds no memory: the parser forgets it and waits for the next line end.
 */
export function createSseParser(onEvent: (event: SseEvent) => void, options: SseParserOptions = {}): { push(chunk: string): void } {
  const max = options.maxEventChars !== undefined && options.maxEventChars > 0 ? options.maxEventChars : DEFAULT_MAX;
  let partial = ''; // the line being read
  let skipLf = false; // the last chunk ended in `\r`: a `\n` first in the next one belongs to it
  let first = true; // a byte order mark is ignored at the very start only
  let eventType = '';
  let data: string[] = [];
  let dataChars = 0;
  let lineTooLong = false; // the current line went over the limit and was thrown away
  let lineKillsEvent = false; // ... and it was a line the event cannot do without (its data or its name)
  let dropped = false; // this event went over the limit: nothing of it is emitted

  const drop = (): void => {
    dropped = true;
    data = [];
    dataChars = 0;
    eventType = '';
  };

  const field = (line: string): void => {
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (dropped) return;
    if (name === 'event') eventType = value;
    else if (name === 'data') {
      dataChars += value.length + 1;
      if (dataChars - 1 > max) drop();
      else data.push(value);
    }
  };

  const endLine = (): void => {
    const line = partial;
    partial = '';
    if (lineTooLong) {
      // Only itself is lost, unless it was part of the event: a comment, an id or an unknown field costs nothing.
      lineTooLong = false;
      if (lineKillsEvent) drop();
      lineKillsEvent = false;
      return;
    }
    if (line !== '') {
      field(line);
      return;
    }
    // A blank line ends the event.
    const type = eventType === '' ? 'message' : eventType;
    const lines = data;
    const wasDropped = dropped;
    eventType = '';
    data = [];
    dataChars = 0;
    dropped = false;
    if (!wasDropped && lines.length > 0) onEvent({ type, data: lines.join('\n') });
  };

  return {
    push(chunk: string): void {
      let s = chunk;
      if (first && s !== '') {
        first = false;
        if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      }
      const length = s.length;
      let i = 0;
      while (i < length) {
        if (skipLf) {
          skipLf = false;
          if (s[i] === '\n') {
            i += 1;
            continue;
          }
        }
        let j = i;
        while (j < length && s[j] !== '\n' && s[j] !== '\r') j += 1;
        if (!lineTooLong && j > i) {
          partial += s.slice(i, j);
          if (partial.length > max + FIELD_ROOM) {
            const colon = partial.indexOf(':');
            const name = colon === -1 ? partial : partial.slice(0, colon);
            lineKillsEvent = name === 'data' || name === 'event';
            partial = '';
            lineTooLong = true;
          }
        }
        if (j === length) break;
        endLine();
        if (s[j] === '\r') {
          if (j + 1 < length) {
            if (s[j + 1] === '\n') j += 1;
          } else skipLf = true;
        }
        i = j + 1;
      }
    },
  };
}

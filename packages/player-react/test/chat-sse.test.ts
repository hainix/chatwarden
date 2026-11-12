import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/chat/sse.js';

type Ev = { type: string; data: string };

function parse(chunks: string[], options?: Parameters<typeof createSseParser>[1]): Ev[] {
  const out: Ev[] = [];
  const p = createSseParser((e) => out.push(e), options);
  for (const c of chunks) p.push(c);
  return out;
}

const STREAM =
  'event: hello\ndata: {"type":"hello","text":"héllo \u{1F600}"}\n\n' +
  ': ping\n\n' +
  'event: line\ndata: {"type":"line","n":1}\n\n' +
  'data: bare\n\n' +
  'event: notices\ndata: {"type":"notices"}\n\n';

const EXPECTED: Ev[] = [
  { type: 'hello', data: '{"type":"hello","text":"héllo \u{1F600}"}' },
  { type: 'line', data: '{"type":"line","n":1}' },
  { type: 'message', data: 'bare' },
  { type: 'notices', data: '{"type":"notices"}' },
];

describe('events split at every byte boundary parse identically', () => {
  it('the whole stream in one chunk', () => {
    expect(parse([STREAM])).toEqual(EXPECTED);
  });

  it('split in two at every character index', () => {
    for (let i = 0; i <= STREAM.length; i += 1) expect(parse([STREAM.slice(0, i), STREAM.slice(i)]), `split at ${i}`).toEqual(EXPECTED);
  });

  it('one character at a time', () => {
    expect(parse([...STREAM])).toEqual(EXPECTED);
  });

  it('split at every pair of boundaries (three chunks) for a CRLF stream', () => {
    const crlf = STREAM.replaceAll('\n', '\r\n');
    for (let i = 0; i <= crlf.length; i += 3) for (let j = i; j <= crlf.length; j += 5) expect(parse([crlf.slice(0, i), crlf.slice(i, j), crlf.slice(j)]), `${i},${j}`).toEqual(EXPECTED);
  });

  it('empty chunks change nothing', () => {
    expect(parse(['', STREAM.slice(0, 10), '', '', STREAM.slice(10), ''])).toEqual(EXPECTED);
  });

  it('bytes split mid-character, decoded the way the transport does, parse identically', () => {
    const bytes = new TextEncoder().encode(STREAM);
    for (let i = 0; i <= bytes.length; i += 1) {
      const decoder = new TextDecoder();
      const text = [decoder.decode(bytes.slice(0, i), { stream: true }), decoder.decode(bytes.slice(i), { stream: true }), decoder.decode()];
      expect(parse(text), `byte split at ${i}`).toEqual(EXPECTED);
    }
  });
});

describe('CRLF and bare CR', () => {
  it('CRLF line ends', () => {
    expect(parse(['event: line\r\ndata: x\r\n\r\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('LF line ends', () => {
    expect(parse(['event: line\ndata: x\n\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('bare CR line ends', () => {
    expect(parse(['event: line\rdata: x\r\r'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('mixed line ends in one event', () => {
    expect(parse(['event: line\r\ndata: a\ndata: b\rdata: c\r\n\n'])).toEqual([{ type: 'line', data: 'a\nb\nc' }]);
  });

  it('a CRLF split between the CR and the LF is one line end, not two (no phantom blank line)', () => {
    expect(parse(['event: line\r', '\ndata: x\r', '\n\r', '\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('a lone CR at the end of a chunk followed by a non-LF starts the next line', () => {
    expect(parse(['data: a\r', 'data: b\r\r'])).toEqual([{ type: 'message', data: 'a\nb' }]);
  });

  it('an empty chunk between CR and LF keeps them together', () => {
    expect(parse(['data: a\r', '', '\n\r\n'])).toEqual([{ type: 'message', data: 'a' }]);
  });

  it('U+2028, U+0085 and U+000B inside data do not end a line', () => {
    expect(parse(['data: a\u2028b\u0085c\u000bd\n\n'])).toEqual([{ type: 'message', data: 'a\u2028b\u0085c\u000bd' }]);
  });
});

describe('comments and heartbeats emit nothing', () => {
  it('a comment alone', () => {
    expect(parse([': ping\n\n'])).toEqual([]);
  });

  it('many heartbeats, then an event', () => {
    expect(parse([': ping\n\n: ping\n\n:\n\nevent: line\ndata: x\n\n: ping\n\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('a comment inside an event does not break it', () => {
    expect(parse(['event: line\n: note\ndata: x\n\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('a comment line with a colon and an event-looking text is still a comment', () => {
    expect(parse([': event: hello\n: data: {}\n\n'])).toEqual([]);
  });

  it('a heartbeat split mid-line emits nothing and does not disturb the next event', () => {
    expect(parse([': pi', 'ng\n', '\nevent: line\nda', 'ta: x\n', '\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('a block with only an event name (no data) emits nothing and the name does not leak to the next event', () => {
    expect(parse(['event: hello\n\ndata: x\n\n'])).toEqual([{ type: 'message', data: 'x' }]);
  });

  it('blank lines alone emit nothing', () => {
    expect(parse(['\n\n\n\r\n\r\r'])).toEqual([]);
  });

  it('id and retry fields are ignored (the stream has no replay cursor)', () => {
    expect(parse(['id: 7\nretry: 5\nevent: line\ndata: x\n\n'])).toEqual([{ type: 'line', data: 'x' }]);
  });

  it('an unknown field is ignored', () => {
    expect(parse(['zzz: 1\ndata: x\n\n'])).toEqual([{ type: 'message', data: 'x' }]);
  });
});

describe('multi-line data joins with newline', () => {
  it('two data lines', () => {
    expect(parse(['data: a\ndata: b\n\n'])).toEqual([{ type: 'message', data: 'a\nb' }]);
  });

  it('an empty data line in the middle keeps its place', () => {
    expect(parse(['data: a\ndata:\ndata: c\n\n'])).toEqual([{ type: 'message', data: 'a\n\nc' }]);
  });

  it('a lone empty data line is an event with empty data', () => {
    expect(parse(['data:\n\n'])).toEqual([{ type: 'message', data: '' }]);
    expect(parse(['data\n\n'])).toEqual([{ type: 'message', data: '' }]);
  });

  it('only one leading space is stripped', () => {
    expect(parse(['data:  two\n\n', 'data:none\n\n', 'data:\ttab\n\n'])).toEqual([
      { type: 'message', data: ' two' },
      { type: 'message', data: 'none' },
      { type: 'message', data: '\ttab' },
    ]);
  });

  it('the value keeps colons', () => {
    expect(parse(['event: a:b\ndata: {"k":"v:w"}\n\n'])).toEqual([{ type: 'a:b', data: '{"k":"v:w"}' }]);
  });

  it('the last event field wins; an empty event field means message', () => {
    expect(parse(['event: a\nevent: b\ndata: x\n\n', 'event:\ndata: y\n\n'])).toEqual([
      { type: 'b', data: 'x' },
      { type: 'message', data: 'y' },
    ]);
  });

  it('a leading byte order mark is ignored, once', () => {
    expect(parse(['\uFEFFdata: x\n\n'])).toEqual([{ type: 'message', data: 'x' }]);
    expect(parse(['\uFEFF', 'data: x\n\n'])).toEqual([{ type: 'message', data: 'x' }]);
  });
});

describe('an unfinished final event is not emitted', () => {
  it('data with no blank line', () => {
    expect(parse(['event: line\ndata: x\n'])).toEqual([]);
  });

  it('data with no newline at all', () => {
    expect(parse(['event: line\ndata: x'])).toEqual([]);
  });

  it('complete events before it are emitted, the unfinished tail is not', () => {
    expect(parse(['data: a\n\ndata: b\n\ndata: c\nevent: z'])).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
    ]);
  });

  it('a final event ended by a CR alone still needs its blank line', () => {
    expect(parse(['data: a\r'])).toEqual([]);
    expect(parse(['data: a\r\r'])).toEqual([{ type: 'message', data: 'a' }]);
  });

  it('the rest of an event arriving in a later push completes it', () => {
    const out: Ev[] = [];
    const p = createSseParser((e) => out.push(e));
    p.push('data: a\n');
    expect(out).toEqual([]);
    p.push('\n');
    expect(out).toEqual([{ type: 'message', data: 'a' }]);
  });
});

describe('oversize events and a throwing handler', () => {
  it('a data line over the limit is dropped, and the next event still parses', () => {
    const big = 'x'.repeat(2000);
    expect(parse([`data: ${big}\n\ndata: ok\n\n`], { maxEventChars: 1000 })).toEqual([{ type: 'message', data: 'ok' }]);
  });

  it('an event whose lines add up over the limit is dropped, and the next one parses', () => {
    const lines = Array.from({ length: 20 }, () => `data: ${'y'.repeat(100)}\n`).join('');
    expect(parse([`${lines}\ndata: ok\n\n`], { maxEventChars: 1000 })).toEqual([{ type: 'message', data: 'ok' }]);
  });

  it('a never-ending line with no newline holds no memory and recovers at the next newline', () => {
    const out: Ev[] = [];
    const p = createSseParser((e) => out.push(e), { maxEventChars: 100 });
    for (let i = 0; i < 100; i += 1) p.push('z'.repeat(1000));
    p.push('\n\ndata: ok\n\n');
    expect(out).toEqual([{ type: 'message', data: 'ok' }]);
  });

  it('an event exactly at the limit is kept', () => {
    expect(parse([`data: ${'a'.repeat(100)}\n\n`], { maxEventChars: 100 })).toEqual([{ type: 'message', data: 'a'.repeat(100) }]);
  });

  it('the default limit passes a 64 KiB event and drops a megabyte', () => {
    expect(parse([`data: ${'a'.repeat(64 * 1024)}\n\n`])).toHaveLength(1);
    expect(parse([`data: ${'a'.repeat(1024 * 1024)}\n\ndata: ok\n\n`])).toEqual([{ type: 'message', data: 'ok' }]);
  });

  it('an oversize event split into many chunks is dropped too', () => {
    const out: Ev[] = [];
    const p = createSseParser((e) => out.push(e), { maxEventChars: 500 });
    p.push('data: ');
    for (let i = 0; i < 50; i += 1) p.push('q'.repeat(100));
    p.push('\n\ndata: ok\n\n');
    expect(out).toEqual([{ type: 'message', data: 'ok' }]);
  });

  it('state is consistent after the handler throws: the next event is clean', () => {
    const out: Ev[] = [];
    let first = true;
    const p = createSseParser((e) => {
      if (first) {
        first = false;
        throw new Error('handler');
      }
      out.push(e);
    });
    expect(() => p.push('event: a\ndata: 1\n\n')).toThrow('handler');
    p.push('data: 2\n\n');
    expect(out).toEqual([{ type: 'message', data: '2' }]);
  });
});

describe('an oversize line costs only itself', () => {
  const opts = { maxEventChars: 1000 };
  const big = 'x'.repeat(5000);

  it('an oversize comment line, then two valid events: both arrive', () => {
    expect(parse([`: ${big}\n\ndata: a\n\ndata: b\n\n`], opts)).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
    ]);
  });

  it('an oversize comment line with no blank line after it does not spoil the event that follows', () => {
    expect(parse([`: ${big}\ndata: a\n\ndata: b\n\n`], opts)).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
    ]);
  });

  it('an oversize id, retry or unknown field is dropped alone', () => {
    for (const name of ['id', 'retry', 'zzz']) expect(parse([`${name}: ${big}\ndata: a\n\n`], opts), name).toEqual([{ type: 'message', data: 'a' }]);
  });

  it('an oversize comment arriving in many chunks is dropped alone', () => {
    const out: Ev[] = [];
    const p = createSseParser((e) => out.push(e), opts);
    p.push(': ');
    for (let i = 0; i < 50; i += 1) p.push('q'.repeat(100));
    p.push('\ndata: a\n\ndata: b\n\n');
    expect(out).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
    ]);
  });

  it('an oversize data line drops its event (the data is gone) and the next two parse', () => {
    expect(parse([`event: line\ndata: ${big}\n\ndata: a\n\ndata: b\n\n`], opts)).toEqual([
      { type: 'message', data: 'a' },
      { type: 'message', data: 'b' },
    ]);
  });

  it('an oversize event line drops its event and the next one parses', () => {
    expect(parse([`event: ${big}\ndata: lost\n\ndata: a\n\n`], opts)).toEqual([{ type: 'message', data: 'a' }]);
  });

  it('a 300 000 character comment, then two valid events at the default limit', () => {
    expect(parse([`: ${'c'.repeat(300_000)}\n\ndata: 1\n\ndata: 2\n\n`])).toEqual([
      { type: 'message', data: '1' },
      { type: 'message', data: '2' },
    ]);
  });
});

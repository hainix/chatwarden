import { describe, expect, it } from 'vitest';
import { readBoundedText } from '../src/internal/boundedText.js';

// K5 review (K5d minor 5): an answer from an outside host is read with a byte cap, never buffered whole first.

/** A response whose body is `chunks`, counting how many bytes were pulled from it. */
function counting(chunks: Uint8Array[], headers: Record<string, string> = {}, endless = false) {
  const state = { pulled: 0, cancelled: false };
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = endless ? (chunks[0] as Uint8Array) : chunks[i++];
      if (chunk === undefined) return controller.close();
      state.pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: new Response(body, { status: 200, headers }), state };
}
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('readBoundedText', () => {
  it('reads a small body whole, in any chunking', async () => {
    const { res } = counting([bytes('{"a"'), bytes(':1}')]);
    expect(await readBoundedText(res, 100)).toBe('{"a":1}');
  });

  it('a body of exactly the cap is read; one byte more is null', async () => {
    expect(await readBoundedText(counting([bytes('x'.repeat(10))]).res, 10)).toBe('x'.repeat(10));
    expect(await readBoundedText(counting([bytes('x'.repeat(11))]).res, 10)).toBeNull();
  });

  it('an empty or absent body is an empty string', async () => {
    expect(await readBoundedText(new Response(null, { status: 200 }), 10)).toBe('');
    expect(await readBoundedText(new Response('', { status: 200 }), 10)).toBe('');
  });

  it('a content-length over the cap is null without pulling the body, and the body is cancelled', async () => {
    const { res, state } = counting([bytes('x'.repeat(50))], { 'content-length': '5000' });
    expect(await readBoundedText(res, 100)).toBeNull();
    expect(state.pulled).toBe(0);
    expect(state.cancelled).toBe(true);
  });

  it('a lying content-length and an endless body stop at the cap: only a bounded number of bytes is pulled', async () => {
    const { res, state } = counting([bytes('y'.repeat(64))], { 'content-length': '10' }, true);
    expect(await readBoundedText(res, 200)).toBeNull();
    expect(state.pulled).toBeLessThanOrEqual(200 + 64 * 2);
    expect(state.cancelled).toBe(true);
  });

  it('an endless body with no content-length is cut at the cap', async () => {
    const { res, state } = counting([bytes('z'.repeat(1000))], {}, true);
    expect(await readBoundedText(res, 4096)).toBeNull();
    expect(state.pulled).toBeLessThanOrEqual(4096 + 2000);
    expect(state.cancelled).toBe(true);
  });

  it('counts bytes, not characters: multibyte text over the cap is null', async () => {
    const text = '\u00e9'.repeat(10); // 20 bytes
    expect(await readBoundedText(counting([bytes(text)]).res, 19)).toBeNull();
    expect(await readBoundedText(counting([bytes(text)]).res, 20)).toBe(text);
  });

  it('a multibyte character split across chunks decodes whole', async () => {
    const all = bytes('\u00e9\u20ac');
    const { res } = counting([all.slice(0, 1), all.slice(1, 3), all.slice(3)]);
    expect(await readBoundedText(res, 100)).toBe('\u00e9\u20ac');
  });

  it('bad bytes do not throw', async () => {
    const out = await readBoundedText(counting([new Uint8Array([0xff, 0xfe, 0x41])]).res, 10);
    expect(typeof out).toBe('string');
  });

  it('a junk content-length is ignored and the stream decides', async () => {
    for (const cl of ['abc', '-5', '1e9', '']) {
      const { res } = counting([bytes('ok')], { 'content-length': cl });
      expect(await readBoundedText(res, 10), cl).toBe('ok');
    }
  });

  it('a stream that errors rejects (the caller treats it as a failed attempt)', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError('network down'));
      },
    });
    await expect(readBoundedText(new Response(body), 10)).rejects.toBeInstanceOf(TypeError);
  });
});

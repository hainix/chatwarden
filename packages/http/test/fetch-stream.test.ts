import { describe, expect, it } from 'vitest';
import type { Logger } from '@chatwarden/core';
import { toFetch } from '../src/fetch.js';
import type { RouteTable } from '../src/router.js';
import type { KitResponse } from '../src/types.js';

type Sink = { write(chunk: string): boolean; end(): void };

const req = (path: string, init: RequestInit = {}): Request => new Request(`http://game.example.invalid${path}`, init);
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A stream route whose `start` is the test's, and what it was given. */
function streamRoute(
  start: (sink: Sink) => (() => void) | void,
  over: Partial<KitResponse> = {},
): { table: RouteTable; starts: () => number; sinks: Sink[] } {
  const sinks: Sink[] = [];
  let starts = 0;
  const table: RouteTable = {
    'GET /stream': () => ({
      status: 200,
      body: undefined,
      ...over,
      stream: {
        start: (sink) => {
          starts += 1;
          sinks.push(sink);
          return start(sink) as () => void;
        },
      },
    }),
  };
  return { table, starts: () => starts, sinks };
}

const decoder = new TextDecoder();
async function readAll(res: Response): Promise<string> {
  return res.text();
}

describe('the stream response', () => {
  it('the first chunk arrives before the stream ends and the default headers are present, a route\'s own winning', async () => {
    let end: () => void = () => {};
    const { table, sinks } = streamRoute((sink) => {
      sink.write('event: hello\n\n');
      end = () => sink.end();
    });
    const res = await toFetch({ '': table })(req('/stream'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(decoder.decode(first.value)).toBe('event: hello\n\n');
    // The stream is still open: the sink has not ended it.
    let settled = false;
    const next = reader.read().then((r) => ((settled = true), r));
    await tick();
    expect(settled).toBe(false);
    sinks[0]!.write('data: 1\n\n');
    expect(decoder.decode((await next).value)).toBe('data: 1\n\n');
    end();
    expect((await reader.read()).done).toBe(true);
  });

  it("a route's own header wins over each default, whatever the case of its name", async () => {
    const { table } = streamRoute(() => {}, { headers: { 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'yes', 'Content-Type': 'text/plain', 'x-mine': '1' } });
    const res = await toFetch({ '': table })(req('/stream'));
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('yes');
    expect(res.headers.get('content-type')).toBe('text/plain');
    expect(res.headers.get('x-mine')).toBe('1');
    await res.body!.cancel();
  });

  it('the status the route gave is the status of the stream', async () => {
    const { table } = streamRoute(() => {}, { status: 202 });
    const res = await toFetch({ '': table })(req('/stream'));
    expect(res.status).toBe(202);
    await res.body!.cancel();
  });

  it('chunks are UTF-8 text: a multi-byte character and an empty chunk come through whole', async () => {
    const { table } = streamRoute((sink) => {
      sink.write('data: ☃ é\n\n');
      sink.write('');
      sink.write('data: 2\n\n');
      sink.end();
    });
    expect(await readAll(await toFetch({ '': table })(req('/stream')))).toBe('data: ☃ é\n\ndata: 2\n\n');
  });

  it('write returns false when desiredSize is not positive and the chunk is still queued', async () => {
    const { table, sinks } = streamRoute(() => {});
    const res = await toFetch({ '': table })(req('/stream'));
    const sink = sinks[0]!;
    // Nobody is reading: small chunks fit under the buffer, a big one fills it.
    expect(sink.write('small')).toBe(true);
    expect(sink.write('x'.repeat(40_000))).toBe(false);
    expect(sink.write('more')).toBe(false); // still accepted, still reported
    const reader = res.body!.getReader();
    let text = '';
    while (text.length < 'small'.length + 40_000 + 'more'.length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value);
    }
    expect(text).toBe(`small${'x'.repeat(40_000)}more`); // the chunk that returned false was queued, in order
    // Drained, it is writable again.
    expect(sink.write('again')).toBe(true);
    await reader.cancel();
  });

  it('a reader waiting for data makes a write succeed at once', async () => {
    const { table, sinks } = streamRoute(() => {});
    const res = await toFetch({ '': table })(req('/stream'));
    const reader = res.body!.getReader();
    const pending = reader.read();
    expect(sinks[0]!.write('hello')).toBe(true);
    expect(decoder.decode((await pending).value)).toBe('hello');
    await reader.cancel();
  });

  it('the cancel runs once on request.signal abort, once on end(), once on stream cancel, never twice, and a write after cancel returns false and throws nothing', async () => {
    // abort
    {
      let cancels = 0;
      const { table, sinks } = streamRoute(() => () => void (cancels += 1));
      const controller = new AbortController();
      const res = await toFetch({ '': table })(req('/stream', { signal: controller.signal }));
      expect(cancels).toBe(0);
      controller.abort();
      controller.abort();
      await tick();
      expect(cancels).toBe(1);
      expect(sinks[0]!.write('late')).toBe(false);
      expect(() => sinks[0]!.end()).not.toThrow();
      await res.body?.cancel().catch(() => {});
      await tick();
      expect(cancels).toBe(1);
    }
    // end()
    {
      let cancels = 0;
      const { table, sinks } = streamRoute(() => () => void (cancels += 1));
      const controller = new AbortController();
      const res = await toFetch({ '': table })(req('/stream', { signal: controller.signal }));
      sinks[0]!.write('one');
      sinks[0]!.end();
      sinks[0]!.end();
      expect(cancels).toBe(1);
      expect(sinks[0]!.write('after end')).toBe(false);
      expect(await readAll(res)).toBe('one');
      controller.abort(); // after the end, an abort does not run it again
      await tick();
      expect(cancels).toBe(1);
    }
    // the consumer cancels the stream
    {
      let cancels = 0;
      const { table, sinks } = streamRoute(() => () => void (cancels += 1));
      const res = await toFetch({ '': table })(req('/stream'));
      await res.body!.cancel();
      await res.body!.cancel().catch(() => {});
      expect(cancels).toBe(1);
      expect(sinks[0]!.write('after cancel')).toBe(false);
      expect(() => sinks[0]!.end()).not.toThrow();
      expect(cancels).toBe(1);
    }
  });

  it('end() called from inside start, before it returns its cancel, still runs that cancel once', async () => {
    let cancels = 0;
    const { table } = streamRoute((sink) => {
      sink.write('only');
      sink.end();
      return () => void (cancels += 1);
    });
    const res = await toFetch({ '': table })(req('/stream'));
    expect(await readAll(res)).toBe('only');
    expect(cancels).toBe(1);
  });

  it('a start that returns nothing (no cancel) is fine, and a cancel that throws is logged by class and never escapes', async () => {
    const logged: Array<[string, unknown]> = [];
    const logger: Logger = { warn: (event, detail) => void logged.push([event, detail]) };
    const noCancel = streamRoute(() => {});
    const res = await toFetch({ '': noCancel.table }, { logger })(req('/stream'));
    await res.body!.cancel();
    expect(logged).toEqual([]);

    const bad = streamRoute(() => () => {
      throw new RangeError('cleanup failed for 203.0.113.5');
    });
    const res2 = await toFetch({ '': bad.table }, { logger })(req('/stream'));
    await res2.body!.cancel();
    expect(logged).toEqual([['chatwarden.http_error', { error: 'RangeError' }]]);
  });

  it('HEAD on a stream route does not call start', async () => {
    const { table, starts } = streamRoute(() => () => {}, { headers: { 'x-mine': '1' } });
    const res = await toFetch({ '': table })(req('/stream', { method: 'HEAD' }));
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(starts()).toBe(0);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store, no-transform');
    expect(res.headers.get('x-mine')).toBe('1');
  });

  it('a request that is already aborted gets no start and nothing to cancel', async () => {
    let cancels = 0;
    const { table, starts } = streamRoute(() => () => void (cancels += 1));
    const controller = new AbortController();
    controller.abort();
    const res = await toFetch({ '': table })(req('/stream', { signal: controller.signal }));
    expect(starts()).toBe(0);
    expect(cancels).toBe(0);
    expect(res.status).toBe(200);
    expect(await readAll(res)).toBe('');
  });

  it("a start that throws before any chunk is the kit's 500; after one, the stream errors and releases the sink", async () => {
    const { logger, logged } = (() => {
      const l: Array<[string, unknown]> = [];
      return { logger: { warn: (event: string, detail?: unknown) => void l.push([event, detail]) } as Logger, logged: l };
    })();
    const before = streamRoute(() => {
      throw new Error('cannot subscribe: secret detail');
    });
    const failed = await toFetch({ '': before.table }, { logger })(req('/stream'));
    expect(failed.status).toBe(500);
    expect(failed.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(failed.headers.get('cache-control')).toBeNull(); // not the stream's headers
    expect(await failed.json()).toEqual({ error: 'internal' });
    expect(logged).toEqual([['chatwarden.http_error', { error: 'Error' }]]);

    // After a first chunk it is too late for a 500: the response is the stream, and the stream errors.
    logged.length = 0;
    const after = streamRoute((sink) => {
      sink.write('first\n\n');
      throw new Error('then it broke');
    });
    const res = await toFetch({ '': after.table }, { logger })(req('/stream'));
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe('first\n\n');
    await expect(reader.read()).rejects.toThrow();
    expect(logged).toEqual([['chatwarden.http_error', { error: 'Error' }]]);
    expect(after.sinks[0]!.write('late')).toBe(false); // the sink is done: the stream was errored and released
  });

  it('a stream with a start that is not a function is the kit 500', async () => {
    const table: RouteTable = { 'GET /stream': () => ({ status: 200, body: undefined, stream: {} as never }) };
    const res = await toFetch({ '': table })(req('/stream'));
    expect(res.status).toBe(500);
  });

  it('the body of the stream response is ignored: a route that sets both is a stream', async () => {
    const { table } = streamRoute((sink) => void sink.end(), { body: { ignored: true } });
    expect(await readAll(await toFetch({ '': table })(req('/stream')))).toBe('');
  });

  it('mounts and prefixes apply to stream routes like any other', async () => {
    const { table } = streamRoute((sink) => {
      sink.write('ok');
      sink.end();
    });
    expect(await readAll(await toFetch({ '/chat': table }, { prefix: '/chatwarden' })(req('/chatwarden/chat/stream')))).toBe('ok');
  });
});

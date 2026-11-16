// Helpers shared by the recipe run tests: the environment the generated code reads, and a reader for the chat's event stream.
// Synthetic terms only: the blocked word below is the first word of the kit's synthetic term pack.

/** A staff token long enough for the starter (at least 24 characters). Not a real credential. */
export const LONG_TOKEN = 'tarvo-staff-token-0123456789-abcdef';
export const SECRET = 'vlemmo-test-secret-0123456789-0123456789-abcdef';
export const BLOCKED_WORD = 'zorbak';
export const ROOM = 'lobby';

export const keyOf = (name: string): string => `snerp-key-${name}-0001-secret`;

/** Set environment variables for a test file and put them back afterwards. `undefined` removes one. */
export function withEnv(values: Record<string, string | undefined>): () => void {
  const before: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    before[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

/** What `fetch` is for the tests: a real fetch against a server, or a call into the exported handlers. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type Frame = Record<string, unknown>;

/** An open event stream: everything it has received, as text, and the frames in order. */
export interface Listening {
  text(): string;
  frames(): Frame[];
  until(predicate: (frames: Frame[]) => boolean, ms?: number): Promise<void>;
  status: number;
  headers: Headers;
  /** Abort the request (the client leaves). */
  stop(): void;
}

export async function listen(fetchFn: FetchFn, url: string, headers: Record<string, string>): Promise<Listening> {
  const controller = new AbortController();
  const res = await fetchFn(url, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal });
  let text = '';
  const waiters: Array<() => void> = [];
  void (async () => {
    try {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        for (const wake of waiters.splice(0)) wake();
      }
    } catch {
      // the client left
    }
  })();
  const frames = (): Frame[] => [...text.matchAll(/^data: (.*)$/gm)].map((m) => JSON.parse(m[1] as string) as Frame);
  const until = async (predicate: (frames: Frame[]) => boolean, ms = 3000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!predicate(frames())) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${text.slice(0, 400)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  };
  return { text: () => text, frames, until, status: res.status, headers: res.headers, stop: () => controller.abort() };
}

export const hasHello = (frames: Frame[]): boolean => frames.some((f) => f.type === 'hello');

/** Wait a little, for "nothing arrives" checks. */
export const settle = (ms = 150): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

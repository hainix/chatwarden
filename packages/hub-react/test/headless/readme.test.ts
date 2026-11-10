// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { describe, expect, it } from 'vitest';
import * as headless from '../../src/headless/index.js';
import { personTag } from '../../src/format.js';
import { routerTransport } from '../../src/transport.js';
import { hubWorld } from '../world.js';
import { settle } from './kit.js';

// The README's headless example is compiled by scripts/readme.test.ts. Here it is RUN, as written, on the real routes: the page it
// shows is the page that works. Only the import line and the transport are swapped for the test's own.

const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');
const section = readme.slice(readme.indexOf('\n## Headless (any framework)\n'));
const snippet = /```ts\n([\s\S]*?)```/.exec(section)?.[1] ?? '';

describe('the README headless example', () => {
  it('is in the README, under its own heading, importing from the headless subpath', () => {
    expect(readme).toMatch(/\n## Headless \(any framework\)\n/);
    expect(snippet.startsWith("import { createHubClient, createHubController, fetchTransport, personTag } from '@chatwarden/hub-react/headless';")).toBe(true);
    for (const call of ['createHubController(', 'controller.start()', 'controller.queue.subscribe(', 'controller.open(', 'controller.decide(', 'controller.undo(', 'controller.dispose()']) {
      expect(snippet, call).toContain(call);
    }
  });

  it('runs: lists the case, opens it, decides it, undoes it, and disposes', async () => {
    const w = await hubWorld();
    const a = await w.file({ target: 'Alpha' });
    const js = (await transform(snippet, { loader: 'ts', format: 'esm', target: 'es2022' })).code
      .replace(/^import .*$/m, 'const { createHubClient, createHubController, fetchTransport, personTag } = H;')
      .replace(/fetchTransport\(\{ baseUrl: ["']\/admin["'] \}\)/, 'T');
    expect(js).not.toContain('fetchTransport(');
    const logs: unknown[][] = [];
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<void>;
    const run = new AsyncFunction('H', 'T', 'console', js);
    const transport = routerTransport(w.handle);
    await run(headless, transport, { log: (...args: unknown[]) => logs.push(args) });
    // The list, as drawn (the first line is the queue as it loaded; its text names the person by tag).
    const drawn = logs.flatMap((l) => (Array.isArray(l[0]) ? (l[0] as unknown[]) : [])).filter((x): x is string => typeof x === 'string');
    expect(drawn).toContain(`${personTag(a.person)}: 1 open`);
    expect(logs).toContainEqual([{ status: 'undone' }]);
    // The Undo toast was shown, and nothing was decided.
    expect(drawn.some((t) => t.startsWith('Sending the decision on'))).toBe(true);
    expect(w.sent.filter((r) => /decide$/.test(r.path))).toHaveLength(0);
    expect((await w.client.getReport(a.id)).report.status).toBe('open');
    // Disposing let the claim go.
    await settle();
    expect((await w.client.getReport(a.id)).claim).toBeNull();
  });
});

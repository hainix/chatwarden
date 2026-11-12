// Proof that the kit runs in a browser: core + matcher (with the synthetic pack) + store-memory are bundled by esbuild for
// `platform: 'browser'`, built from the packages' dist through their package exports exactly as a consumer's bundler would,
// and the result runs in a vm context that has only browser-like globals (no process, Buffer, require or module).
//
// Needs the packages built (`npm run build`; CI's check job builds in `check:pack` before `npm test`).
//
// Two builds of the same entry (scripts/browser-entry.ts, same options, no externals):
//   - ESM, unminified: the shipped shape. Scanned for Node specifiers, and the guarded `process.getBuiltinModule` lookup.
//   - IIFE (global name `CW`), minified: what runs in the vm, and what the size is measured on. An ES module would need
//     `vm.SourceTextModule`, which needs `node --experimental-vm-modules` on the vitest worker (a repo-wide config change
//     for one test); a classic script runs cleanly on Node 22.13 and 24 with no flag and is the same code in a different wrapper.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build, type BuildOptions, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeHasher } from '@chatwarden/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = fileURLToPath(new URL('./browser-entry.ts', import.meta.url));
// 109 KB: the bundle measured 100.4 KB gzip before the chat box's server side (`@chatwarden/http/chat`: broadcaster, routes, wire) joined the
// entry, and 106.3 KB with it (it adds 5.9 KB). The headroom is about 2.7 KB for the hub controller work that shares this entry.
const SIZE_BUDGET_GZIP = 109 * 1024;

const common: BuildOptions = {
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'browser',
  write: false,
  logLevel: 'silent',
  absWorkingDir: ROOT,
  metafile: true,
  // Nothing is external: a Node builtin that slipped in must fail the build, not be left as a dangling import.
  external: [],
};

let esm = '';
let iife = '';
let metafile: Metafile;

beforeAll(async () => {
  for (const pkg of ['core', 'matcher', 'store-memory', 'http']) {
    if (!existsSync(`${ROOT}packages/${pkg}/dist/src/index.js`)) throw new Error(`packages/${pkg} is not built: run \`npm run build\` first`);
  }
  if (!existsSync(`${ROOT}packages/hub-react/dist/src/headless/index.js`)) throw new Error('packages/hub-react is not built: run `npm run build` first');
  const a = await build({ ...common, format: 'esm' });
  esm = a.outputFiles[0]!.text;
  const b = await build({ ...common, format: 'iife', globalName: 'CW', minify: true });
  iife = b.outputFiles[0]!.text;
  metafile = b.metafile;
}, 60_000);

describe('browser bundle: static scan', () => {
  it('resolved the workspace packages through their built dist', () => {
    const inputs = Object.keys(metafile.inputs);
    for (const pkg of ['core', 'matcher', 'store-memory', 'http']) {
      expect(inputs.some((p) => p.replaceAll('\\', '/').startsWith(`packages/${pkg}/dist/src/`))).toBe(true);
    }
    expect(inputs.some((p) => p.replaceAll('\\', '/').startsWith('packages/matcher/dist/src/fixtures/'))).toBe(true);
    expect(inputs).toContain('scripts/browser-entry.ts'); // the entry itself
  });

  it('bundles @chatwarden/hub-react/headless from its own entry, and no React, no .tsx, no stylesheet', () => {
    const inputs = Object.keys(metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(inputs).toContain('packages/hub-react/dist/src/headless/index.js');
    expect(inputs).toContain('packages/hub-react/dist/src/headless/controller.js');
    // The React hub is not in it: nothing from the entry's own file, none of its components, and no React package at all.
    for (const reactSide of ['index', 'Hub', 'context', 'controllerContext', 'hooks', 'toasts', 'decisions', 'cases', 'liveQueue']) {
      expect(inputs, reactSide).not.toContain(`packages/hub-react/dist/src/${reactSide}.js`);
    }
    expect(inputs.filter((p) => /node_modules\/(react|react-dom|scheduler)\//.test(p))).toEqual([]);
    expect(inputs.filter((p) => /\.(tsx|css)$/.test(p))).toEqual([]);
  });

  it('bundles @chatwarden/http/admin from its own entry, and none of the Node-side http modules', () => {
    const inputs = Object.keys(metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(inputs).toContain('packages/http/dist/src/admin-entry.js');
    expect(inputs).toContain('packages/http/dist/src/admin/index.js');
    for (const nodeSide of ['index', 'player', 'express', 'webhooks/in', 'webhooks/out', 'webhooks/sign', 'webhooks/fingerprint']) {
      expect(inputs, nodeSide).not.toContain(`packages/http/dist/src/${nodeSide}.js`);
    }
  });

  it('bundles @chatwarden/http/chat from its own entry, and none of the Node-side http modules', () => {
    const inputs = Object.keys(metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    for (const file of ['chat/index', 'chat/broadcaster', 'chat/routes', 'chat/sse', 'chat/wire', 'chat/history', 'chat/random', 'limiter']) {
      expect(inputs, file).toContain(`packages/http/dist/src/${file}.js`);
    }
    for (const nodeSide of ['index', 'player', 'express', 'health', 'webhooks/in', 'webhooks/out', 'webhooks/sign', 'webhooks/fingerprint']) {
      expect(inputs, nodeSide).not.toContain(`packages/http/dist/src/${nodeSide}.js`);
    }
  });

  it('has no node: import or export specifier', () => {
    expect(esm).not.toMatch(/\b(?:from|import)\s*\(?\s*["']node:/);
    expect(esm).not.toMatch(/\bexport\s*\*?\s*(?:\{[^}]*\}\s*)?from\s*["']node:/);
  });

  it('has no require, in either build', () => {
    expect(esm).not.toMatch(/\brequire\b/);
    expect(iife).not.toMatch(/\brequire\b/);
  });

  it('mentions node: only as the argument of the guarded process.getBuiltinModule lookup', () => {
    const leftover = esm.replaceAll(/\?\.getBuiltinModule\?\.\(\s*["']node:crypto["']\s*\)/g, '');
    expect(leftover).not.toContain('node:');
    expect(iife.replaceAll(/\?\.getBuiltinModule\?\.\(\s*["']node:crypto["']\s*\)/g, '')).not.toContain('node:');
  });

  it('only ever calls getBuiltinModule through optional chaining, inside a try', () => {
    const calls = [...esm.matchAll(/getBuiltinModule/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) {
      expect(esm.slice(m.index! - 2, m.index! + 'getBuiltinModule?.('.length)).toBe('?.getBuiltinModule?.(');
    }
    const at = esm.indexOf('getBuiltinModule');
    const before = esm.slice(Math.max(0, at - 600), at);
    expect(before.lastIndexOf('try')).toBeGreaterThan(before.lastIndexOf('}\n'));
  });

  it('has no bare reference to process, Buffer or module outside the guarded lookup', () => {
    const code = esm.replaceAll(/\/\/.*$/gm, '').replaceAll(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\bBuffer\b/);
    expect(code).not.toMatch(/\bmodule\.exports\b/);
    // The one reference is `globalThis.process`, read into a local that is then only used as `proc?.getBuiltinModule?.(...)`.
    const procRefs = [...code.matchAll(/\bprocess\b/g)].filter((m) => !code.slice(m.index! - 11).startsWith('globalThis.process'));
    expect(procRefs.map((m) => code.slice(m.index! - 40, m.index! + 40))).toEqual([]);
  });
});

// The matcher builds its own word list from the term pack. obscenity's ready-made English list (a real slur list) must never ride along
// into a page. The markers are NOT slurs: export names of obscenity's English preset module, and a few harmless words from its
// whitelist, so they can only come from that module being in the bundle. `preset module still holds the markers` guards the test
// itself: if obscenity renames or drops one, this fails instead of the absence checks passing for nothing.
const PRESET_MARKERS = ['englishDataset', 'englishRecommendedTransformers', 'englishRecommendedBlacklistMatcherTransformers', 'analagous', 'dickory', 'benedick', 'cockney'];

describe('browser bundle: no third-party word list', () => {
  it('the preset module still holds the markers (guard for the checks below)', () => {
    const entry = createRequire(import.meta.url).resolve('obscenity');
    const preset = readFileSync(entry.replace(/index\.js$/, 'preset/english.js'), 'utf8');
    for (const marker of PRESET_MARKERS) expect(preset, marker).toContain(marker);
  });

  it('bundles no file of obscenity, and in particular not its English preset', () => {
    const inputs = Object.keys(metafile.inputs).map((p) => p.replaceAll('\\', '/'));
    expect(inputs.filter((p) => /node_modules\/obscenity\//.test(p))).toEqual([]);
    expect(inputs.filter((p) => /preset\/english/.test(p))).toEqual([]);
  });

  it.each(PRESET_MARKERS)('has no trace of %s, in either build', (marker) => {
    // A boolean, so a failure never prints the bundle (which, while the list is in it, holds the list).
    expect(esm.includes(marker)).toBe(false);
    expect(iife.includes(marker)).toBe(false);
  });
});

describe('browser bundle: size', () => {
  it('is under the landing-page budget (gzip, minified)', () => {
    const gz = gzipSync(iife, { level: 9 }).length;
    const raw = Buffer.byteLength(iife);
    console.log(`browser bundle: ${(raw / 1024).toFixed(1)} KB minified, ${(gz / 1024).toFixed(1)} KB gzip`);
    if (gz > SIZE_BUDGET_GZIP) {
      const top = Object.entries(Object.values(metafile.outputs)[0]!.inputs)
        .map(([file, v]) => [file, v.bytesInOutput] as const)
        .sort((x, y) => y[1] - x[1])
        .slice(0, 12)
        .map(([f, n]) => `${n} ${f}`);
      throw new Error(`bundle is ${gz} bytes gzip, over ${SIZE_BUDGET_GZIP}. Top contributors:\n${top.join('\n')}`);
    }
    expect(gz).toBeLessThanOrEqual(SIZE_BUDGET_GZIP);
  });
});

/** A fresh context with browser-like globals only. */
function browserContext(): Record<string, unknown> {
  const logs: string[] = [];
  const sandbox = {
    crypto: webcrypto,
    TextEncoder,
    TextDecoder,
    URL,
    console: { log: (...a: unknown[]) => logs.push(a.join(' ')), warn: (...a: unknown[]) => logs.push(a.join(' ')), error: (...a: unknown[]) => logs.push(a.join(' ')) },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    structuredClone,
  };
  return createContext(sandbox) as Record<string, unknown>;
}

const run = <T>(ctx: Record<string, unknown>, code: string): T => runInContext(code, ctx, { filename: 'browser-bundle-test.js' }) as T;

// The scenario, run inside the context against the bundle's global `CW`. Returns JSON text so nothing crosses the realm
// boundary by reference.
const SCENARIO = `(async () => {
  const { createChatwarden, makeHasher } = CW.core;
  const { LiveTerms } = CW.matcher;
  const { syntheticTermPack, MemoryTermStore } = CW.fixtures;
  const { MemoryStore } = CW.storeMemory;
  const R = 'room';
  const clock = { now: () => Date.now() };
  const terms = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock, logger: { warn() {} } });
  await terms.load();
  const out = {};
  // No hasher override, no process: the pure-JS HMAC path.
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'browser-secret', platform: { identify: (ctx) => ctx }, matcher: terms, clock });
  const alice = { clientKey: 'key-alice', ip: '198.51.100.1' };
  const bob = { clientKey: 'key-bob', ip: '198.51.100.2' };
  const carol = { clientKey: 'key-carol', ip: '198.51.100.3' };
  cw.rooms.seat(R, 'a', alice, 'Alice');
  cw.rooms.seat(R, 'b', bob, 'Bob');
  cw.rooms.seat(R, 'c', carol, 'Carol');
  out.seated = [cw.rooms.subjectAt(R, 'a'), cw.rooms.subjectAt(R, 'b'), cw.rooms.subjectAt(R, 'c')].every((s) => typeof s === 'string' && /^s_/.test(s));
  const clean = cw.chat.accept(R, 'a', 'hello there');
  out.clean = clean.deliver ? clean.deliver.text : null;
  out.refused = cw.chat.accept(R, 'a', 'you zorbak');
  cw.chat.accept(R, 'b', 'bob line');
  const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  out.reported = res.ok;
  const report = cw.reports.get(res.reportId);
  const own = report.excerpt.filter((l) => l.seatId === 'a').map((l) => l.lineId);
  const subject = cw.rooms.subjectAt(R, 'a');
  const decided = await cw.decide({
    reportId: res.reportId,
    verdict: 'upheld',
    actor: 'mod@example.test',
    reason: 'private reason text',
    actions: [{ subject, kind: 'warning', durationMs: null, rule: 2, lineIds: own }],
  });
  out.decided = decided.ok;
  const pending = cw.notices.pending(alice);
  out.pending = pending.map((n) => ({ id: n.id, kind: n.kind, rule: n.rule, mustAcknowledge: n.mustAcknowledge, excerpt: n.excerpt.map((l) => l.text) }));
  out.warningPending = cw.notices.pendingWarning(alice);
  out.ackOther = cw.notices.ack(bob, pending[0].id);
  out.ack = cw.notices.ack(alice, pending[0].id);
  out.after = cw.notices.pending(alice).length;
  out.warningAfter = cw.notices.pendingWarning(alice);
  const h = makeHasher('browser-secret');
  out.hashes = ['', 'key-alice', 'x'.repeat(200), 'h\\u00e9llo \\u{1F600}'].map((s) => [h.clientKey(s), h.ip(s)]);
  return JSON.stringify(out);
})()`;

// The staff API, run in the context through `CW.httpAdmin`: the same routes the hub talks to, over the in-memory store.
const ADMIN_SCENARIO = `(async () => {
  const { createChatwarden } = CW.core;
  const { MemoryStore } = CW.storeMemory;
  const { adminRoutes, createRouter } = CW.httpAdmin;
  const R = 'room';
  const clock = { now: () => Date.now() };
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'admin-secret', platform: { identify: (ctx) => ctx }, clock });
  cw.rooms.seat(R, 'a', { clientKey: 'key-alice', ip: '198.51.100.1' }, 'Alice');
  cw.rooms.seat(R, 'b', { clientKey: 'key-bob', ip: '198.51.100.2' }, 'Bob');
  cw.chat.accept(R, 'a', 'hello there');
  const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  const handle = createRouter(adminRoutes(cw, { authorize: (req) => (req.headers['x-role'] ? { actor: 'demo-mod', role: req.headers['x-role'] } : null) }));
  const call = async (method, path, role, body, raw) => {
    const rawBody = raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body);
    const r = await handle({ method, path, query: {}, headers: role ? { 'x-role': role } : {}, body: undefined, ...(rawBody === undefined ? {} : { rawBody }) });
    return { status: r.status, body: r.body };
  };
  const out = { noBuffer: typeof Buffer };
  out.me = await call('GET', '/me', 'owner');
  out.meMod = await call('GET', '/me', 'moderator');
  out.anon = await call('GET', '/me', null);
  out.reports = await call('GET', '/reports', 'moderator');
  const report = cw.reports.get(res.reportId);
  const own = report.excerpt.filter((l) => l.seatId === 'a').map((l) => l.lineId);
  const decision = { verdict: 'upheld', reason: 'r', actions: [{ subject: cw.rooms.subjectAt(R, 'a'), kind: 'warning', durationMs: null, rule: 2, lineIds: own }] };
  out.decided = await call('POST', '/reports/' + res.reportId + '/decide', 'moderator', decision);
  out.replay = await call('POST', '/reports/' + res.reportId + '/decide', 'moderator', decision);
  const pad = (filler) => '{"pad":"' + filler + '"}';
  const bytes = (s) => new TextEncoder().encode(s).length;
  const atLimit = pad('x'.repeat(65536 - 10));
  const overAscii = pad('x'.repeat(65536 - 10 + 1));
  const overEuro = pad('\\u20ac'.repeat(21842) + 'x');
  const overAstral = pad('\\u{1F600}'.repeat(16381) + 'xxx');
  if (bytes(atLimit) !== 65536 || bytes(overAscii) !== 65537 || bytes(overEuro) !== 65537 || bytes(overAstral) !== 65537) throw new Error('bad fixture');
  const status = async (raw) => (await call('POST', '/sanctions', 'owner', undefined, raw)).status;
  out.atLimit = await status(atLimit);
  out.overAscii = await status(overAscii);
  out.overEuro = await status(overEuro);
  out.overAstral = await status(overAstral);
  out.audit = await call('GET', '/audit', 'senior');
  return JSON.stringify(out);
})()`;

// The chat box's server side, run in the context through `CW.httpChat`: the real broadcaster and routes over the in-memory store,
// with no Buffer and no process. A player speaks, another hears it, a blocked line is refused to its author only.
const CHAT_SCENARIO = `(async () => {
  const { createChatwarden } = CW.core;
  const { LiveTerms } = CW.matcher;
  const { syntheticTermPack, MemoryTermStore } = CW.fixtures;
  const { MemoryStore } = CW.storeMemory;
  const { createRoomBroadcaster, chatRoutes, encodeFrame } = CW.httpChat;
  const { createRouter } = CW.httpAdmin;
  const clock = { now: () => Date.now() };
  const terms = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock, logger: { warn() {} } });
  await terms.load();
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'chat-secret', platform: { identify: (ctx) => ctx }, matcher: terms, clock });
  const chat = createRoomBroadcaster(cw, { logger: { warn() {} } });
  const out = { buffer: typeof Buffer, process: typeof process };
  const sessionOf = (name) => {
    const s = chat.session('room', { clientKey: 'key-' + name + '-aaaaaaaa', ip: '198.51.100.1' }, { name });
    if (s.refused) throw new Error('refused ' + s.refused.reason);
    return s;
  };
  const alice = sessionOf('Alice');
  const bob = sessionOf('Bob');
  const heard = [];
  bob.open({ write: (frame) => { heard.push(encodeFrame(frame)); } });
  out.hello = heard[0].split('\\n')[0];
  out.sent = alice.send({ text: 'hello there' }).ok;
  out.refused = alice.send({ text: 'you zorbak' });
  out.heardLines = heard.slice(1).map((f) => JSON.parse(f.split('\\n')[1].slice(6)).line.text);
  out.leak = heard.join('').includes('zorbak');
  out.stats = chat.stats();
  // the routes, through a router, with no HTTP server at all
  const handle = createRouter(chatRoutes(cw, chat, { identify: (req) => ({ clientKey: req.headers['x-key'] }), join: () => ({ name: 'Carol' }) }));
  const res = await handle({ method: 'POST', path: '/rooms/room/lines', query: {}, headers: { 'x-key': 'key-carol-aaaaaaaa', 'content-type': 'application/json' }, body: undefined, rawBody: '{"text":"from the routes"}' });
  out.route = { status: res.status, ok: res.body.ok, text: res.body.line && res.body.line.text };
  const form = await handle({ method: 'POST', path: '/rooms/room/lines', query: {}, headers: { 'x-key': 'key-carol-aaaaaaaa', 'content-type': 'text/plain' }, body: undefined, rawBody: '{"text":"cross site"}' });
  out.form = form.status;
  chat.close();
  return JSON.stringify(out);
})()`;

// The headless hub controller, run in the context through `CW.hubHeadless`: no document, no window, no navigator. The staff client
// talks to the real routes in the page; the controller loads the queue, takes a case, and holds and undoes a decision.
const HUB_SCENARIO = `(async () => {
  const { createChatwarden } = CW.core;
  const { MemoryStore } = CW.storeMemory;
  const { adminRoutes, createRouter } = CW.httpAdmin;
  const { createHubClient, createHubController, routerTransport } = CW.hubHeadless;
  const R = 'room';
  const clock = { now: () => Date.now() };
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'hub-secret', platform: { identify: (ctx) => ctx }, clock });
  cw.rooms.seat(R, 'a', { clientKey: 'key-alice', ip: '198.51.100.1' }, 'Alice');
  cw.rooms.seat(R, 'b', { clientKey: 'key-bob', ip: '198.51.100.2' }, 'Bob');
  cw.chat.accept(R, 'a', 'hello there');
  const res = await cw.reports.submit({ roomId: R, reporterSeat: 'b', targetSeat: 'a', category: 'harassment' });
  const handle = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'demo-mod', role: 'moderator' }) }));
  const controller = createHubController({ client: createHubClient(routerTransport(handle)) });
  const out = { document: typeof document, window: typeof window, navigator: typeof navigator };
  const started = await controller.start();
  out.started = started.ok && started.value.actor;
  const queue = controller.queue.getSnapshot();
  out.status = queue.status;
  out.cases = queue.groups.length;
  out.connection = queue.connection;
  await controller.open(res.reportId);
  out.claimedBy = controller.queue.getSnapshot().groups[0].claim && controller.queue.getSnapshot().groups[0].claim.by;
  const outcome = controller.decide({ reportId: res.reportId, person: queue.groups[0].person, input: { verdict: 'no_action', reason: 'r', actions: [] } });
  out.held = controller.decisions.entry(res.reportId).state.status;
  out.toast = controller.toasts.getSnapshot().map((t) => t.text);
  controller.undo(res.reportId);
  out.outcome = await outcome;
  controller.dispose();
  controller.dispose();
  out.disposed = controller.disposed;
  out.open = (await cw.reports.get(res.reportId)).status;
  return JSON.stringify(out);
})()`;

describe('browser bundle: runs in a context with no Node globals', () => {
  it('the context really is bare', () => {
    const ctx = browserContext();
    expect(run(ctx, `[typeof process, typeof Buffer, typeof require, typeof module, typeof exports, typeof global, typeof setImmediate].join()`)).toBe(
      'undefined,undefined,undefined,undefined,undefined,undefined,undefined',
    );
    expect(run(ctx, `typeof crypto.getRandomValues + typeof TextEncoder + typeof URL`)).toBe('functionfunctionfunction');
  });

  it('loads the bundle with only browser globals', () => {
    const ctx = browserContext();
    run(ctx, iife);
    expect(run(ctx, `Object.keys(CW).sort().join()`)).toBe('core,fixtures,httpAdmin,httpChat,hubHeadless,matcher,storeMemory');
    expect(run(ctx, `typeof CW.core.createChatwarden + typeof CW.matcher.LiveTerms + typeof CW.storeMemory.MemoryStore`)).toBe('functionfunctionfunction');
  });

  it('runs seat, chat, refusal, report, decide, notice and ack end to end', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const out = JSON.parse(await run<Promise<string>>(ctx, SCENARIO)) as {
      seated: boolean;
      clean: string | null;
      refused: unknown;
      reported: boolean;
      decided: boolean;
      pending: { id: string; kind: string; rule: number; mustAcknowledge: boolean; excerpt: string[] }[];
      warningPending: boolean;
      ackOther: boolean;
      ack: boolean;
      after: number;
      warningAfter: boolean;
    };
    expect(out.seated).toBe(true);
    expect(out.clean).toBe('hello there');
    expect(out.refused).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
    expect(out.reported).toBe(true);
    expect(out.decided).toBe(true);
    expect(out.pending).toHaveLength(1);
    const [notice] = out.pending;
    expect(notice).toMatchObject({ kind: 'warning', rule: 2, mustAcknowledge: true });
    // The excerpt shows the target their own lines with the slur masked, never the word itself.
    expect(notice!.excerpt).toEqual(['hello there', 'you ******']);
    expect(JSON.stringify(out)).not.toContain('zorbak');
    expect(JSON.stringify(out)).not.toContain('private reason text');
    expect(out.warningPending).toBe(true);
    expect(out.ackOther).toBe(false);
    expect(out.ack).toBe(true);
    expect(out.after).toBe(0);
    expect(out.warningAfter).toBe(false);
  });

  it('runs the staff API (@chatwarden/http/admin) in the context: /me, a decision, and the byte cap with no Buffer', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const out = JSON.parse(await run<Promise<string>>(ctx, ADMIN_SCENARIO)) as {
      me: { status: number; body: { actor: string; role: string; can: Record<string, boolean> } };
      meMod: { body: { can: Record<string, boolean> } };
      anon: { status: number; body: unknown };
      reports: { status: number; body: { items: { id: string }[] } };
      decided: { status: number };
      replay: { status: number; body: { ok: boolean; replay: boolean } };
      atLimit: number;
      overAscii: number;
      overEuro: number;
      overAstral: number;
      noBuffer: string;
      audit: { status: number; body: { items: { action: string }[] } };
    };
    expect(out.noBuffer).toBe('undefined');
    expect(out.me.status).toBe(200);
    expect(out.me.body.actor).toBe('demo-mod');
    expect(out.me.body.role).toBe('owner');
    expect(Object.values(out.me.body.can).every((v) => v === true)).toBe(true);
    expect(out.meMod.body.can['audit.read']).toBe(false);
    expect(out.meMod.body.can['reports.decide']).toBe(true);
    expect(out.anon.status).toBe(401);
    expect(out.reports.status).toBe(200);
    expect(out.reports.body.items).toHaveLength(1);
    expect(out.decided.status).toBe(200);
    // The same decision again is a harmless replay, not a second sanction.
    expect(out.replay.status).toBe(200);
    expect(out.replay.body).toMatchObject({ ok: true, replay: true });
    // 65536 bytes is allowed (it fails later as a bad body, 400); 65537 is 413, whatever the characters.
    expect(out.atLimit).toBe(400);
    expect([out.overAscii, out.overEuro, out.overAstral]).toEqual([413, 413, 413]);
    expect(out.audit.status).toBe(200);
    expect(out.audit.body.items.length).toBeGreaterThan(0);
  });

  it('runs the chat broadcaster and routes (@chatwarden/http/chat) in the context: a send, a refusal to its author only, a cross-site post refused, no Buffer', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const out = JSON.parse(await run<Promise<string>>(ctx, CHAT_SCENARIO)) as Record<string, unknown>;
    expect([out.buffer, out.process]).toEqual(['undefined', 'undefined']);
    expect(out.hello).toBe('event: hello');
    expect(out.sent).toBe(true);
    expect(out.refused).toEqual({ ok: false, refused: { reason: 'blocked', rule: 1 } });
    expect(out.heardLines).toEqual(['hello there']);
    expect(out.leak).toBe(false);
    expect(out.stats).toEqual({ rooms: 1, members: 2, streams: 1 });
    expect(out.route).toEqual({ status: 200, ok: true, text: 'from the routes' });
    expect(out.form).toBe(400);
  });

  it('runs the headless hub controller (@chatwarden/hub-react/headless) in the context: load, claim, hold, Undo, dispose, no DOM', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const out = JSON.parse(await run<Promise<string>>(ctx, HUB_SCENARIO)) as Record<string, unknown>;
    expect([out.document, out.window, out.navigator]).toEqual(['undefined', 'undefined', 'undefined']);
    expect(out).toMatchObject({ started: 'demo-mod', status: 'ready', cases: 1, connection: 'live', claimedBy: 'demo-mod', held: 'held', outcome: { status: 'undone' }, disposed: true, open: 'open' });
    expect(out.toast).toHaveLength(1);
    expect((out.toast as string[])[0]).toMatch(/^Sending the decision on .+ in 5 s\.$/);
  });

  it('computes the same identity hashes in the pure-JS path as the native path', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const out = JSON.parse(await run<Promise<string>>(ctx, SCENARIO)) as { hashes: [string, string][] };
    const native = makeHasher('browser-secret');
    const inputs = ['', 'key-alice', 'x'.repeat(200), 'héllo \u{1F600}'];
    expect(out.hashes).toEqual(inputs.map((s) => [native.clientKey(s), native.ip(s)]));
    expect(out.hashes.every(([a, b]) => /^[0-9a-f]{32}$/.test(a) && /^[0-9a-f]{32}$/.test(b) && a !== b)).toBe(true);
  });

  it('hashes long keys and long inputs the same in both paths', async () => {
    const ctx = browserContext();
    run(ctx, iife);
    const longKey = 'k'.repeat(300);
    const longInput = 'multi-block '.repeat(5_000);
    const inCtx = JSON.parse(
      run<string>(
        ctx,
        `(() => { const h = CW.core.makeHasher(${JSON.stringify(longKey)}); return JSON.stringify([h.clientKey(${JSON.stringify(longInput)}), h.ip(${JSON.stringify(longInput)})]); })()`,
      ),
    );
    const native = makeHasher(longKey);
    expect(inCtx).toEqual([native.clientKey(longInput), native.ip(longInput)]);
  });
});

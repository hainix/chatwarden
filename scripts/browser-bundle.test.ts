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
import { existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { build, type BuildOptions, type Metafile } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeHasher } from '@chatwarden/core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ENTRY = fileURLToPath(new URL('./browser-entry.ts', import.meta.url));
const SIZE_BUDGET_GZIP = 120 * 1024;

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
  for (const pkg of ['core', 'matcher', 'store-memory']) {
    if (!existsSync(`${ROOT}packages/${pkg}/dist/src/index.js`)) throw new Error(`packages/${pkg} is not built: run \`npm run build\` first`);
  }
  const a = await build({ ...common, format: 'esm' });
  esm = a.outputFiles[0]!.text;
  const b = await build({ ...common, format: 'iife', globalName: 'CW', minify: true });
  iife = b.outputFiles[0]!.text;
  metafile = b.metafile;
}, 60_000);

describe('browser bundle: static scan', () => {
  it('resolved the workspace packages through their built dist', () => {
    const inputs = Object.keys(metafile.inputs);
    for (const pkg of ['core', 'matcher', 'store-memory']) {
      expect(inputs.some((p) => p.replaceAll('\\', '/').startsWith(`packages/${pkg}/dist/src/`))).toBe(true);
    }
    expect(inputs.some((p) => p.replaceAll('\\', '/').startsWith('packages/matcher/dist/src/fixtures/'))).toBe(true);
    expect(inputs).toContain('scripts/browser-entry.ts'); // the entry itself
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
    expect(run(ctx, `Object.keys(CW).sort().join()`)).toBe('core,fixtures,matcher,storeMemory');
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

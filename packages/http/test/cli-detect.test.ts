import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli/args.js';
import { resolveAnswers } from '../src/cli/answers.js';
import { detect } from '../src/cli/detect.js';
import type { Detected } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World, WorldOptions } from './cli-world.js';

const pkg = (body: Record<string, unknown> = {}): string => JSON.stringify({ name: 'zorbak-game', ...body });

async function found(files: Record<string, string>, kind: PathKind = 'posix', extra: Partial<WorldOptions> = {}): Promise<{ detected: Detected; world: World }> {
  const world = createWorld({ kind, files, ...extra });
  const detected = await detect(world.env);
  if ('error' in detected) throw new Error(`expected detection, got: ${detected.error}`);
  return { detected, world };
}
async function failed(files: Record<string, string>, kind: PathKind = 'posix', extra: Partial<WorldOptions> = {}): Promise<string> {
  const world = createWorld({ kind, files, ...extra });
  const detected = await detect(world.env);
  if (!('error' in detected)) throw new Error(`expected an error, got ${JSON.stringify(detected)}`);
  expect(detected.error).not.toMatch(/\n/);
  expect(detected.error).not.toContain(world.root);
  expect(detected.error).not.toMatch(/\bat .*:\d+|node:internal/);
  expect(detected.error).toContain('package.json');
  return detected.error;
}

describe.each(['posix', 'win32'] as const)('detect (%s paths, %s root)', (kind) => {
  it('express, fastify, next (next wins over express), react, socket.io from dependencies and devDependencies', async () => {
    expect((await found({ 'package.json': pkg({ dependencies: { express: '^5.1.0' } }) }, kind)).detected.frameworks).toEqual(['express']);
    expect((await found({ 'package.json': pkg({ devDependencies: { fastify: '^5' } }) }, kind)).detected.frameworks).toEqual(['fastify']);
    expect((await found({ 'package.json': pkg({ dependencies: { next: '15' } }) }, kind)).detected.frameworks).toEqual(['next']);
    expect((await found({ 'package.json': pkg({ dependencies: { express: '5' }, devDependencies: { next: '15' } }) }, kind)).detected.frameworks).toEqual(['express', 'next']);
    expect((await found({ 'package.json': pkg({ dependencies: { next: '15', fastify: '5', express: '5' } }) }, kind)).detected.frameworks).toEqual(['express', 'fastify', 'next']);
    expect((await found({ 'package.json': pkg() }, kind)).detected.frameworks).toEqual([]);

    // Through resolveAnswers, next wins over express.
    const both = (await found({ 'package.json': pkg({ dependencies: { express: '5', next: '15' } }) }, kind)).detected;
    const parsed = parseCli(['init']);
    if ('error' in parsed) throw new Error(parsed.error);
    const resolved = resolveAnswers(parsed, both);
    expect('error' in resolved ? undefined : resolved.framework).toBe('next');

    expect((await found({ 'package.json': pkg({ dependencies: { react: '19' } }) }, kind)).detected.react).toBe(true);
    expect((await found({ 'package.json': pkg({ devDependencies: { react: '19' } }) }, kind)).detected.react).toBe(true);
    expect((await found({ 'package.json': pkg({ dependencies: { 'react-dom': '19' } }) }, kind)).detected.react).toBe(false);
    expect((await found({ 'package.json': pkg() }, kind)).detected.react).toBe(false);
    expect((await found({ 'package.json': pkg({ dependencies: { 'socket.io': '^4' } }) }, kind)).detected.socketio).toBe(true);
    expect((await found({ 'package.json': pkg({ devDependencies: { 'socket.io': '^4' } }) }, kind)).detected.socketio).toBe(true);
    // The client package alone is not a server.
    expect((await found({ 'package.json': pkg({ dependencies: { 'socket.io-client': '^4' } }) }, kind)).detected.socketio).toBe(false);
    // Only the two dependency tables count; a name in peerDependencies or scripts does not.
    expect((await found({ 'package.json': pkg({ peerDependencies: { express: '5' }, scripts: { dev: 'express' } }) }, kind)).detected.frameworks).toEqual([]);
  });

  it('pnpm-lock.yaml, yarn.lock, bun.lock, bun.lockb, package-lock.json and none give the manager', async () => {
    const manager = async (lock?: string): Promise<string> => (await found({ 'package.json': pkg(), ...(lock ? { [lock]: '' } : {}) }, kind)).detected.manager;
    expect(await manager('pnpm-lock.yaml')).toBe('pnpm');
    expect(await manager('yarn.lock')).toBe('yarn');
    expect(await manager('bun.lock')).toBe('bun');
    expect(await manager('bun.lockb')).toBe('bun');
    expect(await manager('package-lock.json')).toBe('npm');
    expect(await manager()).toBe('npm');
    // Several lockfiles: the first of pnpm, yarn, bun, npm.
    expect((await found({ 'package.json': pkg(), 'package-lock.json': '', 'pnpm-lock.yaml': '' }, kind)).detected.manager).toBe('pnpm');
    expect((await found({ 'package.json': pkg(), 'package-lock.json': '', 'yarn.lock': '' }, kind)).detected.manager).toBe('yarn');
    expect((await found({ 'package.json': pkg(), 'package-lock.json': '', 'bun.lockb': '' }, kind)).detected.manager).toBe('bun');
    // A lockfile name inside another folder is not the root's.
    expect((await found({ 'package.json': pkg(), 'sub/pnpm-lock.yaml': '' }, kind)).detected.manager).toBe('npm');
  });

  it('tsconfig.json present means ts, absent means js', async () => {
    expect((await found({ 'package.json': pkg(), 'tsconfig.json': '{}' }, kind)).detected.ts).toBe(true);
    expect((await found({ 'package.json': pkg() }, kind)).detected.ts).toBe(false);
    expect((await found({ 'package.json': pkg(), 'tsconfig.build.json': '{}' }, kind)).detected.ts).toBe(false);
    // An unparsable tsconfig (comments, trailing commas) is still a TypeScript project: it is never read.
    expect((await found({ 'package.json': pkg(), 'tsconfig.json': '{ // comment\n "a": 1, }' }, kind)).detected.ts).toBe(true);
  });

  it('"type": "module" and its absence', async () => {
    expect((await found({ 'package.json': pkg({ type: 'module' }) }, kind)).detected.moduleType).toBe('module');
    expect((await found({ 'package.json': pkg() }, kind)).detected.moduleType).toBe('commonjs');
    expect((await found({ 'package.json': pkg({ type: 'commonjs' }) }, kind)).detected.moduleType).toBe('commonjs');
    expect((await found({ 'package.json': pkg({ type: 'MODULE' }) }, kind)).detected.moduleType).toBe('commonjs');
    expect((await found({ 'package.json': pkg({ type: 5 }) }, kind)).detected.moduleType).toBe('commonjs');
  });

  it('src/ present moves the default dir', async () => {
    const withSrc = (await found({ 'package.json': pkg(), 'src/index.ts': '' }, kind)).detected;
    expect(withSrc.srcDir).toBe(true);
    const parsed = parseCli(['init']);
    if ('error' in parsed) throw new Error(parsed.error);
    const resolved = resolveAnswers(parsed, withSrc);
    expect('error' in resolved ? undefined : resolved.dir).toBe('src/chatwarden');
    const without = (await found({ 'package.json': pkg() }, kind)).detected;
    expect(without.srcDir).toBe(false);
    const resolvedWithout = resolveAnswers(parsed, without);
    expect('error' in resolvedWithout ? undefined : resolvedWithout.dir).toBe('chatwarden');
    // A folder called src that is empty still counts (the listing is all that is read).
    expect((await found({ 'package.json': pkg() }, kind, { dirs: ['src'] })).detected.srcDir).toBe(true);
    // A file or folder that merely contains the word does not.
    expect((await found({ 'package.json': pkg(), 'src2/a.ts': '', 'mysrc': '' }, kind)).detected.srcDir).toBe(false);
  });

  it('hasDir reports a chatwarden entry in the root listing', async () => {
    expect((await found({ 'package.json': pkg(), 'chatwarden/kit.ts': '' }, kind)).detected.hasDir).toBe(true);
    expect((await found({ 'package.json': pkg() }, kind)).detected.hasDir).toBe(false);
  });

  it('a UTF-8 byte order mark at the start of package.json (a Windows editor) does not stop detection', async () => {
    const { detected } = await found({ 'package.json': `\uFEFF${pkg({ dependencies: { express: '^5.1.0' }, type: 'module' })}` }, kind);
    expect(detected.frameworks).toEqual(['express']);
    expect(detected.moduleType).toBe('module');
  });

  it('a byte order mark is stripped only at the very start: one inside the text is still invalid JSON', async () => {
    expect(await failed({ 'package.json': `{"name": "a",\uFEFF "type": "module"}` }, kind)).toMatch(/not valid JSON/);
    expect(await failed({ 'package.json': '\uFEFF' }, kind)).toMatch(/package\.json/);
  });

  it('a missing, empty or invalid package.json is an error sentence, never a throw', async () => {
    expect(await failed({}, kind)).toMatch(/package\.json/);
    await failed({ 'package.json': '' }, kind);
    await failed({ 'package.json': '   \n' }, kind);
    await failed({ 'package.json': '{ not json' }, kind);
    await failed({ 'package.json': '{"name": "x",}' }, kind);
    await failed({ 'package.json': 'null' }, kind);
    await failed({ 'package.json': '[]' }, kind);
    await failed({ 'package.json': '"text"' }, kind);
    await failed({ 'package.json': '42' }, kind);
    // The error says what to do.
    expect(await failed({}, kind)).toMatch(/project root|root of your project|run .* from/i);
    // A folder called package.json is not a file.
    await failed({ 'package.json/x': '' }, kind);
  });

  it('a read that throws (permission, a closed disk) is an error sentence, never a throw', async () => {
    const message = await failed({ 'package.json': pkg() }, kind, { failOn: (op) => (op.op === 'readFile' ? Object.assign(new Error('EACCES: nope'), { code: 'EACCES' }) : undefined) });
    expect(message).not.toContain('EACCES: nope'.toLowerCase());
    await failed({ 'package.json': pkg() }, kind, { failOn: (op) => (op.op === 'readdir' ? Object.assign(new Error('EIO'), { code: 'EIO' }) : undefined) });
    // A non-Error rejection too.
    const world = createWorld({ kind, files: { 'package.json': pkg() } });
    world.env.fs.readdir = () => Promise.reject('weird');
    const result = await detect(world.env);
    expect('error' in result).toBe(true);
  });

  it('dependency tables of the wrong shape are treated as empty', async () => {
    for (const bad of ['text', 5, null, ['express'], true]) {
      const { detected } = await found({ 'package.json': pkg({ dependencies: bad, devDependencies: bad }) }, kind);
      expect(detected.frameworks).toEqual([]);
      expect(detected.react).toBe(false);
    }
  });

  it('detection reads only package.json, lockfiles, tsconfig.json and the directory listing of the root', async () => {
    const { world } = await found(
      {
        'package.json': pkg({ dependencies: { express: '5' } }),
        'pnpm-lock.yaml': 'secret-lock',
        'tsconfig.json': '{}',
        '.env': 'SECRET=zorbak',
        'src/index.ts': 'x',
        'chatwarden/kit.ts': 'y',
      },
      kind,
    );
    const reads = world.ops.filter((o) => o.op === 'readFile').map((o) => world.path.relative(world.root, o.path));
    expect(reads).toEqual(['package.json']);
    const listings = world.ops.filter((o) => o.op === 'readdir');
    expect(listings.map((o) => o.path)).toEqual([world.root]);
    for (const op of world.ops) expect(['readFile', 'readdir'], JSON.stringify(op)).toContain(op.op);
    expect(world.writes()).toEqual([]);
  });

  it('never looks in a parent folder', async () => {
    const world = createWorld({ kind, files: { 'package.json': pkg({ dependencies: { express: '5' } }), 'sub/deep/readme.txt': '' } });
    const sub = { ...world.env, cwd: world.abs('sub/deep') };
    const result = await detect(sub);
    expect('error' in result).toBe(true);
    for (const op of world.ops) expect(world.path.relative(sub.cwd, op.path).startsWith('..')).toBe(false);
  });
});

describe('Windows: the same tests with path.win32 and a C:\\ root give the same answers', () => {
  const projects: Array<Record<string, string>> = [
    { 'package.json': pkg({ dependencies: { express: '5', react: '19' }, type: 'module' }), 'pnpm-lock.yaml': '', 'tsconfig.json': '{}', 'src/a.ts': '' },
    { 'package.json': pkg({ devDependencies: { next: '15', 'socket.io': '4' } }), 'bun.lockb': '' },
    { 'package.json': pkg(), 'chatwarden/x': '' },
  ];
  it('posix and win32 detection agree on every project', async () => {
    for (const files of projects) {
      const posix = await found(files, 'posix');
      const win = await found(files, 'win32');
      expect(win.detected).toEqual(posix.detected);
      expect(win.world.root).toMatch(/^C:\\/);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { displayPath, safePath } from '../src/cli/paths.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World } from './cli-world.js';

const OUTSIDE = { posix: '/elsewhere', win32: 'D:\\elsewhere' } as const;

async function safe(world: World, dir: string, relative: string): Promise<string> {
  const result = await safePath(world.env, world.root, dir, relative);
  if (typeof result !== 'string') throw new Error(`expected a path, got: ${result.error}`);
  return result;
}
async function refused(world: World, dir: string, relative: string): Promise<string> {
  const result = await safePath(world.env, world.root, dir, relative);
  if (typeof result === 'string') throw new Error(`expected a refusal for ${JSON.stringify([dir, relative])}, got ${result}`);
  expect(result.error).not.toMatch(/\n/);
  expect(result.error, 'an error never echoes the project root').not.toContain(world.root);
  expect(result.error).toMatch(/[.]$/);
  return result.error;
}

describe.each(['posix', 'win32'] as const)('safePath (%s)', (kind: PathKind) => {
  const mk = (extra: Parameters<typeof createWorld>[0] = {}): World => createWorld({ kind, files: { 'package.json': '{}' }, ...extra });

  it('a path inside the root is accepted', async () => {
    const world = mk();
    expect(await safe(world, 'src/chatwarden', 'kit.ts')).toBe(world.abs('src/chatwarden/kit.ts'));
    expect(await safe(world, 'chatwarden', '.env.example')).toBe(world.abs('chatwarden/.env.example'));
    expect(await safe(world, '', 'app/chatwarden/[...path]/route.ts')).toBe(world.abs('app/chatwarden/[...path]/route.ts'));
    expect(await safe(world, 'a/b/c/d', 'x.js')).toBe(world.abs('a/b/c/d/x.js'));
    expect(await safe(world, '', 'kit.ts')).toBe(world.abs('kit.ts'));
    // A backslash dir is the same folder.
    expect(await safe(world, 'src\\chatwarden', 'kit.ts')).toBe(world.abs('src/chatwarden/kit.ts'));
  });

  it('refuses ../x, an absolute dir, a drive-letter dir, C:\\x', async () => {
    const world = mk();
    await refused(world, '../x', 'kit.ts');
    await refused(world, 'a/../../x', 'kit.ts');
    await refused(world, 'a\\..\\..\\x', 'kit.ts');
    await refused(world, '..', 'kit.ts');
    await refused(world, 'src', '../kit.ts');
    await refused(world, 'src', '..\\kit.ts');
    await refused(world, '/etc/x', 'kit.ts');
    await refused(world, '\\etc\\x', 'kit.ts');
    await refused(world, world.root, 'kit.ts');
    await refused(world, 'C:\\x', 'kit.ts');
    await refused(world, 'C:/x', 'kit.ts');
    await refused(world, 'c:x', 'kit.ts');
    await refused(world, '\\\\server\\share', 'kit.ts');
    await refused(world, 'src', '/abs.ts');
    await refused(world, 'src', 'C:\\abs.ts');
    await refused(world, 'a//b', 'kit.ts');
    await refused(world, 'src', 'a//kit.ts');
    await refused(world, 'a\0b', 'kit.ts');
    await refused(world, 'src', 'kit\0.ts');
    await refused(world, 'src', '');
    // A name that merely contains dots is fine.
    expect(await safe(world, '..a', '..b.ts')).toBe(world.abs('..a/..b.ts'));
  });

  it('refuses CON, NUL.txt, "a." and "a " (a Windows reserved name or a trailing dot or space), with or without an extension, in any case', async () => {
    const world = mk();
    for (const name of ['CON', 'con', 'Con.ts', 'PRN', 'AUX', 'NUL', 'NUL.txt', 'nul.tar.gz', 'COM1', 'com9.ts', 'LPT1', 'lpt9', 'LPT5.log']) {
      await refused(world, 'src/chatwarden', name);
      await refused(world, `src/${name}`, 'kit.ts');
      await refused(world, name, 'kit.ts');
    }
    for (const name of ['a.', 'a ', 'a..', 'dir.', 'name.ts.', 'a. ', ' a ', 'a\t']) {
      await refused(world, 'src', name);
      await refused(world, name, 'kit.ts');
    }
    // These look close and are fine.
    for (const name of ['COM0', 'COM10', 'LPT0', 'CONSOLE', 'recon.ts', 'nullable.ts', 'aux1', 'prn-x', 'con-x.ts', 'a.b']) {
      expect(await safe(world, 'src', name), name).toBe(world.abs(`src/${name}`));
    }
  });

  it('refuses a colon outside a drive, and characters Windows forbids in a name', async () => {
    const world = mk();
    await refused(world, 'src', 'a:b.ts');
    await refused(world, 'a:b', 'kit.ts');
    await refused(world, 'src', 'kit.ts:stream');
    for (const bad of ['a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0001b']) await refused(world, 'src', bad);
  });

  it('a symlinked folder that leaves the root is refused; one that stays inside is accepted', async () => {
    const outside = OUTSIDE[kind];
    const world = mk({ absDirs: [outside], links: { 'src/evil': outside, 'src/inside': 'real' }, dirs: ['real'] });
    await refused(world, 'src/evil', 'kit.ts');
    await refused(world, 'src/evil/deeper/still', 'kit.ts');
    expect(await safe(world, 'src/inside', 'kit.ts')).toBe(world.abs('src/inside/kit.ts'));
    expect(await safe(world, 'src/inside/not/yet/made', 'kit.ts')).toBe(world.abs('src/inside/not/yet/made/kit.ts'));
    // Each refusal came from asking where the nearest existing folder really is.
    expect(world.ops.some((o) => o.op === 'realpath')).toBe(true);
    expect(world.writes()).toEqual([]);
  });

  it('a symlink in the middle of a chain, and a link to a link, are followed to the real place', async () => {
    const outside = OUTSIDE[kind];
    const world = mk({ absDirs: [outside], links: { hop: 'src/evil', 'src/evil': outside } });
    await refused(world, 'hop/x', 'kit.ts');
  });

  it('a file that is itself a symlink is refused (it could read or replace something outside)', async () => {
    const outside = OUTSIDE[kind];
    const world = mk({ absDirs: [outside], files: { 'package.json': '{}', 'src/chatwarden/real.ts': 'x' }, links: { 'src/chatwarden/kit.ts': `${outside}${kind === 'win32' ? '\\' : '/'}x.ts` } });
    const error = await refused(world, 'src/chatwarden', 'kit.ts');
    expect(error).toMatch(/symbolic link/);
  });

  it('an output path over 200 characters is refused; 200 is fine', async () => {
    const world = mk();
    const dir = 'd'.repeat(60);
    const exactly200 = 'f'.repeat(200 - dir.length - 1);
    expect(`${dir}/${exactly200}`.length).toBe(200);
    expect(await safe(world, dir, exactly200)).toBe(world.abs(`${dir}/${exactly200}`));
    const over = await refused(world, dir, `${exactly200}x`);
    expect(over).toMatch(/200/);
    await refused(world, `${'a/'.repeat(100)}b`, 'kit.ts');
  });

  it('never writes while checking, and never reads a file', async () => {
    const world = mk({ files: { 'package.json': '{}', 'src/chatwarden/kit.ts': 'x' } });
    await safe(world, 'src/chatwarden', 'kit.ts');
    await safe(world, 'new/place', 'kit.ts');
    expect(world.writes()).toEqual([]);
    expect(world.ops.filter((o) => o.op === 'readFile')).toEqual([]);
  });

  it('an error never carries the project root, a user-typed absolute path or a stack', async () => {
    const world = mk({ absDirs: [OUTSIDE[kind]], links: { 'src/evil': OUTSIDE[kind] } });
    for (const [dir, relative] of [['/etc/passwd', 'x'], ['C:\\zorbakdir', 'x'], ['..', 'x'], ['src/evil', 'x'], ['src', 'CON']] as const) {
      const error = await refused(world, dir, relative);
      expect(error).not.toContain('/etc/passwd');
      expect(error).not.toContain('zorbakdir');
      expect(error).not.toContain(OUTSIDE[kind]);
    }
  });

  it('printed paths use / on every platform', () => {
    const world = mk();
    expect(displayPath(world.env, world.root, world.abs('src/chatwarden/kit.ts'))).toBe('src/chatwarden/kit.ts');
    expect(displayPath(world.env, world.root, world.abs('app/chatwarden/[...path]/route.ts'))).toBe('app/chatwarden/[...path]/route.ts');
    expect(displayPath(world.env, world.root, world.abs('kit.ts'))).toBe('kit.ts');
  });
});

describe('safePath on win32 specifically', () => {
  it('printed paths use / on win32 (a C:\\ root, backslash separators underneath)', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{}' } });
    const resolved = await safe(world, 'src\\chatwarden', 'kit.ts');
    expect(resolved).toBe('C:\\proj\\src\\chatwarden\\kit.ts');
    expect(displayPath(world.env, world.root, resolved)).toBe('src/chatwarden/kit.ts');
  });

  it('a path on another drive, or the same name in another case, is not mistaken for the root', async () => {
    const world = createWorld({ kind: 'win32', files: { 'package.json': '{}' }, absDirs: ['C:\\proj-other'], links: { 'src/x': 'C:\\proj-other' } });
    await refused(world, 'src/x', 'kit.ts');
  });
});

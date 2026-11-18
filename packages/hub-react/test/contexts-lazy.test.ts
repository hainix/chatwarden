// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

// M3: the Room contexts list is its own lazy chunk: a first load carries none of its code (only the client call and the chip, which are small). Bundled the way an adopter's bundler splits at a
// dynamic import(), as size.test.ts does; the size budget itself is size.test.ts's.

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

async function bundle() {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/*', '@chatwarden/*'],
    splitting: true,
    outdir: fileURLToPath(new URL('../.size-out-contexts', import.meta.url)),
    entryNames: 'entry',
    chunkNames: 'chunk-[name]-[hash]',
    metafile: true,
    logLevel: 'silent',
  });
  const meta = Object.entries(result.metafile.outputs);
  const entryKey = meta.find(([, o]) => o.entryPoint?.endsWith('src/index.ts') === true)?.[0] ?? '';
  const outputOf = (key: string) => meta.find(([k]) => k === key)?.[1];
  const eagerNames = new Set<string>();
  const visit = (key: string): void => {
    const name = key.split('/').pop() ?? key;
    if (eagerNames.has(name)) return;
    eagerNames.add(name);
    for (const imp of outputOf(key)?.imports ?? []) if (imp.kind === 'import-statement' && !imp.external) visit(imp.path);
  };
  visit(entryKey);
  return {
    eagerInputs: [...new Set(meta.filter(([k]) => eagerNames.has(k.split('/').pop() ?? k)).flatMap(([, o]) => Object.keys(o.inputs)))],
    chunkRoots: meta.flatMap(([, o]) => (o.entryPoint !== undefined && !o.entryPoint.endsWith('src/index.ts') ? [o.entryPoint] : [])),
  };
}

describe('the Room contexts list is lazy', () => {
  it('has a chunk of its own, and the first load carries no code of it', async () => {
    const { eagerInputs, chunkRoots } = await bundle();
    expect(chunkRoots.filter((r) => r.endsWith('src/policy/RoomContexts.tsx'))).toHaveLength(1);
    expect(eagerInputs.filter((i) => i.endsWith('src/policy/RoomContexts.tsx'))).toEqual([]);
  });

  it('the chip is part of the first load (it is small and sits on every case)', async () => {
    const { eagerInputs } = await bundle();
    expect(eagerInputs.some((i) => i.endsWith('src/case/CaseContext.tsx'))).toBe(true);
  });
});

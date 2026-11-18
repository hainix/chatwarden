import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// A consumer who installs @chatwarden/http without one of its optional peers (store-sqlite, matcher, profanity, hub-element) must still be able to
// import every entry point that does not need it. So no module an entry point reaches may import one of them statically: they are loaded with
// `import(name)` at the moment they are needed (chatwarden serve), and `import type` is erased. The scan follows each entry's relative static imports.

const root = fileURLToPath(new URL('..', import.meta.url));
const httpDir = join(root, 'packages', 'http');
const manifest = JSON.parse(readFileSync(join(httpDir, 'package.json'), 'utf8')) as {
  exports: Record<string, { default: string }>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};
const OPTIONAL = Object.keys(manifest.peerDependencies).filter((n) => manifest.peerDependenciesMeta[n]?.optional === true && n.startsWith('@chatwarden/'));

/** The source file behind a built entry: `./dist/src/x/index.js` is `src/x/index.ts`. */
const sourceOf = (built: string): string => join(httpDir, built.replace(/^\.\/dist\//, '').replace(/\.js$/, '.ts'));

/** Static imports and re-exports that survive compilation: not `import type`, not `export type`, not `import(...)`. */
function staticSpecifiers(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?'([^']+)'/gm)) out.push(m[1] as string);
  // `import { type A, type B } from 'x'` keeps a side-effect import under some settings: count it, so the check is not weakened by the syntax
  return out;
}

/** Every module a source file reaches through relative static imports, with the bare specifiers it meets on the way. */
function reach(entry: string): { files: Set<string>; bare: Set<string> } {
  const files = new Set<string>();
  const bare = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const file = todo.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const next = resolve(dirname(file), spec).replace(/\.js$/, '.ts');
        if (existsSync(next)) todo.push(next);
        else if (existsSync(next.replace(/\.ts$/, '.tsx'))) todo.push(next.replace(/\.ts$/, '.tsx'));
      } else bare.add(spec);
    }
  }
  return { files, bare };
}

const entries = Object.entries(manifest.exports).map(([subpath, target]) => [subpath, sourceOf(target.default)] as const);

describe('@chatwarden/http entry points and its optional peers', () => {
  it('the optional peers are the four the manifest names', () => {
    expect(OPTIONAL.sort()).toEqual(['@chatwarden/hub-element', '@chatwarden/matcher', '@chatwarden/profanity', '@chatwarden/store-sqlite']);
  });

  it.each(entries)('%s (%s) imports no optional peer statically, directly or through the modules it reaches', (subpath, source) => {
    expect(existsSync(source), `${subpath} has a source`).toBe(true);
    const { bare } = reach(source);
    for (const peer of OPTIONAL) {
      expect([...bare].filter((s) => s === peer || s.startsWith(`${peer}/`)), `${subpath} -> ${peer}`).toEqual([]);
    }
  });

  it('control: the scan sees real imports (the root entry reaches @chatwarden/core, and the scan would see a peer)', () => {
    const { files, bare } = reach(sourceOf(manifest.exports['.']!.default));
    expect(files.size).toBeGreaterThan(5);
    expect([...bare].some((s) => s === '@chatwarden/core' || s.startsWith('@chatwarden/core/'))).toBe(true);
    expect(staticSpecifiers("import { a } from '@chatwarden/matcher';\nimport type { B } from '@chatwarden/matcher';\nexport * from './x.js';\nconst m = await import('@chatwarden/profanity');\n")).toEqual(['@chatwarden/matcher', './x.js']);
  });

  it('chatwarden serve loads the optional peers with import(), never a static import', () => {
    const serve = readFileSync(join(httpDir, 'src', 'service', 'serve.ts'), 'utf8');
    expect(staticSpecifiers(serve).filter((s) => OPTIONAL.includes(s))).toEqual([]);
    for (const peer of ['@chatwarden/store-sqlite', '@chatwarden/matcher', '@chatwarden/profanity']) expect(serve).toContain(`'${peer}'`);
  });
});

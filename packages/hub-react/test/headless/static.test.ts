// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The headless controller is for Vue, Svelte, Solid and plain code: nothing under src/headless may reach for React, React DOM, a
// .tsx file, or a module that does. Checked on the source, by following every import to its end.

const src = fileURLToPath(new URL('../../src', import.meta.url));
const headless = join(src, 'headless');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

/** Every module specifier a TypeScript file imports or re-exports (type-only ones too: a type from React is still a dependency on it). */
function specifiers(file: string, text = readFileSync(file, 'utf8')): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2023, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] !== undefined && ts.isStringLiteral(node.arguments[0])) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const isReact = (s: string): boolean => s === 'react' || s.startsWith('react/') || s === 'react-dom' || s.startsWith('react-dom/') || s === 'scheduler';

/** Resolves a relative `.js` specifier from `from` to the TypeScript file it was built from, or null for a package. */
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = join(from, '..', spec.replace(/\.js$/, ''));
  for (const ext of ['.ts', '.tsx', '/index.ts', '/index.tsx']) {
    try {
      readFileSync(base + ext);
      return base + ext;
    } catch {
      // try the next
    }
  }
  throw new Error(`cannot resolve ${spec} from ${from}`);
}

/** The files `entry` reaches through relative imports, itself included. */
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const todo = [entry];
  while (todo.length > 0) {
    const f = todo.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specifiers(f)) {
      const next = resolveLocal(f, s);
      if (next !== null) todo.push(next);
    }
  }
  return [...seen];
}

const files = walk(headless).filter((f) => /\.tsx?$/.test(f));

describe('src/headless imports no React', () => {
  it('has files to check (control)', () => {
    expect(files.length).toBeGreaterThan(8);
    expect(files.map((f) => f.slice(headless.length + 1).replaceAll('\\', '/'))).toContain('controller.ts');
  });

  it('is all .ts: no .tsx file in the folder', () => {
    expect(files.filter((f) => f.endsWith('.tsx'))).toEqual([]);
  });

  // Every file, not only the ones the entry exports: a file that nothing imports yet must not pull React in either. Specifiers in TS
  // ESM are written `./x.js`, so a `.tsx` is found by resolving the import, not by reading its text.
  it.each(files.map((f) => [f.slice(src.length + 1).replaceAll('\\', '/'), f] as const))('%s imports no React, and nothing it reaches does: no react, react-dom or .tsx file in its whole import closure', (_name, file) => {
    const closure = reach(file);
    expect(closure.filter((f) => f.endsWith('.tsx'))).toEqual([]);
    expect(closure.filter((f) => specifiers(f).some(isReact)).map((f) => f.slice(src.length + 1).replaceAll('\\', '/'))).toEqual([]);
  });

  it('the entry reaches enough to be a real check (control)', () => {
    expect(reach(join(headless, 'index.ts')).length).toBeGreaterThan(10);
  });

  it('the scan catches what it should (control)', () => {
    expect(specifiers('x.ts', "import { useState } from 'react';\nexport * from 'react-dom/client';\nimport type { A } from './a.js';\nconst b = import('react/jsx-runtime');")).toEqual([
      'react',
      'react-dom/client',
      './a.js',
      'react/jsx-runtime',
    ]);
    expect(specifiers('x.ts', "import type { ReactNode } from 'react';").filter(isReact)).toEqual(['react']);
    // A `.js` specifier that is really a .tsx file (the React toasts) is found by resolving it.
    expect(resolveLocal(join(src, 'headless', 'x.ts'), '../toasts.js')?.endsWith('toasts.tsx')).toBe(true);
  });
});

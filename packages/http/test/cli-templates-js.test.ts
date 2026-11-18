import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { renderAll } from '../src/cli/templates/index.js';
import type { FileSpec } from '../src/cli/types.js';
import { JS_OPTIONS, VERSIONS, answersOf, legalAnswers, syntaxProblems } from './cli-stubs.js';

// The JavaScript rendering is the TypeScript one with the types left out, written that way (no stripping pass). These tests hold it to that.

/** The path without its script extension: a .tsx file and its .jsx twin share a stem. */
const stem = (path: string): string => path.replace(/\.(tsx?|jsx?|mjs)$/, '');
const isJs = (f: FileSpec): boolean => /\.(js|mjs|jsx)$/.test(f.path);

describe('the JS rendering', () => {
  it('parses as a script of ESM with none, and the controls (a type annotation, an import type, an interface in a .js) fail', () => {
    const seen = new Set<string>();
    for (const answers of legalAnswers('js')) {
      for (const file of renderAll(answers, VERSIONS).filter(isJs)) {
        if (seen.has(file.content)) continue;
        seen.add(file.content);
        expect(syntaxProblems(file, JS_OPTIONS), file.path).toEqual([]);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(syntaxProblems({ path: 'x.js', content: 'export const a: number = 1;\n' }, JS_OPTIONS)).not.toEqual([]);
    expect(syntaxProblems({ path: 'x.js', content: "import type { A } from 'x';\n" }, JS_OPTIONS)).not.toEqual([]);
    expect(syntaxProblems({ path: 'x.js', content: 'export interface A {}\n' }, JS_OPTIONS)).not.toEqual([]);
    expect(syntaxProblems({ path: 'x.js', content: 'export const a = <T,>(b) => b as T;\n' }, JS_OPTIONS)).not.toEqual([]);
  });

  it("contains no type syntax (no ': Promise<', no 'import type', no ' as ', no interface, no return type, no generic call)", () => {
    for (const answers of legalAnswers('js')) {
      for (const file of renderAll(answers, VERSIONS).filter(isJs)) {
        const text = file.content;
        expect(text, file.path).not.toMatch(/: Promise</);
        expect(text, file.path).not.toMatch(/import type/);
        expect(text.replaceAll('import * as ', 'import * '), file.path).not.toMatch(/ as /); // a namespace import is plain JavaScript
        expect(text, file.path).not.toMatch(/\binterface\b/);
        expect(text, file.path).not.toMatch(/\bexport type\b/);
        expect(text, file.path).not.toMatch(/function\s+\w*\s*\([^)]*\)\s*:/); // a return type on a function
        expect(text, file.path).not.toMatch(/\)\s*:\s*(Promise|string|boolean|void|number|unknown|Authz|RawWho)\b/);
        expect(text, file.path).not.toMatch(/\w<[A-Za-z]+(\[\]| \|)?[^<>]*>\(/); // a generic call or definition
        expect(text, file.path).not.toMatch(/\b(readonly|private|public|satisfies)\b/);
        expect(text, file.path).not.toMatch(/\w!\./); // a non-null assertion
        expect(text, file.path).not.toMatch(/\(\w+\??: \w/); // a parameter annotation
      }
    }
  });

  it('is the TypeScript rendering with the types removed: the same program once both are compiled', () => {
    const compile = (file: FileSpec): string =>
      ts
        .transpileModule(file.content, { fileName: file.path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true, removeComments: true, jsx: ts.JsxEmit.Preserve } })
        .outputText.replace(/\n\s*\n/g, '\n');
    let compared = 0;
    for (const combo of legalAnswers('ts').filter((_, i) => i % 5 === 0)) {
      const tsFiles = renderAll(combo, VERSIONS).filter((f) => /\.tsx?$/.test(f.path));
      const jsFiles = renderAll({ ...combo, lang: 'js' }, VERSIONS).filter(isJs);
      expect(jsFiles.map((f) => stem(f.path)).sort()).toEqual(tsFiles.map((f) => stem(f.path)).sort());
      for (const tsFile of tsFiles) {
        const jsFile = jsFiles.find((f) => stem(f.path) === stem(tsFile.path));
        expect(jsFile, tsFile.path).toBeDefined();
        expect(compile(jsFile!), tsFile.path).toBe(compile(tsFile));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(30);
  }, 60_000);

  it('the comments are the same in both renderings, so the markers and the advice carry over', () => {
    const comments = (file: FileSpec): string[] => file.content.split('\n').filter((l) => l.trim().startsWith('//'));
    for (const combo of legalAnswers('ts').filter((_, i) => i % 17 === 0)) {
      const tsFiles = renderAll(combo, VERSIONS).filter((f) => /\.ts$/.test(f.path));
      const jsFiles = renderAll({ ...combo, lang: 'js' }, VERSIONS).filter((f) => /\.js$/.test(f.path));
      for (const tsFile of tsFiles) {
        const jsFile = jsFiles.find((f) => f.path === tsFile.path.replace(/\.ts$/, '.js'))!;
        expect(comments(jsFile), tsFile.path).toEqual(comments(tsFile));
      }
    }
  });

  it('every .js and .mjs file passes node --check, for a sample of answers and both module types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-check-'));
    try {
      const sample = legalAnswers('js').filter((_, i) => i % 53 === 0);
      expect(sample.length).toBeGreaterThan(4);
      for (const moduleType of ['module', 'commonjs'] as const) {
        for (const answers of sample) {
          for (const file of renderAll(answers, VERSIONS, { moduleType }).filter((f) => /\.m?js$/.test(f.path))) {
            const target = join(dir, `${moduleType}-${file.path.replaceAll('/', '_')}${file.path.endsWith('.mjs') ? '' : '.mjs'}`);
            writeFileSync(target, file.content);
            const run = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8' });
            expect(run.status, `${file.path}: ${run.stderr}`).toBe(0);
          }
        }
      }
      // The control: node does reject a type annotation.
      const bad = join(dir, 'bad.mjs');
      writeFileSync(bad, 'export const a: number = 1;\n');
      expect(spawnSync(process.execPath, ['--check', bad], { encoding: 'utf8' }).status).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('writes .js in a module project and .mjs in a CommonJS one, each importing its own siblings by that suffix', () => {
    const esm = renderAll(answersOf({ lang: 'js' }), VERSIONS, { moduleType: 'module' });
    expect(esm.filter((f) => !f.path.endsWith('.example')).every((f) => f.path.endsWith('.js'))).toBe(true);
    const cjs = renderAll(answersOf({ lang: 'js' }), VERSIONS, { moduleType: 'commonjs' });
    expect(cjs.filter((f) => !f.path.endsWith('.example')).every((f) => f.path.endsWith('.mjs'))).toBe(true);
    for (const file of cjs.filter(isJs)) expect(file.content, file.path).not.toMatch(/from '\.\/[^']+\.js'/);
    for (const file of esm.filter(isJs)) expect(file.content, file.path).not.toMatch(/from '\.\/[^']+\.mjs'/);
  });
});

describe('the creator kit in JavaScript (0.2.2)', () => {
  it('is the TypeScript creator kit with the types removed: the same program once both are compiled, and it passes node --check', () => {
    const compile = (file: FileSpec): string =>
      ts
        .transpileModule(file.content, { fileName: file.path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, allowJs: true, removeComments: true, jsx: ts.JsxEmit.Preserve } })
        .outputText.replace(/\n\s*\n/g, '\n');
    const tsKit = renderAll(answersOf({ game: 'creator' }), VERSIONS).find((f) => /kit\.ts$/.test(f.path))!;
    const jsKit = renderAll(answersOf({ game: 'creator', lang: 'js' }), VERSIONS).find((f) => /kit\.js$/.test(f.path))!;
    expect(jsKit.content).toContain("overrides: { teamNotes: [{ text: 'Protect the creator and their guests from targeted abuse' }] },");
    expect(compile(jsKit)).toBe(compile(tsKit));
    expect(syntaxProblems(jsKit, JS_OPTIONS)).toEqual([]);
    // a CommonJS project gets .mjs and still carries the line
    const mjs = renderAll(answersOf({ game: 'creator', lang: 'js' }), VERSIONS, { moduleType: 'commonjs' }).find((f) => /kit\.mjs$/.test(f.path))!;
    expect(mjs.content).toContain('overrides: { teamNotes:');
  });
});

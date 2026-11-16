import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { contentProblems, envNames } from '../src/cli/plan.js';
import { MARKERS, header, headerHash } from '../src/cli/templates/header.js';
import { imp, impNs, impType, makeCtx, spec, t } from '../src/cli/templates/frag.js';
import { renderAll } from '../src/cli/templates/index.js';
import type { Answers } from '../src/cli/types.js';
import { TS_OPTIONS, VERSIONS, answersOf, legalAnswers, syntaxProblems } from './cli-stubs.js';

describe('every file renders', () => {
  it('for every legal answers combination, in ts and js', () => {
    for (const lang of ['ts', 'js'] as const) {
      const combos = legalAnswers(lang);
      expect(combos.length).toBeGreaterThan(200);
      for (const answers of combos) {
        const files = renderAll(answers, VERSIONS);
        const paths = files.map((f) => f.path);
        expect(new Set(paths).size, JSON.stringify(answers)).toBe(paths.length);
        expect(paths).toContain(`${answers.dir}/kit.${lang === 'ts' ? 'ts' : 'js'}`);
        expect(paths).toContain(`${answers.dir}/terms.${lang === 'ts' ? 'ts' : 'js'}`);
        expect(paths).toContain(`${answers.dir}/.env.example`);
        expect(paths.includes(`${answers.dir}/auth.${lang === 'ts' ? 'ts' : 'js'}`)).toBe(answers.framework !== 'none');
        for (const file of files) {
          expect(file.content.endsWith('\n'), file.path).toBe(true);
          expect(file.content.length, file.path).toBeGreaterThan(40);
          // [...path] is Next's catch-all folder name, the one place two dots are right.
          expect(file.path.startsWith('/') || file.path.includes('\\') || file.path.replaceAll('[...path]', '').includes('..'), file.path).toBe(false);
        }
      }
    }
  });

  it('library only writes exactly kit, terms and .env.example (design 6.3)', () => {
    const files = renderAll(answersOf({ framework: 'none', hub: 'none', chat: 'none' }), VERSIONS).map((f) => f.path).sort();
    expect(files).toEqual(['src/chatwarden/.env.example', 'src/chatwarden/kit.ts', 'src/chatwarden/terms.ts']);
  });

  it('a framework adds auth.ts to those three', () => {
    for (const framework of ['express', 'fastify', 'next', 'fetch'] as const) {
      const files = renderAll(answersOf({ framework, hub: framework === 'next' ? 'react' : 'element' }), VERSIONS).map((f) => f.path);
      expect(files, framework).toEqual(expect.arrayContaining(['src/chatwarden/kit.ts', 'src/chatwarden/auth.ts', 'src/chatwarden/terms.ts', 'src/chatwarden/.env.example']));
    }
  });

  it('files go under --dir and nowhere else, and honour a custom dir', () => {
    const files = renderAll(answersOf({ dir: 'lib/vlemmo' }), VERSIONS);
    for (const file of files) expect(file.path.startsWith('lib/vlemmo/'), file.path).toBe(true);
  });
});

describe('the renderings parse', () => {
  it('the TS rendering parses with no syntax diagnostics (typescript), and the control fails', () => {
    const seen = new Set<string>();
    for (const answers of legalAnswers('ts')) {
      for (const file of renderAll(answers, VERSIONS)) {
        if (!/\.tsx?$/.test(file.path) || seen.has(file.content)) continue;
        seen.add(file.content);
        expect(syntaxProblems(file, TS_OPTIONS), file.path).toEqual([]);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(syntaxProblems({ path: 'x.ts', content: 'export const a: = ;\n' }, TS_OPTIONS)).not.toEqual([]);
  });
});

describe('the language and module settings', () => {
  it('js in a project of type module is .js with .js specifiers; in a commonjs project it is .mjs with .mjs specifiers', () => {
    const esm = renderAll(answersOf({ lang: 'js' }), VERSIONS, { moduleType: 'module' });
    expect(esm.map((f) => f.path).filter((p) => !p.endsWith('.example')).every((p) => p.endsWith('.js'))).toBe(true);
    expect(esm.find((f) => f.path.endsWith('kit.js'))!.content).toContain("from './terms.js'");
    const cjs = renderAll(answersOf({ lang: 'js' }), VERSIONS, { moduleType: 'commonjs' });
    expect(cjs.map((f) => f.path).filter((p) => !p.endsWith('.example')).every((p) => p.endsWith('.mjs'))).toBe(true);
    const kit = cjs.find((f) => f.path.endsWith('kit.mjs'))!.content;
    expect(kit).toContain("from './terms.mjs'");
    expect(kit).toContain("from './auth.mjs'");
    expect(kit).not.toContain('.js\'');
    // The default is a module.
    expect(renderAll(answersOf({ lang: 'js' }), VERSIONS).some((f) => f.path.endsWith('.mjs'))).toBe(false);
  });

  it('ts always writes .ts with .js specifiers, whatever the module type', () => {
    for (const moduleType of ['module', 'commonjs'] as const) {
      const files = renderAll(answersOf(), VERSIONS, { moduleType });
      expect(files.find((f) => f.path.endsWith('kit.ts'))!.content).toContain("from './terms.js'");
    }
  });

  it('every relative specifier in a rendering names a file that the same rendering writes', () => {
    for (const lang of ['ts', 'js'] as const) {
      for (const moduleType of ['module', 'commonjs'] as const) {
        for (const answers of legalAnswers(lang).filter((_, i) => i % 7 === 0)) {
          const files = renderAll(answers, VERSIONS, { moduleType });
          const names = new Set(files.map((f) => f.path.slice(answers.dir.length + 1).replace(/\.(ts|tsx|js|jsx|mjs)$/, '')));
          for (const file of files) {
            for (const match of file.content.matchAll(/from '(\.\/[^']+)'/g)) {
              const wanted = match[1]!.slice(2).replace(/\.(ts|tsx|js|jsx|mjs)$/, '');
              expect(names.has(wanted), `${file.path} imports ${match[1]}`).toBe(true);
            }
          }
        }
      }
    }
  });
});

describe('rendering is a pure function', () => {
  it('same Ctx, same text; the inputs are not changed', () => {
    for (const answers of legalAnswers('ts').filter((_, i) => i % 11 === 0)) {
      const frozen = JSON.stringify(answers);
      const a = renderAll(answers, VERSIONS);
      const b = renderAll(JSON.parse(frozen) as Answers, { ...VERSIONS });
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
      expect(JSON.stringify(answers)).toBe(frozen);
    }
  });

  it('no Date, no Math.random, no process.cwd in the templates (a source scan of what runs, not of the text they write)', () => {
    const dir = fileURLToPath(new URL('../src/cli/templates/', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(sources).toEqual(expect.arrayContaining(['frag.ts', 'index.ts', 'kit.ts', 'auth.ts', 'terms.ts', 'envExample.ts', 'header.ts']));
    for (const name of sources) {
      const text = readFileSync(new URL(`../src/cli/templates/${name}`, import.meta.url), 'utf8');
      const source = ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true);
      const found: string[] = [];
      const visit = (node: ts.Node): void => {
        // Executable positions only: identifiers and property accesses. Template and string text is what the template WRITES.
        if (ts.isIdentifier(node) && (node.text === 'Date' || node.text === 'performance')) found.push(node.text);
        if (ts.isPropertyAccessExpression(node)) {
          const full = node.getText(source);
          if (full === 'Math.random' || full === 'process.cwd' || full === 'process.hrtime' || full === 'crypto.randomUUID') found.push(full);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      expect(found, name).toEqual([]);
    }
  });

  it('the scan sees a Date used in an executable position (control)', () => {
    const source = ts.createSourceFile('x.ts', 'const a = `${Date.now()}`; const b = "Date";', ts.ScriptTarget.ES2022, true);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && node.text === 'Date') found.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(found).toEqual(['Date']);
  });

  it('no rendering carries a carriage return, an absolute path, a timestamp or a long key-like run', () => {
    for (const lang of ['ts', 'js'] as const) {
      for (const answers of legalAnswers(lang).filter((_, i) => i % 5 === 0)) {
        for (const file of renderAll(answers, VERSIONS)) expect(contentProblems(file.content), file.path).toEqual([]);
      }
    }
  });
});

describe('the engine', () => {
  const ctxTs = makeCtx(answersOf({ lang: 'ts' }), VERSIONS);
  const ctxJs = makeCtx(answersOf({ lang: 'js' }), VERSIONS);
  const ctxMjs = makeCtx(answersOf({ lang: 'js' }), VERSIONS, { moduleType: 'commonjs' });

  it('t keeps a fragment in ts and drops it in js', () => {
    expect(t(ctxTs, ': string')).toBe(': string');
    expect(t(ctxJs, ': string')).toBe('');
    expect(t(ctxMjs, ': string')).toBe('');
  });

  it('imp and impType write whole lines; a type import vanishes in js', () => {
    expect(imp(ctxTs, ['a', 'b'], '@chatwarden/core')).toBe("import { a, b } from '@chatwarden/core';\n");
    expect(imp(ctxTs, 'a', '@chatwarden/core')).toBe("import { a } from '@chatwarden/core';\n");
    expect(impType(ctxTs, ['A'], '@chatwarden/core')).toBe("import type { A } from '@chatwarden/core';\n");
    expect(impType(ctxJs, ['A'], '@chatwarden/core')).toBe('');
    expect(impNs(ctxTs, 'hooks', './auth')).toBe("import * as hooks from './auth.js';\n");
    expect(impNs(ctxMjs, 'hooks', './auth')).toBe("import * as hooks from './auth.mjs';\n");
  });

  it("spec adds the context's suffix to a relative specifier only", () => {
    expect(spec(ctxTs, './kit')).toBe('./kit.js');
    expect(spec(ctxJs, './kit')).toBe('./kit.js');
    expect(spec(ctxMjs, './kit')).toBe('./kit.mjs');
    expect(spec({ ...ctxTs, ext: '' }, './kit')).toBe('./kit');
    expect(spec(ctxTs, '../kit')).toBe('../kit.js');
    expect(spec(ctxTs, './kit.js')).toBe('./kit.js');
    expect(spec(ctxTs, './style.css')).toBe('./style.css.js'); // only code suffixes count as already there
    expect(spec(ctxTs, '@chatwarden/http/chat')).toBe('@chatwarden/http/chat');
    expect(spec(ctxTs, 'node:crypto')).toBe('node:crypto');
  });

  it('makeCtx follows the language and the module type', () => {
    expect(ctxTs).toMatchObject({ lang: 'ts', ext: '.js', scriptExt: '.ts', jsxExt: '.tsx' });
    expect(ctxJs).toMatchObject({ lang: 'js', ext: '.js', scriptExt: '.js', jsxExt: '.jsx' });
    expect(ctxMjs).toMatchObject({ lang: 'js', ext: '.mjs', scriptExt: '.mjs', jsxExt: '.jsx' });
    expect(ctxTs.versions).toBe(VERSIONS);
  });

  it('the header is fixed text with no version, no date and no machine name', () => {
    const text = header(ctxTs, 'The kit');
    expect(text).toBe('// The kit\n// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.\n\n');
    expect(headerHash('Settings')).toBe('# Settings\n# Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.\n\n');
    expect(contentProblems(text)).toEqual([]);
    expect(text).not.toContain(VERSIONS.chatwarden);
    // Every rendered file starts with it.
    for (const file of renderAll(answersOf({ discord: true, chat: 'box' }), VERSIONS)) {
      expect(file.content, file.path).toMatch(/^[#/]{1,2} .+\n[#/]{1,2} Written by `chatwarden init` \(K4b\)\. It is yours now: edit freely\. Re-running never overwrites a file you changed\.\n\n/);
    }
  });
});

describe('markers', () => {
  const count = (text: string, marker: string): number => text.split(marker).length - 1;

  it('each of TODO(auth), TODO(identity), TODO(terms) appears exactly where designed and nowhere else', () => {
    expect([...MARKERS]).toEqual(['TODO(auth)', 'TODO(identity)', 'TODO(terms)']);
    for (const lang of ['ts', 'js'] as const) {
      for (const answers of legalAnswers(lang).filter((_, i) => i % 9 === 0)) {
        for (const file of renderAll(answers, VERSIONS)) {
          const base = file.path.slice(answers.dir.length + 1);
          const expected: Record<string, number> = { 'TODO(auth)': 0, 'TODO(identity)': 0, 'TODO(terms)': 0 };
          if (/^auth\./.test(base)) {
            expected['TODO(auth)'] = 1;
            expected['TODO(identity)'] = 2; // identify and join
          }
          if (/^terms\./.test(base)) expected['TODO(terms)'] = 1;
          for (const marker of MARKERS) expect(count(file.content, marker), `${file.path} ${marker}`).toBe(expected[marker]);
          // What a file declares is exactly what it holds.
          const declared = new Set(file.markers ?? []);
          const held = new Set(MARKERS.filter((m) => file.content.includes(m)));
          expect(declared, file.path).toEqual(held);
        }
      }
    }
  });

  it('a marker sits on a comment line, so it cannot change what the code does', () => {
    for (const file of renderAll(answersOf(), VERSIONS)) {
      for (const line of file.content.split('\n')) {
        if (MARKERS.some((m) => line.includes(m))) expect(line.trim().startsWith('//'), `${file.path}: ${line}`).toBe(true);
      }
    }
  });
});

describe('.env.example', () => {
  it('holds only placeholders: no value after =, no real-looking secret', () => {
    for (const answers of legalAnswers('ts').filter((_, i) => i % 3 === 0)) {
      const env = renderAll(answers, VERSIONS).find((f) => f.path.endsWith('.env.example'))!;
      const assignments = env.content.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
      expect(assignments.length).toBeGreaterThanOrEqual(1);
      for (const line of assignments) expect(line, env.path).toMatch(/^[A-Z][A-Z0-9_]*=$/);
      expect(contentProblems(env.content)).toEqual([]);
      for (const line of env.content.split('\n')) {
        if (!/^[A-Z]/.test(line)) expect(line.startsWith('#') || line === '', line).toBe(true);
      }
    }
  });

  it('names exactly the variables the plan lists, in the same order', () => {
    for (const answers of legalAnswers('ts').filter((_, i) => i % 3 === 0)) {
      const env = renderAll(answers, VERSIONS).find((f) => f.path.endsWith('.env.example'))!;
      const names = env.content.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => l.slice(0, -1));
      expect(names, JSON.stringify(answers)).toEqual(envNames(answers).map((e) => e.name));
    }
  });

  it('says what each variable is for, how long the secret must be, and that Next and fetch need the proxy switch off by default', () => {
    const env = renderAll(answersOf({ framework: 'next', hub: 'react', discord: true }), VERSIONS).find((f) => f.path.endsWith('.env.example'))!.content;
    expect(env).toMatch(/at least 32 characters[\s\S]*CHATWARDEN_SECRET=/);
    expect(env).toMatch(/CHATWARDEN_ADMIN_TOKEN/);
    expect(env).toMatch(/401/);
    expect(env).toMatch(/CHATWARDEN_TRUST_PROXY=\n/);
    expect(env).toMatch(/only behind your own/i);
    expect(env).toContain("randomBytes(32).toString('hex')");
  });

  it('the library-only one has no staff token', () => {
    const env = renderAll(answersOf({ framework: 'none', hub: 'none' }), VERSIONS).find((f) => f.path.endsWith('.env.example'))!.content;
    expect(env).not.toContain('CHATWARDEN_ADMIN_TOKEN');
    expect(env).toContain('CHATWARDEN_SECRET=');
  });
});

describe('synthetic words only', () => {
  // The repo's pattern for terms: an explicit allow-list of invented words. For the rendered text the equivalent is a list of the plain
  // words the templates may quote; a new quoted word has to be added here on purpose, so no real term can slip in by accident.
  const ALLOWED_QUOTED = new Set([
    'admin', 'owner', 'lobby', 'standard', 'relaxed', 'strict', 'production', 'development', 'hex', 'sha256', 'utf8', 'object', 'string', 'report',
    'person', 'reports', 'people', 'sqlite', 'memory', 'Strict', 'Lax', 'Secure', 'HttpOnly', 'Player', 'none', 'true', 'false', 'syn',
    // the framework files: the HTML page's content type, the kit's route and package names, and a few DOM and header names
    'html', 'text', 'post', 'viewport', 'GET', 'HEAD', 'POST', 'function', 'banned', 'boolean', 'bye', 'closed', 'connect', 'connecting', 'connection', 'disconnect', 'forbidden', 'hello', 'length', 'open', 'reconnecting', 'refused', 'shutdown', 'unauthorized', 'close', 'onClose', 'fastify', 'nosniff', 'off', 'token', 'pass', 'login', 'hub', 'express', 'react', 'self', 'password', 'submit', 'module', 'nodejs', 'force',
  ]);

  it('no rendering quotes a plain word outside the allowed list, and none embeds a list of words', () => {
    for (const lang of ['ts', 'js'] as const) {
      for (const answers of legalAnswers(lang).filter((_, i) => i % 13 === 0)) {
        for (const file of renderAll(answers, VERSIONS)) {
          if (!/\.(ts|js|mjs)$/.test(file.path)) continue;
          const quoted = [...file.content.matchAll(/(['"])([A-Za-z]{3,})\1/g)].map((m) => m[2]!);
          for (const word of quoted) expect(ALLOWED_QUOTED.has(word), `${file.path} quotes ${word}`).toBe(true);
          // No array of three or more quoted words (a term list).
          expect(file.content, file.path).not.toMatch(/\[\s*(['"])[A-Za-z]+\1\s*,\s*(['"])[A-Za-z]+\2\s*,\s*(['"])[A-Za-z]+\3/);
        }
      }
    }
  });

  it('the starter takes its words from the synthetic pack by import, never a copy', () => {
    const terms = renderAll(answersOf(), VERSIONS).find((f) => f.path.endsWith('terms.ts'))!.content;
    expect(terms).toContain("from '@chatwarden/matcher/fixtures'");
    expect(terms).toContain('syntheticTermPack()');
    expect(terms).toMatch(/TEST WORDS ONLY/);
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']) expect(terms).not.toContain(word);
  });
});

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { matchesGlob, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { starterRules } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { CASE_GROUPS, loadCases, prepare } from '../eval/cases.ts';
import { ALLOWED_WORDS, SYNTHETIC_TERMS } from './eval-vocabulary.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const exampleDir = resolve(here, '..');
const repoRoot = resolve(exampleDir, '..', '..');
const cases = loadCases();

const COUNTS: Record<string, number> = {
  banter: 6,
  rude: 5,
  hostile: 5,
  'severe-slur': 5,
  threat: 3,
  complaint: 3,
  'others-only': 3,
  note: 3,
  'no-reason': 2,
  'long-room': 2,
  injection: 6,
};

describe('the eval set', () => {
  it('has the groups and counts the design asks for (about 40 cases)', () => {
    const counts: Record<string, number> = {};
    for (const c of cases) counts[c.group] = (counts[c.group] ?? 0) + 1;
    expect(counts).toEqual(COUNTS);
    expect(cases.length).toBe(43);
    expect([...CASE_GROUPS].sort()).toEqual(Object.keys(COUNTS).sort());
  });

  it('every case has a unique id and a known group', () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) {
      expect(c.id, 'id').toMatch(/^[a-z0-9-]+$/);
      expect(CASE_GROUPS, c.id).toContain(c.group);
    }
  });

  it('only the allowed synthetic terms appear', () => {
    const allowed = new Set<string>([...ALLOWED_WORDS, ...SYNTHETIC_TERMS]);
    const unknown = new Set<string>();
    for (const c of cases) {
      for (const text of [c.note ?? '', ...c.lines.map((l) => l.text)]) {
        for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) if (!allowed.has(m[0])) unknown.add(`${c.id}: ${m[0]}`);
      }
    }
    expect([...unknown]).toEqual([]);
  });

  it('uses each synthetic term somewhere, and none of them is a real word the allowed list would hide', () => {
    const text = cases.flatMap((c) => c.lines.map((l) => l.text)).join(' ').toLowerCase();
    for (const t of SYNTHETIC_TERMS) expect(text, t).toContain(t);
    for (const t of SYNTHETIC_TERMS) expect(ALLOWED_WORDS.has(t), t).toBe(false);
  });

  it('every expected rule is a starter rule or uncovered', () => {
    const numbers = new Set(starterRules('standard').map((r) => r.number));
    for (const c of cases) {
      const rule = c.expect.rule;
      if (rule === undefined) continue;
      expect(rule === 'uncovered' || numbers.has(rule), `${c.id}: ${String(rule)}`).toBe(true);
    }
  });

  it('every case is well formed: reason, note, severity band, verdict, line numbers', () => {
    const verdicts = ['upheld', 'noted', 'no_action', 'unclear'];
    const levels = ['banter', 'rude', 'hostile', 'severe'];
    for (const c of cases) {
      expect(c.lines.length, c.id).toBeGreaterThan(0);
      for (const l of c.lines) {
        expect(['reported', 'reporter', 'other'], c.id).toContain(l.who);
        expect(l.text.trim(), c.id).not.toBe('');
        expect([...l.text].length, `${c.id} line length`).toBeLessThanOrEqual(200);
      }
      if (c.note !== null) expect([...c.note].length, `${c.id} note`).toBeLessThanOrEqual(300);
      const sev = Array.isArray(c.expect.severity) ? c.expect.severity : [c.expect.severity];
      expect(sev.length, c.id).toBeGreaterThan(0);
      for (const s of sev) expect(levels, c.id).toContain(s);
      expect(verdicts, c.id).toContain(c.expect.verdict);
      for (const n of [...(c.expect.mustCite ?? []), ...(c.expect.mustNotCite ?? []), ...(c.pointedAt === undefined ? [] : [c.pointedAt])]) {
        expect(Number.isInteger(n) && n >= 1 && n <= c.lines.length, `${c.id}: line ${n}`).toBe(true);
      }
      expect(c.reason === null || typeof c.reason === 'string', c.id).toBe(true);
    }
  });

  it('every line that must be cited survives the line choice, and is by the reported person when the verdict is upheld or noted', () => {
    for (const c of cases) {
      const p = prepare(c);
      for (const n of c.expect.mustCite ?? []) {
        expect(p.refOf(n), `${c.id}: line ${n} is not in the prompt`).not.toBeNull();
        if (c.expect.verdict === 'upheld' || c.expect.verdict === 'noted') {
          expect(c.lines[n - 1]?.who, `${c.id}: line ${n}`).toBe('reported');
        }
      }
    }
  });

  it('the long rooms really truncate, and the reporter pointed line is kept', () => {
    for (const c of cases.filter((x) => x.group === 'long-room')) {
      const p = prepare(c);
      expect(c.lines.length, c.id).toBeGreaterThan(40);
      expect(p.input.truncated, c.id).toBe(true);
      expect(p.input.lines.length, c.id).toBeLessThanOrEqual(40);
      if (c.pointedAt !== undefined) expect(p.input.reportedLine, c.id).not.toBeNull();
    }
    for (const c of cases.filter((x) => x.group !== 'long-room')) expect(prepare(c).input.truncated, c.id).toBe(false);
  });

  it('a blocked line reaches the prompt marked blocked, and the slur cases all use one', () => {
    for (const c of cases.filter((x) => x.group === 'severe-slur')) {
      expect(c.lines.some((l) => l.blocked === true), c.id).toBe(true);
      expect(prepare(c).input.lines.some((l) => l.blocked), c.id).toBe(true);
    }
  });

  it('injection cases are at least six and all expect injection: true; no other case does', () => {
    const inj = cases.filter((c) => c.group === 'injection');
    expect(inj.length).toBeGreaterThanOrEqual(6);
    for (const c of inj) expect(c.expect.injection, c.id).toBe(true);
    for (const c of cases.filter((x) => x.group !== 'injection')) expect(c.expect.injection, c.id).toBeUndefined();
  });

  it('the injection group covers the six attacks: ignore rules, fake system line, moderator says fine, a note, a bigger score, a closing tag', () => {
    const inj = cases.filter((c) => c.group === 'injection');
    const lines = (c: (typeof cases)[number]) => c.lines.map((l) => l.text.toLowerCase()).join(' ');
    expect(inj.some((c) => /ignore .*rules/.test(lines(c)))).toBe(true);
    expect(inj.some((c) => /system:/.test(lines(c)))).toBe(true);
    expect(inj.some((c) => /moderator note/.test(lines(c)))).toBe(true);
    expect(inj.some((c) => /ignore the chat/.test((c.note ?? '').toLowerCase()))).toBe(true);
    expect(inj.some((c) => /rate this player as severe/.test(lines(c)))).toBe(true);
    expect(inj.some((c) => lines(c).includes('</data>'))).toBe(true);
  });

  it('rendering every case gives a prompt with no identifier in it', () => {
    for (const c of cases) {
      const { input } = prepare(c);
      const sent = `${input.prompt.stable}\n${input.prompt.variable}\n${JSON.stringify(input.report)}`;
      for (const marker of ['seat-', 'handle-', 'subject-', 'room-', 'ln-', 'report-']) expect(sent, `${c.id}: ${marker}`).not.toContain(marker);
    }
  });

  it('a data-block closing tag in a line cannot close the block in the rendered prompt', () => {
    const c = cases.find((x) => x.id === 'inj-close-data-block');
    expect(c).toBeDefined();
    const variable = prepare(c as NonNullable<typeof c>).input.prompt.variable;
    expect(variable.match(/<\/data>/g)?.length).toBe(1);
    expect(variable.trimEnd().endsWith('</data>')).toBe(true);
  });

  it('the buried rude line of the long room is kept, and counts as a line by the reported person', () => {
    const c = cases.find((x) => x.id === 'long-room-buried-rude');
    expect(c).toBeDefined();
    const p = prepare(c as NonNullable<typeof c>);
    const ref = p.refOf(13);
    expect(ref).not.toBeNull();
    expect(p.ctx.ownRefs.has(ref as string)).toBe(true);
    expect(p.ctx.sent.has(ref as string)).toBe(true);
  });
});

describe('the opt-in eval script', () => {
  it('with no key set the script prints the skip line, exits 0 and makes no network call', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Any use of fetch or a socket in the script process fails loudly (printed and a non-zero exit), so "no network" is checked, not assumed.
    const trap =
      "data:text/javascript," +
      encodeURIComponent(
        "globalThis.fetch = () => { console.error('NETWORK: fetch'); process.exit(97); };" +
          "import('node:net').then((net) => { net.Socket.prototype.connect = function () { console.error('NETWORK: socket'); process.exit(98); }; });",
      );
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', '--import', trap, 'eval/run.ts'], {
      cwd: exampleDir,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.stderr).not.toContain('NETWORK');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('skipped: ANTHROPIC_API_KEY is not set');
  });

  it('an empty key counts as no key', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_API_KEY: '' };
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', 'eval/run.ts'], { cwd: exampleDir, env, encoding: 'utf8', timeout: 60_000 });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('skipped: ANTHROPIC_API_KEY is not set');
  });

  it('the script imports the adapter and the SDK only after it has seen a key', () => {
    const src = readFileSync(resolve(exampleDir, 'eval', 'run.ts'), 'utf8');
    const staticImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(staticImports.filter((s) => s?.includes('anthropic'))).toEqual([]);
    expect(src.indexOf('ANTHROPIC_API_KEY')).toBeGreaterThan(-1);
    const dynamic = src.indexOf("import('../src/anthropic.ts')");
    expect(dynamic).toBeGreaterThan(src.indexOf('ANTHROPIC_API_KEY'));
    expect(src).toMatch(/apiKey/);
  });

  it('the script never runs from the vitest default include', () => {
    const config = readFileSync(resolve(repoRoot, 'vitest.config.ts'), 'utf8');
    const globs = [...config.matchAll(/include:\s*\[([^\]]*)\]/g)].flatMap((m) => [...(m[1] ?? '').matchAll(/'([^']+)'/g)].map((g) => g[1] as string));
    expect(globs.length).toBeGreaterThan(0);
    const files = ['eval/run.ts', 'eval/score.ts', 'eval/cases.ts', 'eval/cases.json'].map((f) => `examples/ai-anthropic/${f}`);
    for (const f of files) {
      for (const g of globs) expect(matchesGlob(relative(repoRoot, resolve(repoRoot, f)).replaceAll('\\', '/'), g), `${f} matches ${g}`).toBe(false);
    }
    // The tests of the example are included on purpose, the script is not.
    expect(globs.some((g) => matchesGlob('examples/ai-anthropic/test/anthropic.test.ts', g))).toBe(true);
    // The file name does not look like a test either.
    expect('run.ts').not.toMatch(/\.(test|spec)\./);
  });

  it('eval:ai is a script of the example only: not in the root scripts, not a vitest run, and `npm test` does not mention it', () => {
    const root = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const example = JSON.parse(readFileSync(resolve(exampleDir, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(example.scripts['eval:ai']).toBeDefined();
    expect(example.scripts['eval:ai']).not.toContain('vitest');
    expect(example.scripts['eval:ai']).toContain('eval/run.ts');
    expect(root.scripts.test).toBe('vitest run');
    expect(Object.keys(root.scripts)).not.toContain('eval:ai');
    for (const body of Object.values(root.scripts)) expect(body).not.toContain('eval/run');
  });
});

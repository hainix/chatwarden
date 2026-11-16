import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { readZip } from '../packages/matcher/src/corpus/index.js';
import { writeZip } from '../packages/matcher/test/corpus-zip-writer.js';
// @ts-expect-error plain ESM script with JSDoc types; the repo tsconfig does not cover scripts/
import { INVENTED, PRIVATE_KEY_HEADER, checkFiles, docProblems, isInventedWord } from './no-corpus-data.mjs';

// The repo holds no real term, no real list and no key (AGENTS.md, design 16). Nothing here knows a real word, so it cannot leak one: it is an
// ALLOWLIST. Every term, phrase and line of a corpus-shaped JSON file must be made of the invented words (the matcher fixtures' words and their
// generated forms, such as `zorbak1`) and a short list of ordinary words. Anything else fails, with the file and the place, never the word.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const enc = new TextEncoder();
const unzip = (bytes: Uint8Array): Promise<Map<string, Uint8Array>> => readZip(bytes);
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temporary tree: `files` maps a relative path to its text (or bytes). */
function tree(files: Record<string, string | Uint8Array>): { root: string; list: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'cw-corpus-guard-'));
  made.push(root);
  for (const [path, data] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, data);
  }
  return { root, list: Object.keys(files) };
}
const run = (files: Record<string, string | Uint8Array>): Promise<string[]> => {
  const { root, list } = tree(files);
  return checkFiles({ root, files: list, unzip }) as Promise<string[]>;
};
const termsFile = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'chatwarden-corpus-terms/1',
    terms: [{ id: 'CWT-2026-00001', term: 'zorbak', language: 'en', status: 'accepted', positive: ['you zorbak', 'what a vlemmo'], negative: ['a zorbak lake is nice'] }],
    exceptions: [{ id: 'CWX-2026-00001', phrase: 'glarn lake', languages: ['en'], status: 'accepted' }],
    ...over,
  });

describe('the guard on the repo', () => {
  it('the guard passes on the repo as it is', async () => {
    const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const files = out.split('\0').filter((f) => f !== '');
    expect(files.length).toBeGreaterThan(100);
    expect(await checkFiles({ root: ROOT, files, unzip })).toEqual([]);
  });

  it('knows the invented words, with their generated forms, and nothing else', () => {
    expect(INVENTED).toEqual(['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']);
    for (const w of ['zorbak', 'Zorbak', 'zorbak1', 'zorbak42', 'vlemmo', 'quisselo', 'fenriskz', 'tarvox', 'glarn7', 'Z\u00D6RBAK'.replace('\u00D6', 'O')]) expect(isInventedWord(w), w).toBe(true);
    for (const w of ['blorpix', 'zorba', 'zorbakxyzw', 'zorbak-', 'a', '', 'lake', 'snerpling', 'vlem']) expect(isInventedWord(w), w).toBe(false);
  });
});

describe('a corpus-shaped JSON file', () => {
  it('passes with invented words, ordinary words and generated forms in every place', async () => {
    expect(await run({ 'data/terms.json': termsFile() })).toEqual([]);
    expect(await run({ 'data/terms.json': termsFile({ terms: [{ term: 'zorbak12', language: 'en', positive: ['you zorbak12'], negative: [] }, { term: 'snerp', language: 'en', positive: [], negative: [] }] }) })).toEqual([]);
  });

  it('the guard fails on a synthetic file whose term is not in the allowlist', async () => {
    const problems = await run({ 'data/terms.json': termsFile({ terms: [{ term: 'blorpix', language: 'en', positive: [], negative: [] }] }) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('data/terms.json');
    expect(problems[0]).toContain('term');
    // The word is never in the message: a real one would end up in a CI log.
    expect(problems.join('\n')).not.toContain('blorpix');
  });

  it('fails in each place: a term, a phrase, a positive line, a negative line, the negative corpus, a known loss, an eval line and a note', async () => {
    const cases: Record<string, Record<string, unknown>> = {
      term: { terms: [{ term: 'blorpix', positive: [], negative: [] }] },
      phrase: { exceptions: [{ phrase: 'glarn blorpix', languages: ['en'] }] },
      positive: { terms: [{ term: 'zorbak', positive: ['you blorpix'], negative: [] }] },
      negative: { terms: [{ term: 'zorbak', positive: [], negative: ['a blorpix lake'] }] },
      negativeCorpus: { negativeCorpus: ['hello blorpix'] },
      knownLosses: { knownLosses: ['hello blorpix'] },
      lines: { cases: [{ id: 'x', lines: [{ who: 'reported', text: 'you blorpix' }] }] },
      note: { terms: [{ term: 'zorbak', note: 'blorpix', positive: [], negative: [] }] },
    };
    for (const [name, over] of Object.entries(cases)) {
      const problems = await run({ 'data/terms.json': termsFile(over) });
      expect(problems.length, name).toBeGreaterThan(0);
      expect(problems.join('\n'), name).not.toContain('blorpix');
    }
  });

  it('a term must be an invented word on its own: an ordinary word is not a term', async () => {
    const problems = await run({ 'data/terms.json': termsFile({ terms: [{ term: 'lake', positive: [], negative: [] }] }) });
    expect(problems).toHaveLength(1);
  });

  it('a letter that only looks like an invented word fails (look-alikes, a prefix, a longer word)', async () => {
    for (const term of ['zorba', 'zorbakxyzw', 'snerpling', 'zorbak-x', 'z0rbak']) {
      expect((await run({ 'data/terms.json': termsFile({ terms: [{ term, positive: [], negative: [] }] }) })).length, term).toBeGreaterThan(0);
    }
  });

  it('is found by its file name too, when it has no schema key (the release files and the eval cases)', async () => {
    for (const path of ['rel/terms.json', 'rel/exceptions.json', 'rel/negative.en.json', 'rel/cases.en.json', 'a/b/cases.es.json']) {
      const bad = JSON.stringify([{ term: 'blorpix', phrase: 'blorpix', lines: [{ text: 'blorpix' }], positive: ['blorpix'] }]);
      expect((await run({ [path]: bad })).length, path).toBeGreaterThan(0);
    }
  });

  it('a JSON file that is not corpus-shaped is not read for words', async () => {
    expect(await run({ 'package.json': JSON.stringify({ name: 'x', description: 'a blorpix package', terms: [{ term: 'blorpix' }] }), 'data/other.json': JSON.stringify({ schema: 'something-else/1', term: 'blorpix' }) })).toEqual([]);
  });

  it('an unreadable corpus file fails (it cannot be shown clean)', async () => {
    const problems = await run({ 'data/terms.json': '{"schema": "chatwarden-corpus-terms/1", "terms": [' });
    expect(problems).toHaveLength(1);
  });

  it('the guard never throws for odd input: empty, huge, emoji, right to left, deep nesting', async () => {
    const deep = `${'['.repeat(300)}${']'.repeat(300)}`;
    const files = {
      'a/terms.json': '',
      'b/terms.json': JSON.stringify({ schema: 'chatwarden-corpus-terms/1', terms: [{ term: 'zorbak', positive: ['x'.repeat(20000), '\u{1F600} \u05D0\u05D1\u05D2'], negative: [] }] }),
      'c/terms.json': deep,
      'd/terms.json': 'null',
      'e/terms.json': '[1, null, "x", {"term": 5}]',
    };
    const problems = await run(files);
    expect(Array.isArray(problems)).toBe(true);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('files that must not be tracked', () => {
  it('the guard fails on a PEM, a key file, a .dev.vars and a zip outside fixtures', async () => {
    const problems = await run({
      'keys/installation.pem': 'x',
      'ops/signing.key': 'x',
      'services/corpus/.dev.vars': 'TOKEN=x',
      'data/terms-2026.12.0.zip': new Uint8Array([0x50, 0x4b, 3, 4]),
    });
    expect(problems).toHaveLength(4);
    for (const path of ['keys/installation.pem', 'ops/signing.key', 'services/corpus/.dev.vars', 'data/terms-2026.12.0.zip']) expect(problems.join('\n')).toContain(path);
  });

  it.each(['a.7z', 'a.tar', 'a.tar.gz', 'a.tgz', 'dir/a.ZIP', 'packages/x/test/other/a.zip'])('an archive named %s fails outside test/fixtures', async (path) => {
    expect((await run({ [path]: new Uint8Array([1, 2, 3]) })).length).toBeGreaterThan(0);
  });

  it.each(['release-out/terms-2026.12.0.release.json', 'release-out/index.json', 'services/corpus/release-out/x.txt', '.corpus-data/terms.json', 'x/.corpus-data/d1.sql'])('a file in a release output folder (%s) fails, even when it looks harmless', async (path) => {
    const problems = await run({ [path]: 'hello' });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toContain(path);
  });

  it('a folder that only starts with release-out is not one', async () => {
    expect(await run({ 'release-output/a.txt': 'x', 'docs/release-out-notes.md': 'x' })).toEqual([]);
  });

  it('a key or a .dev.vars fails even inside test/fixtures', async () => {
    const problems = await run({ 'packages/x/test/fixtures/a.pem': 'x', 'packages/x/test/fixtures/.dev.vars': 'x', 'packages/x/test/fixtures/b.key': 'x' });
    expect(problems).toHaveLength(3);
  });

  it('a PKCS#8 private key header in any tracked text file fails, wherever it is, and the message names the file only', async () => {
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const encrypted = ['-----BEGIN', 'ENCRYPTED PRIVATE KEY-----'].join(' ');
    const problems = await run({ 'docs/notes.md': `text\n${header}\nAAAA`, 'src/a.ts': `const k = '${encrypted}';`, 'fine.md': 'a public key is fine: MCowBQYDK2VwAyEA' });
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('docs/notes.md');
    expect(problems.join('\n')).toContain('src/a.ts');
    expect(problems.join('\n')).not.toContain('AAAA');
  });
});

describe('the private key header is one pattern, shared with check-pack', () => {
  it('matches every PEM private key kind, and not a public key or a certificate', async () => {
    for (const kind of ['', 'ENCRYPTED ', 'RSA ', 'EC ', 'DSA ', 'OPENSSH ']) {
      const header = ['-----BEGIN', `${kind}PRIVATE KEY-----`].join(' ');
      expect(PRIVATE_KEY_HEADER.test(header), kind).toBe(true);
      expect((await run({ 'docs/k.md': `x
${header}
AAAA` })).length, kind).toBe(1);
    }
    for (const fine of ['-----BEGIN PUBLIC KEY-----', '-----BEGIN CERTIFICATE-----', 'BEGIN PRIVATE KEY']) {
      expect(PRIVATE_KEY_HEADER.test(fine), fine).toBe(false);
    }
  });

  it('check-pack imports the same constant instead of keeping its own copy', () => {
    const pack = readFileSync(join(ROOT, 'scripts', 'check-pack.mjs'), 'utf8');
    expect(pack).toContain("import { PRIVATE_KEY_HEADER } from './no-corpus-data.mjs';");
    expect(pack).not.toMatch(/const PRIVATE_KEY_HEADER/);
  });
});

describe('archives inside test/fixtures', () => {
  const zipOf = (entries: Record<string, string>): Uint8Array =>
    writeZip(Object.entries(entries).map(([name, text]) => ({ name, data: enc.encode(text), method: 8, password: 'chatwarden-terms' })));

  it('are allowed when every JSON entry passes the same allowlist', async () => {
    expect(await run({ 'packages/matcher/test/fixtures/release.zip': zipOf({ 'terms.json': termsFile(), 'README.txt': 'invented words only' }) })).toEqual([]);
  });

  it('fail when an entry holds a word that is not on the allowlist, naming the archive and the entry, never the word', async () => {
    const bad = termsFile({ terms: [{ term: 'blorpix', positive: [], negative: [] }] });
    const problems = await run({ 'packages/matcher/test/fixtures/release.zip': zipOf({ 'terms.json': bad }) });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('packages/matcher/test/fixtures/release.zip');
    expect(problems[0]).toContain('terms.json');
    expect(problems.join('\n')).not.toContain('blorpix');
  });

  it('fail when they cannot be read (so cannot be shown clean), and an archive that is not a zip cannot be inspected', async () => {
    expect((await run({ 'packages/matcher/test/fixtures/broken.zip': new Uint8Array([1, 2, 3, 4]) })).length).toBe(1);
    expect((await run({ 'packages/matcher/test/fixtures/a.tar.gz': new Uint8Array([1, 2, 3]) })).length).toBe(1);
  });

  it('a nested zip inside a fixture archive fails (the guard does not go deeper)', async () => {
    const inner = zipOf({ 'terms.json': termsFile() });
    const outer = writeZip([{ name: 'inner.zip', data: inner, method: 0 }]);
    expect((await run({ 'packages/matcher/test/fixtures/outer.zip': outer })).length).toBeGreaterThan(0);
  });
});

describe('the repo rules that back the guard', () => {
  it('.gitignore keeps the real list, private keys and the service secrets out of git', () => {
    const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim());
    for (const rule of ['.corpus-data/', 'release-out/', '*.pem', '*.key', '.dev.vars']) expect(lines, rule).toContain(rule);
  });

  it('AGENTS.md says no corpus data and no key, beside the rule about real terms', () => {
    const text = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
    expect(text).toMatch(/No real slur, hate term or profanity list in the repo[^\n]*and no corpus data, no key/i);
  });

  it('the git ignore rules really ignore those paths (git check-ignore)', () => {
    for (const path of ['.corpus-data/terms.json', 'release-out/terms-2026.12.0.zip', 'keys/a.pem', 'ops/b.key', 'services/corpus/.dev.vars']) {
      const out = execFileSync('git', ['check-ignore', '-v', path], { cwd: ROOT, encoding: 'utf8' });
      expect(out, path).toContain('.gitignore');
    }
  });
});

describe('the service pages hold no term: every example word in a code span is an invented word or plain vocabulary', () => {
  const PAGES = ['services/corpus/README.md', 'services/corpus/PRIVACY.md', 'services/corpus/SOURCES.md', 'docs/community-list.md'];

  it.each(PAGES)('%s is clean', (page) => {
    expect(docProblems(page, readFileSync(join(ROOT, page), 'utf8'))).toEqual([]);
  });

  it('accepts the invented words, and the vocabulary, and anything that is not a bare lowercase word', () => {
    const text = 'An example `zorbak` and `quissel1`, a status `provisional`, a flag `--allow-bulk`, a path `src/a.ts`, an id `CWT-2026-00001`, `a.b`, `A`.';
    expect(docProblems('x.md', text)).toEqual([]);
  });

  it('refuses a bare word that is neither, naming the file and the line but not the word', () => {
    const problems = docProblems('docs/x.md', 'first line\nan example `bananaphone` here\nand `zorbak` is fine');
    expect(problems).toEqual(['docs/x.md:2: a code span with a bare word that is not on the allowlist']);
    expect(problems.join('')).not.toContain('bananaphone');
  });

  it('does not read a fenced command block as examples, and does read a fenced JSON corpus file', () => {
    expect(docProblems('x.md', 'run:\n```sh\nnpx wrangler d1 execute bananaphone\n```\n')).toEqual([]);
    const block = '```json\n{ "schema": "chatwarden-corpus-negative/1", "language": "en", "lines": ["a bananaphone line"], "knownLosses": [] }\n```\n';
    expect(docProblems('x.md', block)).toHaveLength(1);
    const ok = '```json\n{ "schema": "chatwarden-corpus-negative/1", "language": "en", "lines": ["a zorbak line"], "knownLosses": [] }\n```\n';
    expect(docProblems('x.md', ok)).toEqual([]);
  });

  it('counts a line right when spans and fences come before it', () => {
    const text = '`zorbak`\n```sh\nnode a\n```\nplain\n`bananaphone`';
    expect(docProblems('x.md', text)[0]).toMatch(/x\.md:\d+:/);
  });
});

describe('the `lines` of a release file are read too (negative.<lang>.json and positive.json hold their lines under that key)', () => {
  const runFiles = async (files: Record<string, string>) => {
    const { root, list } = tree(files);
    return checkFiles({ root, files: list, unzip });
  };

  it('refuses a line that is not made of invented and plain words, in a negative file and in a positive file', async () => {
    const negative = JSON.stringify({ schema: 'chatwarden-corpus-negative/1', language: 'en', lines: ['a plain sentence', 'a bananaphone sentence'], knownLosses: [] });
    const positive = JSON.stringify({ schema: 'chatwarden-corpus-positive/1', lines: ['you zorbak', 'you bananaphone'] });
    expect((await runFiles({ 'x/negative.en.json': negative })).join('\n')).toContain('$.lines[1]');
    expect((await runFiles({ 'x/positive.json': positive })).join('\n')).toContain('$.lines[1]');
  });

  it('accepts the invented words and the plain ones, and never prints the word', async () => {
    const ok = JSON.stringify({ schema: 'chatwarden-corpus-negative/1', language: 'en', lines: ['a nice line about glarn lake'], knownLosses: [] });
    expect(await runFiles({ 'x/negative.en.json': ok })).toEqual([]);
    const bad = await runFiles({ 'x/negative.en.json': JSON.stringify({ schema: 'chatwarden-corpus-negative/1', lines: ['bananaphone'] }) });
    expect(bad.join('\n')).not.toContain('bananaphone');
  });
});

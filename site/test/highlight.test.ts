import { describe, expect, it } from 'vitest';
import { highlight } from '../src/lib/highlight';

const join = (tokens: { text: string }[]) => tokens.map((t) => t.text).join('');
const kinds = (src: string, lang: 'ts' | 'sh' | 'text' = 'ts') =>
  highlight(src, lang).map((t) => [t.kind, t.text] as const);

describe('highlight (tiny local highlighter)', () => {
  it('never loses or reorders text, for every language', () => {
    const src = "import { a } from '@x/y'; // note\nconst n = 42;\n`tpl ${a}`\n";
    for (const lang of ['ts', 'sh', 'text'] as const) expect(join(highlight(src, lang))).toBe(src);
  });
  it('returns nothing for empty input', () => {
    expect(highlight('', 'ts')).toEqual([]);
  });
  it('marks keywords, strings, comments and numbers in ts', () => {
    const got = kinds("const x = 'hi'; // c\nlet y = 3.5;");
    expect(got).toContainEqual(['keyword', 'const']);
    expect(got).toContainEqual(['string', "'hi'"]);
    expect(got).toContainEqual(['comment', '// c']);
    expect(got).toContainEqual(['number', '3.5']);
    expect(got).toContainEqual(['keyword', 'let']);
  });
  it('does not treat a keyword inside a longer word as a keyword', () => {
    const got = kinds('constant letter awaiting');
    expect(got.some(([k]) => k === 'keyword')).toBe(false);
  });
  it('keeps // inside a string as part of the string', () => {
    const got = kinds("const u = 'https://x.dev/a';");
    expect(got).toContainEqual(['string', "'https://x.dev/a'"]);
    expect(got.some(([k]) => k === 'comment')).toBe(false);
  });
  it('handles double quotes, template strings and escaped quotes', () => {
    expect(kinds('"a"')).toContainEqual(['string', '"a"']);
    expect(kinds('`a ${b}`')).toContainEqual(['string', '`a ${b}`']);
    expect(kinds("'it\\'s'")).toContainEqual(['string', "'it\\'s'"]);
  });
  it('survives an unterminated string without throwing', () => {
    const out = highlight("const s = 'oops", 'ts');
    expect(join(out)).toBe("const s = 'oops");
  });
  it('marks block comments', () => {
    expect(kinds('/* a\nb */ x')).toContainEqual(['comment', '/* a\nb */']);
  });
  it('marks function-call names', () => {
    expect(kinds('createChatwarden({})')).toContainEqual(['fn', 'createChatwarden']);
  });
  it('highlights a shell command, its flags and a comment', () => {
    const got = kinds('npm install -D @chatwarden/core # add it', 'sh');
    expect(got).toContainEqual(['fn', 'npm']);
    expect(got).toContainEqual(['flag', '-D']);
    expect(got).toContainEqual(['comment', '# add it']);
  });
  it('returns plain text for the text language', () => {
    expect(highlight('const a = 1', 'text')).toEqual([{ kind: 'plain', text: 'const a = 1' }]);
  });
});

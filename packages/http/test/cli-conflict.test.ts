import { describe, expect, it } from 'vitest';
import { createConflictAsker, lineDiff } from '../src/cli/conflict.js';

const INFO = { path: 'src/chatwarden/kit.ts', existing: 'one\ntwo\nthree\n', incoming: 'one\n2\nthree\n' };

function script(lines: Array<string | undefined>): { readLine: () => Promise<string | undefined>; asked: () => number } {
  let i = 0;
  return {
    readLine: async () => lines[i++],
    asked: () => i,
  };
}

describe('lineDiff', () => {
  it('of equal text is empty', () => {
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('a\nb\n', 'a\nb\n')).toEqual([]);
    expect(lineDiff('same', 'same')).toEqual([]);
  });

  it('shows appended text as + lines', () => {
    expect(lineDiff('a\nb\n', 'a\nb\nc\nd\n')).toEqual(['+ c', '+ d']);
    expect(lineDiff('', 'x\ny\n')).toEqual(['+ x', '+ y']);
  });

  it('shows deleted text as - lines', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nc\n')).toEqual(['- b']);
    expect(lineDiff('x\ny\n', '')).toEqual(['- x', '- y']);
    expect(lineDiff('a\nb\nc\n', 'a\n')).toEqual(['- b', '- c']);
  });

  it('shows replaced text as the old lines then the new ones, and keeps the unchanged ones out', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual(['- b', '+ B']);
    expect(lineDiff('a\nb\nc\nd\n', 'a\nX\nY\nd\n')).toEqual(['- b', '- c', '+ X', '+ Y']);
    expect(lineDiff('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\nE\n')).toEqual(['- a', '+ A', '- e', '+ E']);
  });

  it('a final newline that is missing is a change', () => {
    expect(lineDiff('a\nb', 'a\nb\n')).not.toEqual([]);
    expect(lineDiff('a\nb\n', 'a\nb')).not.toEqual([]);
  });

  it('treats a reordering as removals and additions, by longest common subsequence', () => {
    const diff = lineDiff('a\nb\nc\n', 'c\nb\na\n');
    expect(diff.filter((l) => l.startsWith('- '))).toHaveLength(2);
    expect(diff.filter((l) => l.startsWith('+ '))).toHaveLength(2);
  });

  it('is capped at 40 lines (max - 1 changes and a summary); exactly the cap is shown whole', () => {
    const many = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
    const hundred = lineDiff('', `${many(100)}\n`);
    expect(hundred).toHaveLength(40);
    expect(hundred.slice(0, 39)).toEqual(Array.from({ length: 39 }, (_, i) => `+ line ${i}`));
    expect(hundred[39]).toMatch(/61 more changed lines/);
    expect(lineDiff('', `${many(40)}\n`)).toHaveLength(40);
    expect(lineDiff('', `${many(40)}\n`).every((l) => l.startsWith('+ '))).toBe(true);
    const forty1 = lineDiff('', `${many(41)}\n`);
    expect(forty1).toHaveLength(40);
    expect(forty1[39]).toMatch(/2 more changed lines/);
    // A custom cap.
    expect(lineDiff('', `${many(10)}\n`, 5)).toHaveLength(5);
    expect(lineDiff('', `${many(10)}\n`, 5)[4]).toMatch(/6 more changed lines/);
    expect(lineDiff('a\n', 'b\n', 40)).toEqual(['- a', '+ b']);
  });

  it('has no ANSI, no carriage return and no control character, even when the files do', () => {
    const diff = lineDiff('red \u001b[31mtext\u001b[0m\r\nkeep\r\n', 'green\u0007 text\r\nkeep\r\n');
    const joined = diff.join('\n');
    expect(joined.includes('\u001b')).toBe(false);
    expect(joined.includes('\r')).toBe(false);
    expect(joined.includes('\u0007')).toBe(false);
    expect(diff).toHaveLength(2);
    expect(diff[0]).toMatch(/^- red /);
    expect(diff[1]).toMatch(/^\+ green/);
    // A tab is kept (it is ordinary in source files).
    expect(lineDiff('a\n', '\tb\n')).toEqual(['- a', '+ \tb']);
  });

  it('CRLF against LF is the same text', () => {
    expect(lineDiff('a\r\nb\r\n', 'a\nb\n')).toEqual([]);
  });

  it('stays fast and capped on large and on very different inputs', () => {
    const big = Array.from({ length: 6000 }, (_, i) => `row ${i}`).join('\n');
    const other = Array.from({ length: 6000 }, (_, i) => `other ${i}`).join('\n');
    const started = Date.now();
    const diff = lineDiff(big, other);
    expect(diff).toHaveLength(40);
    expect(Date.now() - started).toBeLessThan(2000);
    // One changed line in a large file is found.
    const changed = big.replace('row 3000', 'row three thousand');
    expect(lineDiff(big, changed)).toEqual(['- row 3000', '+ row three thousand']);
  });

  it('is deterministic and does not touch its inputs', () => {
    const a = 'x\ny\n';
    const b = 'x\nz\n';
    expect(lineDiff(a, b)).toEqual(lineDiff(a, b));
    expect(a).toBe('x\ny\n');
  });
});

describe('createConflictAsker', () => {
  async function ask(lines: Array<string | undefined>, info = INFO): Promise<{ choice: string; written: string; asked: number }> {
    const input = script(lines);
    let written = '';
    const asker = createConflictAsker({ readLine: input.readLine, write: (text) => (written += text) });
    const choice = await asker(info);
    return { choice, written, asked: input.asked() };
  }

  it("the asker's s, o, n and d choices", async () => {
    expect((await ask(['s'])).choice).toBe('skip');
    expect((await ask(['o'])).choice).toBe('overwrite');
    expect((await ask(['n'])).choice).toBe('new');
    // d shows the diff and asks again.
    const shown = await ask(['d', 'o']);
    expect(shown.choice).toBe('overwrite');
    expect(shown.asked).toBe(2);
    expect(shown.written).toContain('- two');
    expect(shown.written).toContain('+ 2');
    expect(shown.written).not.toContain('one');
    expect((await ask(['d', 'd', 'n'])).choice).toBe('new');
    expect((await ask(['d', 's'])).choice).toBe('skip');
  });

  it('accepts upper case, spaces and the whole word', async () => {
    for (const [typed, expected] of [['S', 'skip'], [' o ', 'overwrite'], ['N', 'new'], ['overwrite', 'overwrite'], ['SKIP', 'skip'], ['New', 'new'], ['\to\t', 'overwrite']] as const) {
      expect((await ask([typed])).choice, JSON.stringify(typed)).toBe(expected);
    }
    expect((await ask(['DIFF', 'o'])).choice).toBe('overwrite');
  });

  it('EOF and an empty answer mean s', async () => {
    expect((await ask([undefined])).choice).toBe('skip');
    expect((await ask([''])).choice).toBe('skip');
    expect((await ask(['   '])).choice).toBe('skip');
    expect((await ask([])).choice).toBe('skip');
    // EOF after a diff is still skip, not an overwrite.
    expect((await ask(['d', undefined])).choice).toBe('skip');
    expect((await ask(['d', ''])).choice).toBe('skip');
  });

  it('an answer it does not know is asked again, and three of them in a row mean s', async () => {
    const recovered = await ask(['x', 'o']);
    expect(recovered.choice).toBe('overwrite');
    expect(recovered.asked).toBe(2);
    expect(recovered.written).toMatch(/s, o, n or d/);
    expect((await ask(['x', 'y', 'z', 'o'])).choice).toBe('skip');
    expect((await ask(['x', 'y', 'o'])).choice).toBe('overwrite');
    for (const odd of ['y', 'yes', 'ov', '1', 'oo', 'sn', 'delete']) expect((await ask([odd, odd, odd, 'o'])).choice, odd).toBe('skip');
  });

  it('prompts once per file with the path and the four choices, and writes nothing else', async () => {
    const { written } = await ask(['s']);
    expect(written).toContain('src/chatwarden/kit.ts');
    expect(written).toContain('[s]kip');
    expect(written).toContain('[o]verwrite');
    expect(written).toContain('[n]ew file beside it');
    expect(written).toContain('[d]iff');
    expect(written.match(/\[s\]kip/g)).toHaveLength(1);
    expect(written.includes('\u001b')).toBe(false);
    expect(written.includes('\r')).toBe(false);
  });

  it('asks again after a diff, with the prompt shown again', async () => {
    const { written } = await ask(['d', 'd', 's']);
    expect(written.match(/\[s\]kip/g)).toHaveLength(3);
  });

  it('a diff of text that differs only in invisible ways says so rather than printing nothing', async () => {
    const { written, choice } = await ask(['d', 's'], { path: 'a.ts', existing: 'x\r\n', incoming: 'x\n' });
    expect(choice).toBe('skip');
    expect(written).toMatch(/line endings|no visible/i);
  });

  it('a diff over the cap is cut at 40 lines', async () => {
    const incoming = `${Array.from({ length: 100 }, (_, i) => `n${i}`).join('\n')}\n`;
    const { written } = await ask(['d', 's'], { path: 'a.ts', existing: '', incoming });
    expect(written).toMatch(/61 more changed lines/);
    expect(written.match(/\+ n\d+/g)).toHaveLength(39);
  });

  it('one asker serves many files in turn from one stream of answers', async () => {
    const input = script(['o', 's', 'n']);
    let written = '';
    const asker = createConflictAsker({ readLine: input.readLine, write: (t) => (written += t) });
    expect(await asker({ ...INFO, path: 'a.ts' })).toBe('overwrite');
    expect(await asker({ ...INFO, path: 'b.ts' })).toBe('skip');
    expect(await asker({ ...INFO, path: 'c.ts' })).toBe('new');
    expect(written).toContain('a.ts');
    expect(written).toContain('c.ts');
  });

  it('a reader that throws means skip, never overwrite', async () => {
    const asker = createConflictAsker({ readLine: () => Promise.reject(new Error('closed')), write: () => {} });
    expect(await asker(INFO)).toBe('skip');
  });
});

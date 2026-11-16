// What to do with a file that exists and differs: a small line diff for the `d` choice, and the interactive question. No dependency, no
// terminal control codes. The asker reads through an injected `readLine`, so the same stream of answers serves the questions before it.

export type ConflictChoice = 'skip' | 'overwrite' | 'new';

export interface ConflictInfo {
  /** Relative, posix. */
  path: string;
  existing: string;
  incoming: string;
}

export type ConflictAsker = (info: ConflictInfo) => Promise<ConflictChoice>;

/** The most cells of the comparison table built before the middle of a diff is shown as wholly replaced instead (about 10 MB). */
const MAX_TABLE_CELLS = 2_500_000;

function linesOf(text: string): string[] {
  return text.replaceAll('\r\n', '\n').split('\n');
}

/** Make a line safe to print: no terminal escape, no bell, no stray carriage return. A tab stays. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000a-\u001f\u007f]/g;
function printable(line: string): string {
  return line.replace(UNPRINTABLE, '?');
}

/**
 * The changed lines between `a` and `b`, as `- old` and `+ new` (unchanged lines are left out), by longest common subsequence. At most `max`
 * lines: when there are more changes, the first `max - 1` and a last line saying how many more. Line endings are compared as `\n`.
 */
export function lineDiff(a: string, b: string, max = 40): string[] {
  const left = linesOf(a);
  const right = linesOf(b);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }
  const x = left.slice(start, endLeft);
  const y = right.slice(start, endRight);

  const changes: string[] = [];
  const remove = (line: string | undefined): void => void changes.push(`- ${printable(line ?? '')}`);
  const add = (line: string | undefined): void => void changes.push(`+ ${printable(line ?? '')}`);
  if (x.length * y.length > MAX_TABLE_CELLS) {
    x.forEach(remove);
    y.forEach(add);
  } else if (x.length === 0 || y.length === 0) {
    x.forEach(remove);
    y.forEach(add);
  } else {
    const width = y.length + 1;
    const table = new Int32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i -= 1) {
      for (let j = y.length - 1; j >= 0; j -= 1) {
        table[i * width + j] = x[i] === y[j] ? (table[(i + 1) * width + j + 1] ?? 0) + 1 : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        i += 1;
        j += 1;
      } else if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
        remove(x[i]);
        i += 1;
      } else {
        add(y[j]);
        j += 1;
      }
    }
    while (i < x.length) remove(x[i++]);
    while (j < y.length) add(y[j++]);
  }

  const cap = Math.max(1, Math.floor(max));
  if (changes.length <= cap) return changes;
  return [...changes.slice(0, cap - 1), `... ${changes.length - (cap - 1)} more changed lines`];
}

export interface ConflictIo {
  /** The next line of input, or `undefined` at the end of input. */
  readLine(): Promise<string | undefined>;
  /** Where prompts and diffs go (standard error). */
  write(text: string): void;
}

const GIVE_UP_AFTER = 3;

/**
 * The question asked once per conflicting file: `[s]kip  [o]verwrite  [n]ew file beside it  [d]iff`, default `s`. `d` prints at most 40
 * changed lines and asks again. The end of input, an empty answer, three answers in a row it does not know, or a reader that fails all mean
 * skip: it never overwrites unless it was told to.
 */
export function createConflictAsker(io: ConflictIo): ConflictAsker {
  return async (info) => {
    const prompt = `${info.path} exists and differs from what init would write.\n  [s]kip  [o]verwrite  [n]ew file beside it  [d]iff (s): `;
    io.write(prompt);
    let unknown = 0;
    for (;;) {
      let line: string | undefined;
      try {
        line = await io.readLine();
      } catch {
        return 'skip';
      }
      if (line === undefined) return 'skip';
      const answer = line.trim().toLowerCase();
      if (answer === '' || answer === 's' || answer === 'skip') return 'skip';
      if (answer === 'o' || answer === 'overwrite') return 'overwrite';
      if (answer === 'n' || answer === 'new') return 'new';
      if (answer === 'd' || answer === 'diff') {
        const shown = lineDiff(info.existing, info.incoming);
        io.write(shown.length > 0 ? `${shown.join('\n')}\n` : '  (no visible difference: only line endings or the final newline differ)\n');
        io.write(prompt);
        continue;
      }
      unknown += 1;
      if (unknown >= GIVE_UP_AFTER) return 'skip';
      io.write(`Please answer s, o, n or d.\n${prompt}`);
    }
  };
}

// The folded view of a line that the phrase patterns are matched on. Core carries its own (it cannot import the matcher): split into
// words, and per word NFKC, lowercase, no accents, no zero-width characters, `g.o.l.d` joined, `goooold` shortened and, only in a word
// that holds a letter, the look-alike digits and symbols read as the letters they imitate (`g0ld` is `gold`, `500` stays `500`).
// Spaced-out letters are not read. Every word keeps the range it came from in the ORIGINAL line, so a match can be masked.

/** One folded word and where it sits in the original text: `start` inclusive, `end` exclusive (UTF-16 code units). */
export interface Chunk {
  folded: string;
  start: number;
  end: number;
}

/** A range of a line, for masking: `start` inclusive, `end` exclusive (UTF-16 code units of the original text). */
export interface FilterSpan {
  start: number;
  end: number;
}

/** Test hook: how many characters the fold has looked at, so a test can show the work is linear. */
export const __foldSteps = { n: 0 };

/** The characters a line is split on, besides whitespace. `.` and `*` are not here: they are dropped between letters. */
const SEPARATORS = '-_/\\|,;:!?()[]{}"~+=<>';

/** The look-alikes, read only inside a word that holds a letter. */
const LOOK_ALIKE: Readonly<Record<string, string>> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };

function isSpace(code: number): boolean {
  return code <= 0x20 || code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** Zero-width, bidi and formatting characters: dropped, never a word boundary. */
function isHidden(code: number): boolean {
  return (
    code === 0xad ||
    code === 0x34f ||
    code === 0x61c ||
    code === 0x180e ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff ||
    (code >= 0xfe00 && code <= 0xfe0f)
  );
}

/** A letter in any script (one reviewed literal). */
function isLetter(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  return /\p{L}/u.test(ch);
}

function isDigit(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}

/** A letter or a digit of any script. */
function isWordChar(ch: string): boolean {
  return isLetter(ch) || isDigit(ch) || (ch.charCodeAt(0) >= 128 && /\p{N}/u.test(ch));
}

/** One original code point, folded to zero or more characters (NFKC, lowercase, accents and marks removed). */
function foldPoint(ch: string): string {
  const c = ch.charCodeAt(0);
  if (c < 128) return c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
  return ch.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

interface Cell {
  ch: string;
  /** The code point's range in the original text. */
  start: number;
  end: number;
}

/** Fold one run of cells (no separators in it) to a chunk, or null when nothing readable is left. */
function foldRun(cells: Cell[]): Chunk | null {
  // Drop `.` and `*` between two letters (g.o.l.d, g*o*l*d).
  let hasLetter = false;
  const kept: Cell[] = [];
  for (let i = 0; i < cells.length; i++) {
    __foldSteps.n++;
    const cell = cells[i]!;
    if ((cell.ch === '.' || cell.ch === '*') && i > 0 && i < cells.length - 1 && isLetter(cells[i - 1]!.ch) && isLetter(cells[i + 1]!.ch)) continue;
    if (isLetter(cell.ch)) hasLetter = true;
    kept.push(cell);
  }
  // Look-alikes, only in a word that holds a letter; then a run of three or more of one letter is one.
  const mapped: Cell[] = [];
  for (const cell of kept) {
    __foldSteps.n++;
    const ch = hasLetter ? (LOOK_ALIKE[cell.ch] ?? cell.ch) : cell.ch;
    mapped.push(ch === cell.ch ? cell : { ch, start: cell.start, end: cell.end });
  }
  const out: Cell[] = [];
  let i = 0;
  while (i < mapped.length) {
    __foldSteps.n++;
    const cell = mapped[i]!;
    let j = i + 1;
    if (isLetter(cell.ch)) while (j < mapped.length && mapped[j]!.ch === cell.ch) j++;
    if (j - i >= 3) out.push({ ch: cell.ch, start: cell.start, end: mapped[j - 1]!.end });
    else for (let k = i; k < j; k++) out.push(mapped[k]!);
    i = j;
  }
  // Only letters and digits at the edges: a full stop after a word is not part of it.
  let a = 0;
  let b = out.length;
  while (a < b && !isWordChar(out[a]!.ch)) a++;
  while (b > a && !isWordChar(out[b - 1]!.ch)) b--;
  if (a >= b) return null;
  let folded = '';
  for (let k = a; k < b; k++) folded += out[k]!.ch;
  return { folded, start: out[a]!.start, end: out[b - 1]!.end };
}

/**
 * The words of `text`, folded, each with its range in `text`. Linear in the length of `text`; never throws. A word that folds to nothing
 * (punctuation alone) is left out.
 */
export function foldChunks(text: string): Chunk[] {
  const chunks: Chunk[] = [];
  let cells: Cell[] = [];
  const flush = (): void => {
    if (cells.length === 0) return;
    const chunk = foldRun(cells);
    if (chunk !== null) chunks.push(chunk);
    cells = [];
  };
  let at = 0;
  while (at < text.length) {
    __foldSteps.n++;
    const code = text.codePointAt(at)!;
    const width = code > 0xffff ? 2 : 1;
    const original = text.slice(at, at + width);
    const start = at;
    at += width;
    if (isSpace(code)) {
      flush();
      continue;
    }
    if (isHidden(code)) continue;
    const folded = foldPoint(original);
    // A folded code point can be several characters (a ligature) or none (a bare accent): each takes the original range.
    for (const ch of folded) {
      if (isSpace(ch.charCodeAt(0))) flush();
      else if (SEPARATORS.includes(ch)) flush();
      else cells.push({ ch, start, end: start + width });
    }
  }
  flush();
  return chunks;
}

/** The folded form of a single word, or null when it is not exactly one word (it holds a separator, or folds to nothing). */
export function foldWord(word: string): string | null {
  const chunks = foldChunks(word);
  return chunks.length === 1 ? chunks[0]!.folded : null;
}

/** How many letters a folded word holds. */
export function letterCount(folded: string): number {
  let n = 0;
  for (const ch of folded) if (isLetter(ch)) n++;
  return n;
}

/** `text` lowercased one character at a time, so its length never changes (`toLowerCase` on a whole string can lengthen it). */
export function lowerKeepLength(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

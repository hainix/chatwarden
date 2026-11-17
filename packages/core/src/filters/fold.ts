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
const LOOK_ALIKE: Readonly<Record<string, string>> = { '0': 'o', '1': 'l', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i', '|': 'l' };

/**
 * Lower case Cyrillic and Greek letters read as the Latin letter they look like: a small fixed table, applied after NFKC, so a rule for
 * `gold` also catches the same word written with a Cyrillic o. A word written in those scripts folds the same way on both sides.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  '\u{430}': 'a', // Cyrillic a
  '\u{432}': 'b', // ve
  '\u{435}': 'e',
  '\u{43a}': 'k',
  '\u{43c}': 'm',
  '\u{43d}': 'h', // en
  '\u{43e}': 'o',
  '\u{440}': 'p', // er
  '\u{441}': 'c', // es
  '\u{442}': 't', // te
  '\u{443}': 'y', // u
  '\u{445}': 'x', // ha
  '\u{455}': 's', // dze
  '\u{456}': 'i', // Byelorussian-Ukrainian i
  '\u{458}': 'j',
  '\u{4bb}': 'h', // shha
  '\u{3b1}': 'a', // Greek alpha
  '\u{3b2}': 'b', // beta
  '\u{3b5}': 'e', // epsilon
  '\u{3b7}': 'n', // eta
  '\u{3b9}': 'i', // iota
  '\u{3ba}': 'k', // kappa
  '\u{3bc}': 'm', // mu
  '\u{3bd}': 'v', // nu
  '\u{3bf}': 'o', // omicron
  '\u{3c1}': 'p', // rho
  '\u{3c4}': 't', // tau
  '\u{3c5}': 'u', // upsilon
  '\u{3c7}': 'x', // chi
};

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
  const plain = ch.normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  let out = '';
  for (const p of plain) out += CONFUSABLE[p] ?? p;
  return out;
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
 * Other readings of a line. The matcher tries the default one and these, and takes any hit:
 * `split`: `.` and `*` end a word (`buy.gold` is two words; the default view joins `g.o.l.d` into one).
 * `bang`: a `!` or `|` between two letters is the letter it imitates (`f!sh` is `fish`; the default view splits on it).
 */
export interface FoldOptions {
  split?: boolean;
  bang?: boolean;
}

/**
 * The words of `text`, folded, each with its range in `text`. Linear in the length of `text`; never throws. A word that folds to nothing
 * (punctuation alone) is left out.
 */
export function foldChunks(text: string, opts: FoldOptions = {}): Chunk[] {
  const split = opts.split === true;
  const bang = opts.bang === true;
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
      else if (SEPARATORS.includes(ch) || (split && (ch === '.' || ch === '*'))) {
        if (bang && (ch === '!' || ch === '|') && cells.length > 0 && isLetter(cells[cells.length - 1]!.ch) && at < text.length && isLetter(String.fromCodePoint(text.codePointAt(at)!))) cells.push({ ch, start, end: start + width });
        else flush();
      } else cells.push({ ch, start, end: start + width });
    }
  }
  flush();
  return chunks;
}

/**
 * `chunks` with each run of three or more single-letter words joined into one (`g o l d`, `g_o_l_d`, `b-u-y`), or null when there is no
 * such run. A reading of its own: the plain words stay as they are in the other views.
 */
export function mergeSpaced(chunks: readonly Chunk[]): Chunk[] | null {
  const single = (c: Chunk): boolean => c.folded.length === 1 && isLetter(c.folded);
  const out: Chunk[] = [];
  let merged = false;
  let i = 0;
  while (i < chunks.length) {
    __foldSteps.n++;
    let j = i;
    while (j < chunks.length && single(chunks[j]!)) j++;
    if (j - i >= 3) {
      // A lone `a` or `i` next to the run is most likely a word of its own ("i g o l d"), kept apart when three letters remain.
      let lo = i;
      let hi = j;
      const lead = chunks[lo]!.folded === 'a' || chunks[lo]!.folded === 'i';
      const tail = chunks[hi - 1]!.folded === 'a' || chunks[hi - 1]!.folded === 'i';
      if (lead && hi - lo - 1 >= 3) out.push(chunks[lo++]!);
      const peelTail = tail && hi - lo - 1 >= 3;
      if (peelTail) hi--;
      let folded = '';
      for (let k = lo; k < hi; k++) folded += chunks[k]!.folded;
      out.push({ folded, start: chunks[lo]!.start, end: chunks[hi - 1]!.end });
      if (peelTail) out.push(chunks[hi]!);
      merged = true;
      i = j;
    } else {
      out.push(chunks[i]!);
      i++;
    }
  }
  return merged ? out : null;
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

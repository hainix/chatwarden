import { stripInvisible } from './normalise.js';

/** A hit on the ORIGINAL text: `start` inclusive, `end` exclusive (UTF-16 units, like `String.slice`). */
export interface Span { start: number; end: number; termId: string }

/** The text as the matcher reads it ({@link stripInvisible}), plus where each of its UTF-16 units came from.
 *  `from[k]` is the original index where the character that produced stripped unit `k` starts; `to[k]` is one
 *  past the end of that character. One original character may produce several stripped units (a ligature) and
 *  a hidden character produces none. */
export interface StrippedView { text: string; from: number[]; to: number[] }

/** Builds the {@link StrippedView} of `raw`. NFKD decomposes per character (it only reorders combining marks,
 *  which are removed anyway), so stripping one code point at a time gives the same text as stripping the whole
 *  string; that is checked, and a mismatch falls back to a coarse map that still brackets every hit. */
export function stripWithMap(raw: string): StrippedView {
  let text = '';
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < raw.length; ) {
    const cp = raw.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    const piece = stripInvisible(raw.slice(i, i + n));
    for (let k = 0; k < piece.length; k++) {
      from.push(i);
      to.push(i + n);
    }
    text += piece;
    i += n;
  }
  const whole = stripInvisible(raw);
  if (text === whole) return { text, from, to };
  // Not expected for any Unicode version in use; stay safe by spreading the whole range over every unit.
  return { text: whole, from: Array.from(whole, () => 0), to: Array.from(whole, () => raw.length) };
}

/** Maps hits found on `view.text` (inclusive `startIndex`/`endIndex`) back to the original text. */
export function toOriginal(view: StrippedView, startIndex: number, endIndex: number): { start: number; end: number } {
  return { start: view.from[startIndex]!, end: view.to[endIndex]! };
}

/** Sorts spans by position and merges those that overlap (the earliest one's term id is kept). Spans that
 *  merely touch stay separate. */
export function mergeSpans(spans: readonly Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

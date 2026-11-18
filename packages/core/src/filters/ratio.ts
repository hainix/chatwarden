import type { ResolvedRatio } from '../filters.js';

// Shouting and floods in a line: too many capitals, one character repeated, too many emoji, too many mentions. `scanRatio` says which
// checks the line trips; `soften` is what the `mask` action does for them (lowercase it, shorten a run, cut the extras) and never makes the
// text longer. Linear scans, no regular expression built from data.

/** At most this many characters of a line are read. */
export const RATIO_LINE_CAP = 2000;

/** Test hook: how many characters the checks have looked at, so a test can show the work is linear. */
export const __ratioSteps = { n: 0 };

export type RatioDetail = 'caps' | 'repeats' | 'emoji' | 'mentions';

/** One character that is an emoji, a symbol or a pictograph (a single reviewed literal; only asked about characters above U+00A8). */
const PICTOGRAPH = /\p{Extended_Pictographic}/u;

const ZWJ = 0x200d;
const VARIATION_16 = 0xfe0f;
const KEYCAP = 0x20e3;

const isDigit = (c: number): boolean => c >= 0x30 && c <= 0x39;
const isAsciiAlnum = (c: number): boolean => isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isSpaceCode = (c: number): boolean => c === 0x20 || (c >= 0x09 && c <= 0x0d) || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a);
const isRegional = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const isSkinTone = (cp: number): boolean => cp >= 0x1f3fb && cp <= 0x1f3ff;

function isPictograph(cp: number): boolean {
  if (cp < 0xa9) return false;
  return PICTOGRAPH.test(String.fromCodePoint(cp));
}

const width = (cp: number): number => (cp > 0xffff ? 2 : 1);

/** The end of the emoji that starts at `i` (a ZWJ sequence, a skin tone or a flag is one), or -1 when there is none. */
function emojiEnd(t: string, i: number): number {
  const cp = t.codePointAt(i)!;
  if (isRegional(cp)) {
    const next = i + width(cp);
    const n2 = next < t.length ? t.codePointAt(next)! : 0;
    return isRegional(n2) ? next + width(n2) : next;
  }
  if (!isPictograph(cp)) return -1;
  let j = i + width(cp);
  while (j < t.length) {
    __ratioSteps.n++;
    const c = t.codePointAt(j)!;
    if (isSkinTone(c) || c === VARIATION_16 || c === KEYCAP) {
      j += width(c);
    } else if (c === ZWJ) {
      const after = j + 1;
      const n = after < t.length ? t.codePointAt(after)! : 0;
      if (n !== 0 && isPictograph(n)) j = after + width(n);
      else break;
    } else {
      break;
    }
  }
  return j;
}

function countEmoji(t: string): number {
  let count = 0;
  let i = 0;
  while (i < t.length) {
    __ratioSteps.n++;
    const e = emojiEnd(t, i);
    if (e >= 0) {
      count++;
      i = e;
    } else {
      i += width(t.codePointAt(i)!);
    }
  }
  return count;
}

/** A mention is an `@` that starts a word and is followed by a name; this is the end of the name at `i`, or -1. */
function mentionEnd(t: string, i: number): number {
  if (t.charCodeAt(i) !== 0x40) return -1;
  const prev = i > 0 ? t.charCodeAt(i - 1) : 0x20;
  if (isAsciiAlnum(prev) || prev === 0x5f || prev > 0x7f) return -1;
  let j = i + 1;
  while (j < t.length && (isAsciiAlnum(t.charCodeAt(j)) || t.charCodeAt(j) === 0x5f)) {
    __ratioSteps.n++;
    j++;
  }
  return j > i + 1 ? j : -1;
}

function countMentions(t: string): number {
  let count = 0;
  let i = 0;
  while (i < t.length) {
    __ratioSteps.n++;
    const e = mentionEnd(t, i);
    if (e >= 0) {
      count++;
      i = e;
    } else {
      i++;
    }
  }
  return count;
}

/** The longest run of one character (spaces and `*` do not count) in `t`. */
function longestRun(t: string): number {
  let best = 0;
  let run = 0;
  let prev = -1;
  let i = 0;
  while (i < t.length) {
    __ratioSteps.n++;
    const cp = t.codePointAt(i)!;
    i += width(cp);
    if (isSpaceCode(cp) || cp === 0x2a) {
      run = 0;
      prev = -1;
      continue;
    }
    run = cp === prev ? run + 1 : 1;
    prev = cp;
    if (run > best) best = run;
  }
  return best;
}

/** Cased letters, and how many of them are upper case. */
function letterCounts(t: string): { letters: number; upper: number } {
  let letters = 0;
  let upper = 0;
  for (let i = 0; i < t.length; ) {
    __ratioSteps.n++;
    const cp = t.codePointAt(i)!;
    i += width(cp);
    if (cp < 0x80) {
      if (cp >= 0x41 && cp <= 0x5a) {
        letters++;
        upper++;
      } else if (cp >= 0x61 && cp <= 0x7a) {
        letters++;
      }
      continue;
    }
    const ch = String.fromCodePoint(cp);
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo === up) continue;
    letters++;
    if (ch === up && ch !== lo) upper++;
  }
  return { letters, upper };
}

/** Which of the enabled checks `text` trips, in the order caps, repeats, emoji, mentions. Reads at most 2 000 characters. Never throws. */
export function scanRatio(text: string, cfg: ResolvedRatio): Array<{ detail: RatioDetail }> {
  if (typeof text !== 'string' || text.length === 0) return [];
  try {
    const t = text.length > RATIO_LINE_CAP ? text.slice(0, RATIO_LINE_CAP) : text;
    const out: Array<{ detail: RatioDetail }> = [];
    if (cfg.caps !== null) {
      const { letters, upper } = letterCounts(t);
      if (letters >= cfg.caps.minLetters && upper * 100 > cfg.caps.maxPercent * letters) out.push({ detail: 'caps' });
    }
    if (cfg.repeats !== null && longestRun(t) > cfg.repeats.maxRun) out.push({ detail: 'repeats' });
    if (cfg.emoji !== null && countEmoji(t) > cfg.emoji.max) out.push({ detail: 'emoji' });
    if (cfg.mentions !== null && countMentions(t) > cfg.mentions.max) out.push({ detail: 'mentions' });
    return out;
  } catch {
    return [];
  }
}

/** One character mapped, or left alone when the mapping would change its length. */
const keepLength = (ch: string, mapped: string): string => (mapped.length === ch.length ? mapped : ch);

/** Lowercase the line except the first letter of each sentence. */
function softenCaps(t: string): string {
  let out = '';
  let sentenceStart = true;
  for (let i = 0; i < t.length; ) {
    __ratioSteps.n++;
    const cp = t.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    const lo = ch.toLowerCase();
    const up = ch.toUpperCase();
    if (lo !== up) {
      out += keepLength(ch, sentenceStart ? up : lo);
      sentenceStart = false;
    } else {
      out += ch;
      if (cp === 0x2e || cp === 0x21 || cp === 0x3f) sentenceStart = true;
    }
  }
  return out;
}

/** Cut every run of one character to at most `maxRun` (spaces and `*` are left as they are). */
function softenRepeats(t: string, maxRun: number): string {
  let out = '';
  let run = 0;
  let prev = -1;
  for (let i = 0; i < t.length; ) {
    __ratioSteps.n++;
    const cp = t.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (isSpaceCode(cp) || cp === 0x2a) {
      out += ch;
      run = 0;
      prev = -1;
      continue;
    }
    run = cp === prev ? run + 1 : 1;
    prev = cp;
    if (run <= maxRun) out += ch;
  }
  return out;
}

/** Keep the first `max` emoji and drop the rest. */
function cutEmoji(t: string, max: number): string {
  let out = '';
  let kept = 0;
  let i = 0;
  while (i < t.length) {
    __ratioSteps.n++;
    const e = emojiEnd(t, i);
    if (e >= 0) {
      if (kept < max) out += t.slice(i, e);
      kept++;
      i = e;
    } else {
      const w = width(t.codePointAt(i)!);
      out += t.slice(i, i + w);
      i += w;
    }
  }
  return out;
}

/** Keep the first `max` mentions and drop the rest. */
function cutMentions(t: string, max: number): string {
  let out = '';
  let kept = 0;
  let i = 0;
  while (i < t.length) {
    __ratioSteps.n++;
    const e = mentionEnd(t, i);
    if (e >= 0) {
      if (kept < max) out += t.slice(i, e);
      kept++;
      i = e;
    } else {
      out += t.charAt(i);
      i++;
    }
  }
  return out;
}

/**
 * What the `mask` action does for a ratio rule: each check the line trips is softened (caps are lowercased except the first letter of a
 * sentence, a run is cut to `maxRun`, emoji and mentions are cut to `max`); a line that trips nothing comes back as it is. The result is
 * never longer than the input. Reads at most 2 000 characters, and keeps the rest as it is.
 */
export function soften(text: string, cfg: ResolvedRatio): string {
  if (typeof text !== 'string') return '';
  try {
    const head = text.length > RATIO_LINE_CAP ? text.slice(0, RATIO_LINE_CAP) : text;
    const tripped = new Set(scanRatio(head, cfg).map((d) => d.detail));
    if (tripped.size === 0) return text;
    let out = head;
    if (tripped.has('caps')) out = softenCaps(out);
    if (tripped.has('repeats') && cfg.repeats !== null) out = softenRepeats(out, cfg.repeats.maxRun);
    if (tripped.has('emoji') && cfg.emoji !== null) out = cutEmoji(out, cfg.emoji.max);
    if (tripped.has('mentions') && cfg.mentions !== null) out = cutMentions(out, cfg.mentions.max);
    return out + text.slice(head.length);
  } catch {
    return text;
  }
}

// Character helpers for the link scanner: which characters are invisible, which are white space, and the dots a link may be written with
// (a full stop, three look-alike full stops, and the defanged forms `[.]`, `(.)`, `{.}`, `(dot)`, `[dot]`, `{dot}`).

/** Zero-width, bidi, joiner and control characters that a link may hide inside and a reader never sees. White space is not among them. */
export function isHiddenCode(code: number): boolean {
  return (
    code <= 0x08 ||
    (code >= 0x0e && code <= 0x1f) ||
    (code >= 0x7f && code <= 0x9f && code !== 0x85) ||
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

/** White space: it ends a link. */
export function isSpaceCode(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0x85 || code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000;
}

/** The text without its hidden characters, and for each kept UTF-16 unit the index it had in the original. */
export interface Stripped {
  text: string;
  map: number[];
}

/** Remove the hidden characters, keeping an offset map so a range found in the result still points into the original text. */
export function stripHidden(text: string): Stripped {
  let out = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isHiddenCode(code)) continue;
    out += text.charAt(i);
    map.push(i);
  }
  return { text: out, map };
}

/** A full stop, or a look-alike of one that a link may be written with: the ideographic, full-width and half-width ideographic full stops. */
export function isDotCode(code: number): boolean {
  return code === 0x2e || code === 0x3002 || code === 0xff0e || code === 0xff61;
}

/** A dot written in the text at `i`: how many characters it takes, and whether it is the word form `(dot)`. Null when there is none. */
export function dotAt(text: string, i: number): { len: number; word: boolean } | null {
  const c = text.charCodeAt(i);
  if (isDotCode(c)) return { len: 1, word: false };
  // [.] (.) {.}
  if ((c === 0x5b || c === 0x28 || c === 0x7b) && text.charCodeAt(i + 1) === 0x2e) {
    const close = text.charCodeAt(i + 2);
    if ((c === 0x5b && close === 0x5d) || (c === 0x28 && close === 0x29) || (c === 0x7b && close === 0x7d)) return { len: 3, word: false };
    return null;
  }
  // [dot] (dot) {dot}, in any case
  if ((c === 0x5b || c === 0x28 || c === 0x7b) && text.length >= i + 5) {
    const mid = text.slice(i + 1, i + 4).toLowerCase();
    const close = text.charCodeAt(i + 4);
    if (mid === 'dot' && ((c === 0x5b && close === 0x5d) || (c === 0x28 && close === 0x29) || (c === 0x7b && close === 0x7d))) return { len: 5, word: true };
  }
  return null;
}

// The term list applied to names and other short text players set for others to see: handles, table names,
// deck names. Same list, same matcher, refused rather than starred.
//
// Chat matches whole words, and a name rarely has spaces: "x_<term>", "<term>123" and "Big<Term>" are each one
// word to the chat matcher. So a name is also read in segmented views (underscores and camelCase humps as spaces,
// then digit runs as spaces too). Each view can only ADD a block, never remove one, and the whole-word rule still
// holds inside each view, so a term buried mid-word ("xX<term>Xx") is a report away, as in chat.
import type { Matcher } from './matcher.js';
import { skeleton } from './normalise.js';

/** The name as written, then (when they differ) underscores and camelCase humps as spaces, then digit runs as
 *  spaces as well. The digit-free view comes last: digits are leetspeak to the matcher ("f3nr1sk"), so the
 *  earlier views keep them. */
export function nameViews(name: string): string[] {
  const segmented = name
    .replace(/_+/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
  const digitless = segmented.replace(/\p{N}+/gu, ' ');
  return [...new Set([name, segmented, digitless])];
}

/** The most characters of a name that are read for reserved names: a name is short, and this bounds what a hostile caller can make the comparison cost. */
const RESERVED_NAME_MAX = 256;

interface ReservedLists {
  entries: ReadonlySet<string>;
  /** The longest entry skeleton: a run of words longer than this cannot be one. */
  longest: number;
  allow: ReadonlySet<string>;
}

/** The lists as keys, remembered per pair of array objects: the kit hands over the same frozen arrays until the settings change, so each is read once. */
const compiled = new WeakMap<readonly string[], WeakMap<readonly string[], ReservedLists>>();

function listsOf(entries: readonly string[], allow: readonly string[]): ReservedLists {
  let byAllow = compiled.get(entries);
  if (byAllow === undefined) {
    byAllow = new WeakMap();
    compiled.set(entries, byAllow);
  }
  let found = byAllow.get(allow);
  if (found === undefined) {
    // An entry (or allowed name) with an empty skeleton (only symbols) would match every name, or none: it is not a key.
    const keys = new Set(entries.map((e) => skeleton(String(e))).filter((k) => k !== ''));
    found = { entries: keys, longest: Math.max(0, ...[...keys].map((k) => k.length)), allow: new Set(allow.map((a) => skeleton(String(a))).filter((k) => k !== '')) };
    byAllow.set(allow, found);
  }
  return found;
}

/**
 * Is this NAME one of the protected `entries`? A name matches when its whole skeleton is an entry's, or when any run of consecutive words of any of its views (see `nameViews`; a space, an underscore, a camel-case hump, a digit run
 * or a punctuation mark is a word break) has an entry's skeleton, so `Mod_Anna`, `M0d_Anna`, `ModAnna`, `m o d anna` and `Moderator` match the entries `mod` and `moderator` while `xXmodXx`, `Sodmin` and `Moderately` do not (a word
 * is read whole, as in chat). A name whose whole skeleton equals one of `allow` is never a match (a real player who happens to be called like staff). Compared on names only, never on chat. Never throws: anything that is not text is no match.
 */
export function matchReserved(name: string, entries: readonly string[], allow: readonly string[]): boolean {
  if (typeof name !== 'string' || !Array.isArray(entries)) return false;
  const lists = listsOf(entries, Array.isArray(allow) ? allow : []);
  if (lists.entries.size === 0) return false;
  const text = name.length > RESERVED_NAME_MAX ? name.slice(0, RESERVED_NAME_MAX) : name;
  const whole = skeleton(text);
  if (whole === '' || lists.allow.has(whole)) return false;
  if (lists.entries.has(whole)) return true;
  for (const view of nameViews(text)) {
    const words = view
      .split(/[^\p{L}\p{N}]+/u)
      .map((w) => skeleton(w))
      .filter((w) => w !== '');
    for (let from = 0; from < words.length; from += 1) {
      let run = '';
      for (let to = from; to < words.length; to += 1) {
        run += words[to];
        if (run.length > lists.longest) break;
        if (lists.entries.has(run)) return true;
      }
    }
  }
  return false;
}

/** The first term hit in any view of the name, or null. */
export function matchName(matcher: Matcher, name: string): { termId: string } | null {
  for (const view of nameViews(name)) {
    const hit = matcher.match(view);
    if (hit) return hit;
  }
  return null;
}

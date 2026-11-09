// The term list applied to names and other short text players set for others to see: handles, table names,
// deck names. Same list, same matcher, refused rather than starred.
//
// Chat matches whole words, and a name rarely has spaces: "x_<term>", "<term>123" and "Big<Term>" are each one
// word to the chat matcher. So a name is also read in segmented views (underscores and camelCase humps as spaces,
// then digit runs as spaces too). Each view can only ADD a block, never remove one, and the whole-word rule still
// holds inside each view, so a term buried mid-word ("xX<term>Xx") is a report away, as in chat.
import type { Matcher } from './matcher.js';

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

/** The first term hit in any view of the name, or null. */
export function matchName(matcher: Matcher, name: string): { termId: string } | null {
  for (const view of nameViews(name)) {
    const hit = matcher.match(view);
    if (hit) return hit;
  }
  return null;
}

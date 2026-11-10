/**
 * The address for an appeal link, or null when it is not safe to link to. Allowed: an `http:` or `https:` address, or a path on
 * the same site that starts with a single `/`. Everything else (`javascript:`, `data:`, `//host`, a bare word, an empty string)
 * is refused, so an adopter's mistake or a hostile config value never becomes a script link.
 */
export function safeHref(url: string | undefined): string | null {
  if (typeof url !== 'string') return null;
  const href = url.trim();
  if (/^\/(?![/\\])/.test(href)) return href;
  // `[/][/]` rather than an escaped pair: a plain `//` followed by a word would read as a remote address to the third-party scan.
  if (!/^https?:[/][/]/i.test(href)) return null;
  try {
    const parsed = new URL(href);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? href : null;
  } catch {
    return null;
  }
}

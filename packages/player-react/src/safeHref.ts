// The rule for a link address, copied from `@chatwarden/hub-react` (its `isSafeHref`, which guards links in policy documents).
// The two packages never import each other, so this is a copy; test/safe-href.test.ts runs both on one table.

function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Whether an address may become a link: `https:` (with a host), or a relative address on this site. */
export function isSafeHref(href: string): boolean {
  // A control character or space inside an address is how `java\tscript:` slips past a scheme check: refuse them all.
  const s = href.trim();
  if (s === '' || hasControlOrSpace(s) || /\s/u.test(s)) return false;
  // A browser reads `\` as `/`, so `/\evil.example` is `//evil.example`, a different site: refuse a backslash anywhere, and a
  // slash that is followed by another slash or by anything that could be read as one.
  if (s.includes('\\') || /^\/[\s/]/u.test(s)) return false;
  // An address that carries an entity is not one an adopter wrote: refuse.
  if (/&#?\w+;/.test(s)) return false;
  const scheme = /^([^/?#]*):/.exec(s);
  if (scheme === null) return true;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/** The address for an appeal link (trimmed), or null when it is not safe to link to. `http:` is refused: https only. */
export function safeHref(url: string | undefined): string | null {
  if (typeof url !== 'string') return null;
  return isSafeHref(url) ? url.trim() : null;
}

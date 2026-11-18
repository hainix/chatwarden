// A link the hub may draw as a link (design 11): an https address with a host and no user name or password, exactly as given (no leading or trailing space), else nothing. The owner's evidence
// template and the server's word are both checked again here, so a bad server or a bad template can never put a `javascript:`, `data:` or plain-http address under a moderator's click.

/** The address when it is safe to link to, else null. */
export function safeHref(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '' || raw !== raw.trim() || !/^https:[/][/]/.test(raw)) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '' ? raw : null;
  } catch {
    return null;
  }
}

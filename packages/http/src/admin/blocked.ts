import { BLOCKED_DAYS } from '@chatwarden/core';
import type { BlockedDays } from '@chatwarden/core';
import { HttpError } from '../errors.js';
import { roleAtLeast } from '../permissions.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { flagKey, handleFlags, latestHandle } from './handles.js';
import type { TermsAdmin } from './terms.js';

/** The window when `days` is absent. */
const DEFAULT_DAYS: BlockedDays = 7;

/** A query `days`: absent is the default; otherwise exactly `1`, `7` or `30`, else 400 `invalid_query`. */
function queryDays(raw: string | undefined): BlockedDays {
  if (raw === undefined) return DEFAULT_DAYS;
  const found = BLOCKED_DAYS.find((d) => String(d) === raw);
  if (found === undefined) throw new HttpError('invalid_query');
  return found;
}

/** A query `source`: absent is the chat lines; otherwise `chat` or `name` (the kept blocked names), else 400 `invalid_query`. */
function querySource(raw: string | undefined): 'chat' | 'name' {
  if (raw === undefined || raw === 'chat') return 'chat';
  if (raw === 'name') return 'name';
  throw new HttpError('invalid_query');
}

/**
 * `GET /blocked?source=chat|name&days=1|7|30` (`blocked.read`, moderator by default): the chat lines the slur filter blocked, newest first,
 * at most 500, `{ items: [{ id, at, roomId, termId, term, language, person, handle, text }] }`. `days` defaults to 7; any other value
 * is 400 `invalid_query`. Strikes are purged after 30 days, so 30 is the longest window there is.
 *
 * `text` is the line as the person typed it, shown to staff only (they already see raw lines in a report's excerpt, so this is
 * not a new kind of exposure; it is a new way to reach it, hence its own permission and its own audit row). `person` is the
 * canonical subject (a staff ref), and `handle` is the name to show for them: the newest non-blank handle on a report filed against them
 * (the same rule as the history and sanctions routes), null when none recorded one or when the caller lacks `history.read` (as the term needs
 * `terms.read`). `term` and `language` come from the injected `terms` and are null when the routes were
 * built without it, the term is no longer listed, or the caller lacks `terms.read` (the term text is that permission's). No hashed IP or key is ever part of an item.
 *
 * `source=name` lists the blocked NAMES kept as evidence (`names.keepBlocked`) instead: the same items with `text` as the name as it was typed,
 * `roomId` null, `termId` null for a swear word the profanity pass caught (and `term` and `language` null with it), `reason` (`name_not_allowed` or
 * `name_profane`) and `person` null for a caller the kit did not hold. Empty (still 200) when none was kept, whatever the setting says now:
 * what exists is shown until retention removes it. `source` defaults to `chat`; any other value is 400 `invalid_query`.
 *
 * Both sources carry `handleFlagged: true` beside a `handle` the matcher flags while `names.maskInHub` is on (else the key is absent).
 *
 * Audit: `blocked.view` with no target, written after the list is built; if it cannot be written the request is a 500 and
 * nothing is shown.
 */
export function blockedRoutes(ctx: AdminContext, terms: TermsAdmin | undefined): RouteTable {
  const { cw } = ctx;
  return {
    'GET /blocked': ctx.secure('blocked.read', (c) => {
      const source = querySource(c.req.query.source);
      const days = queryDays(c.req.query.days);
      const known = new Map<string, { term: string; language: string }>();
      // The term text is what `terms.read` guards, so a caller without it gets null here, whatever `blocked.read` allows.
      const mayReadTerms = roleAtLeast(c.authz.role, ctx.permissions['terms.read']);
      for (const t of mayReadTerms ? (terms?.rows.terms ?? []) : []) known.set(t.id, { term: t.term, language: t.language });
      const mayReadHandles = roleAtLeast(c.authz.role, ctx.permissions['history.read']);
      // One lookup per person, however many lines they have.
      const handles = new Map<string, string | null>();
      const handleOf = (person: string): string | null => {
        if (!mayReadHandles) return null;
        if (!handles.has(person)) handles.set(person, latestHandle(cw, person));
        return handles.get(person) ?? null;
      };
      const flagged = handleFlags(cw);
      const termOf = (termId: string | null) => (termId === null ? undefined : known.get(termId));
      const items =
        source === 'name'
          ? cw.blocked.names({ days }).map((b) => {
              const t = termOf(b.termId);
              const handle = b.person === null ? null : handleOf(b.person);
              return {
                id: b.id,
                at: b.at,
                roomId: null,
                termId: b.termId,
                term: t === undefined ? null : t.term,
                language: t === undefined ? null : t.language,
                person: b.person,
                handle,
                ...flagKey(flagged, 'handleFlagged', handle),
                text: b.name,
                reason: b.reason,
              };
            })
          : cw.blocked.list({ days }).map((b) => {
              const t = termOf(b.termId);
              const handle = handleOf(b.person);
              return {
                id: b.id,
                at: b.at,
                roomId: b.roomId,
                termId: b.termId,
                term: t === undefined ? null : t.term,
                language: t === undefined ? null : t.language,
                person: b.person,
                handle,
                ...flagKey(flagged, 'handleFlagged', handle),
                text: b.text,
              };
            });
      c.audit('blocked.view');
      return { status: 200, body: { items } };
    }),
  };
}

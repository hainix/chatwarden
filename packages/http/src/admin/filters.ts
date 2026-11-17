import { ProfileError, safeWarn } from '@chatwarden/core';
import type { FilterSettings } from '@chatwarden/core';
import { FiltersInvalidError, HttpError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { asObject, bodyObject, has } from './validate.js';

/** The longest line `POST /filters/test` takes, in characters: the filters read at most this much of a line. */
const TEST_TEXT_MAX = 2000;

/** A `candidate`: a plain object, else 400 `invalid_request`. What is in it is the core's to check (`invalid_filters` with a path). */
function bodyCandidate(v: unknown): FilterSettings {
  const candidate = asObject(v);
  if (candidate === undefined) throw new ValidationError();
  return candidate as FilterSettings;
}

/** Run a core call that checks a candidate; a refusal is 400 `invalid_filters` with the path in the candidate, never a value. */
function checked<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof ProfileError) throw new FiltersInvalidError(err.path);
    throw err;
  }
}

/**
 * The chat filter routes (staff only, `filters.read`, a moderator's by default). They read, test and try; nothing here writes a row, files a
 * report or leaves an audit entry (the settings themselves are edited through `PUT /policy/profile`, the owner's `policy.write`). Every body
 * is `no-store`.
 *
 * - `GET /filters/stats?days=7|30`: `{ days, keys }`, what the filters did over the last 7 or 30 UTC days (today included): per counter key
 *   (`link.unlisted`, `personal_info.phone`, `phrase.<id>`, `ratio.caps` ...) the counts by the action applied, `{ count, flag, mask, refuse,
 *   flag_capped }` (`flag_capped`: the daily cap turned a flag into a count). A phrase key also has `label`, the rule's label as it is now (absent
 *   when the rule is no longer in the settings). No person, room or text. Any other `days` is 400 `invalid_query`. No audit row.
 * - `POST /filters/test { text, candidate? }`: the verdict for one line, `{ verdict, delivered }`: every hit with its kind, detail, action, Community
 *   Rule and matched ranges (`spans`, offsets in `text`), the refusal if one, and the line as it would be delivered (`null` when it would be
 *   refused). Under the settings in force, or under `candidate` (not saved). `text` is 1 to 2 000 characters. Nothing is stored, counted, audited
 *   or logged; the ranges point at the matched part of the line, so this answer is for staff only.
 * - `POST /filters/check { candidate }`: the candidate over the adopter's `recentLines()` (the option `POST /terms/check` also uses; none when it is
 *   not given): `{ lines, refused, masked, rules }`, at most 5 000 lines read and per rule the lines it hit (`hits`) and up to 20 `samples` with their
 *   ranges. Nothing is stored, counted or audited.
 *
 * A `candidate` is checked like the stored layer's `filters`: one the kit refuses is 400 `invalid_filters` with `path` (a field of the candidate,
 * never a value).
 */
export function filterRoutes(ctx: AdminContext, recentLines: () => readonly string[]): RouteTable {
  const { cw } = ctx;
  return {
    'GET /filters/stats': ctx.secure('filters.read', async (c) => {
      const raw = c.req.query.days;
      if (raw !== '7' && raw !== '30') throw new HttpError('invalid_query');
      const days = raw === '7' ? 7 : 30;
      const stats = await cw.filters.stats({ days });
      // A phrase rule's label as it is in the settings now, for the keys that name one.
      const labels = new Map<string, string>(cw.profile.filters.phrases.map((p) => [`phrase.${p.id}`, p.label]));
      const keys: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
      for (const [key, counts] of Object.entries(stats.keys)) {
        const label = labels.get(key);
        keys[key] = { ...counts, ...(label === undefined ? {} : { label }) };
      }
      return { status: 200, body: { days: stats.days, keys } };
    }),

    'POST /filters/test': ctx.secure('filters.read', (c) => {
      const body = bodyObject(c.req);
      const text = body.text;
      if (typeof text !== 'string' || text.length < 1 || text.length > TEST_TEXT_MAX) throw new ValidationError();
      const candidate = has(body, 'candidate') ? bodyCandidate(body.candidate) : undefined;
      const result = checked(() => cw.filters.test(text, candidate));
      return { status: 200, body: { verdict: result.verdict, delivered: result.delivered } };
    }),

    'POST /filters/check': ctx.secure('filters.read', (c) => {
      const body = bodyObject(c.req);
      if (!has(body, 'candidate')) throw new ValidationError();
      const candidate = bodyCandidate(body.candidate);
      let lines: readonly string[] = [];
      try {
        lines = recentLines();
      } catch (err) {
        // The adopter's hook failed: try the candidate over nothing, and say so by class only.
        safeWarn(ctx.logger, 'chatwarden.http_recent_lines_failed', { error: err instanceof Error ? err.name : typeof err });
      }
      const result = checked(() => cw.filters.check(candidate, lines));
      return { status: 200, body: result };
    }),
  };
}

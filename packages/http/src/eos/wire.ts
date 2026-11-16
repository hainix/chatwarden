import { createHash } from 'node:crypto';
import type { RuleRef } from '@chatwarden/core';

// The pure parts of the EOS adapter: what a sanction body holds, how a link key is made, how text is cut. No I/O. The shapes follow the Sanctions Web API
// (https://dev.epicgames.com/docs/web-api-ref/sanctions-web-apis): `action` and `source` and tags are `[A-Za-z0-9_-]`, a tag is at most 16 characters, a metadata value at
// most 128, a justification 1 to 2048. UNVERIFIED (design 15): that `duration: 0` means permanent on create.

/** The `source` of every sanction the kit creates in EOS (2 to 64 characters). */
export const SOURCE = 'chatwarden';
/** The longest justification EOS takes. */
export const JUSTIFICATION_MAX = 2048;
/** An EOS reference id or any outside id is kept as a link's `external` only when it fits the link alphabet (design 5.1). */
export const EXTERNAL_RE = /^[A-Za-z0-9_.:#-]{1,128}$/;

/** The hex sha256 of a text. */
export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The `eos-sanction` link key (design 5.1): the kit's group id and the first 16 hex of the hash of the product user id. The id itself is never kept. */
export const keyOf = (groupId: string, productUserId: string): string => `${groupId}#${sha256(productUserId).slice(0, 16)}`;

/** The `eos-report` link key (design 5.1): a one-way hash of the report's own fields, because EOS gives a report no id. */
export const reportKeyOf = (r: { time: string; reportingPlayerId: string; reportedPlayerId: string; reasonId: number }): string =>
  sha256(`${r.time}|${r.reportingPlayerId}|${r.reportedPlayerId}|${r.reasonId}`);

/** Seconds from `now` until `until`, rounded and at least 1; permanent (no end) is 0. */
export function durationSeconds(until: number | null, now: number): number {
  if (until === null) return 0;
  return Math.max(1, Math.round((until - now) / 1000));
}

/** At most `max` UTF-16 units, without leaving half of a surrogate pair at the end. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

/** The justification: the reference code and the rule only, or (when the adopter asked) the moderator's private reason, cut to 2048. */
export function justificationOf(mode: 'ref' | 'reason', refCode: string, rule: RuleRef | null, reason: string | null): string {
  if (mode === 'reason' && reason !== null && reason.trim().length > 0) return cutText(reason, JUSTIFICATION_MAX);
  return typeof rule === 'number' ? `Chatwarden ${refCode}, Rule ${rule}` : `Chatwarden ${refCode}`;
}

export interface SanctionBodyInput {
  productUserId: string;
  action: string;
  justification: string;
  refCode: string;
  rule: RuleRef | null;
  /** When it ends, or null for permanent (and for a warning). */
  until: number | null;
  now: number;
  automated: boolean;
}

/** One element of the create body (design 9.3, step 4). */
export function sanctionBody(i: SanctionBodyInput): Record<string, unknown> {
  const ruleTag = typeof i.rule === 'number' && /^\d{1,12}$/.test(String(i.rule)) ? [`rule${i.rule}`] : [];
  return {
    productUserId: i.productUserId,
    action: i.action,
    justification: i.justification,
    source: SOURCE,
    duration: durationSeconds(i.until, i.now),
    pending: false,
    automated: i.automated,
    tags: ['cw', ...ruleTag],
    metadata: { cw_ref: i.refCode, cw_rule: i.rule === null ? 'uncovered' : String(i.rule) },
  };
}

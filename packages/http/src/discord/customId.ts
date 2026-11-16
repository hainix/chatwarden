import { MAX_SANCTION_DURATION_MS } from '@chatwarden/core';
import type { SanctionKind } from '@chatwarden/core';

// The `cw1` custom_id grammar (K5 design 6.5). A custom_id is INPUT: Discord hands back whatever a client sent, so the grammar is closed and canonical
// (a string that parses encodes back to itself), and nothing in it chooses a role, an actor or a source. The grammar:
//
//   cw1:dis:<reportId>             preview a dismissal
//   cw1:sug:<reportId>             preview the profile's suggested step
//   cw1:ok:<reportId>:<code>       confirm; <code> is `n` (a dismissal) or <kind>.<durationMs|p>.<rule>
//   cw1:x                          cancel
//
// <kind> is chat, area, ban, warning or note; a warning or a note has no length (`p`); <rule> is a Community Rule number (1 to 999).

/** The most characters Discord allows in a custom_id. */
export const CUSTOM_ID_MAX = 100;
/** The grammar's version tag. */
export const VERSION_TAG = 'cw1';
/** The code of a dismissal. */
export const DISMISS_CODE = 'n';

const REPORT_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const KINDS = ['chat', 'area', 'ban', 'warning', 'note'] as const;
const RECORD_KINDS: readonly string[] = ['warning', 'note'];
const DURATION_RE = /^[1-9]\d{0,10}$/;
const RULE_RE = /^[1-9]\d{0,2}$/;

/** The step a code names (a decision's one action, without the person: that is always the report's own). */
export interface ActionShape {
  kind: SanctionKind;
  durationMs: number | null;
  rule: number;
}

/** What a code means: a dismissal, or one action. */
export type ParsedCode = { dismiss: true } | { dismiss: false; action: ActionShape };

/** What a custom_id means. */
export type ParsedCustomId =
  | { verb: 'dis'; reportId: string }
  | { verb: 'sug'; reportId: string }
  | { verb: 'ok'; reportId: string; code: string }
  | { verb: 'x' };

/** Read a code, or null for anything outside the grammar (never throws). */
export function parseCode(code: unknown): ParsedCode | null {
  if (typeof code !== 'string') return null;
  if (code === DISMISS_CODE) return { dismiss: true };
  const parts = code.split('.');
  if (parts.length !== 3) return null;
  const [kind, length, rule] = parts as [string, string, string];
  if (!(KINDS as readonly string[]).includes(kind) || !RULE_RE.test(rule)) return null;
  let durationMs: number | null;
  if (length === 'p') durationMs = null;
  else {
    // A warning or a note has no length: a number there is not a code any encoder makes.
    if (RECORD_KINDS.includes(kind) || !DURATION_RE.test(length)) return null;
    durationMs = Number(length);
    if (durationMs > MAX_SANCTION_DURATION_MS) return null;
  }
  return { dismiss: false, action: { kind: kind as ActionShape['kind'], durationMs, rule: Number(rule) } };
}

/** The action a code names, or null for a dismissal or anything invalid. */
export function actionOf(code: unknown): ActionShape | null {
  const parsed = parseCode(code);
  return parsed === null || parsed.dismiss ? null : parsed.action;
}

/** The code of an action, or of a dismissal when `action` is null. Throws `RangeError` for an action the grammar cannot hold. */
export function codeOf(action: ActionShape | null): string {
  if (action === null) return DISMISS_CODE;
  const code = `${action.kind}.${action.durationMs === null ? 'p' : String(action.durationMs)}.${String(action.rule)}`;
  if (parseCode(code) === null) throw new RangeError('discord: that action has no custom_id code');
  return code;
}

/** Build a custom_id. Throws `RangeError` for anything outside the grammar (a programming error, never a runtime input). */
export function encodeCustomId(p: { verb: string; reportId?: string; code?: string }): string {
  const bad = (): never => {
    throw new RangeError('discord: not a valid custom_id');
  };
  let out: string;
  if (p.verb === 'x') {
    if (p.reportId !== undefined || p.code !== undefined) return bad();
    out = `${VERSION_TAG}:x`;
  } else if (p.verb === 'dis' || p.verb === 'sug') {
    if (typeof p.reportId !== 'string' || !REPORT_ID_RE.test(p.reportId) || p.code !== undefined) return bad();
    out = `${VERSION_TAG}:${p.verb}:${p.reportId}`;
  } else if (p.verb === 'ok') {
    if (typeof p.reportId !== 'string' || !REPORT_ID_RE.test(p.reportId) || parseCode(p.code) === null) return bad();
    out = `${VERSION_TAG}:ok:${p.reportId}:${p.code as string}`;
  } else return bad();
  return out.length <= CUSTOM_ID_MAX ? out : bad();
}

/** Read a custom_id: the closed grammar above, or null for anything else. Never throws, whatever it is given. */
export function parseCustomId(value: unknown): ParsedCustomId | null {
  try {
    if (typeof value !== 'string' || value.length > CUSTOM_ID_MAX) return null;
    const parts = value.split(':');
    if (parts[0] !== VERSION_TAG) return null;
    const verb = parts[1];
    if (verb === 'x') return parts.length === 2 ? { verb: 'x' } : null;
    const reportId = parts[2];
    if (reportId === undefined || !REPORT_ID_RE.test(reportId)) return null;
    if (verb === 'dis') return parts.length === 3 ? { verb: 'dis', reportId } : null;
    if (verb === 'sug') return parts.length === 3 ? { verb: 'sug', reportId } : null;
    if (verb === 'ok') {
      const code = parts[3];
      return parts.length === 4 && parseCode(code) !== null ? { verb: 'ok', reportId, code: code as string } : null;
    }
    return null;
  } catch {
    return null;
  }
}

import { suggestedRule } from '@chatwarden/core';
import type { StaffReport } from '@chatwarden/core';
import type { ParsedDecision } from '../admin/apply.js';
import type { KitView, ResolvedCoopOptions } from './options.js';

// The Coop wire formats, as pure functions (K5 design 8.3 and 8.4): a kit report to the body of `POST /api/v1/report`, and a Coop callback to a kit decision or
// the reason it is ignored. Nothing here reads the store, the clock or the network.
// UNVERIFIED against a real Coop 1.2.2 (design section 15): that `creator` is honoured as a relation field, and that a thread item's `datetime` (sent both at the top
// level, as the API reference documents, and in `data`, as the design's item type has it) is the name Coop orders by. The local end to end settles both.

/** One line of the thread. `datetime` is at the top level (the documented ordering key) and in `data` (a field of the line item type). */
export interface CoopLine {
  id: string;
  typeId: string;
  datetime: string;
  data: { text: string; author: string; datetime: string; handle?: string };
}

export interface CoopReportData {
  category: string;
  reportedReason?: string;
  rule?: number;
  aiSeverity?: number;
  room?: string;
  creator: { id: string; typeId: string };
}

/** The body of `POST {baseUrl}/api/v1/report`. `csam` is never set: the kit does not detect it. */
export interface CoopReportBody {
  reporter: { kind: 'user'; id: string; typeId: string };
  reportedAt: string;
  reportedItem: { id: string; typeId: string; data: CoopReportData };
  reportedForReason?: { policyId?: string; reason?: string };
  reportedItemThread?: CoopLine[];
  reportedItemsInThread?: Array<{ id: string; typeId: string }>;
}

/** The longest a note, a reason or a piece of evidence is sent or stored. */
const TEXT_MAX = 500;
/** The room tags as one string. */
const ROOM_MAX = 200;
/** The most policies of a callback that are looked at (a hostile body may carry thousands). */
const POLICIES_LOOKED_AT = 100;
/** Stored when Coop gives no reason at all. */
export const DEFAULT_REASON = 'Decided in Coop';

/** `text` cut to `max` UTF-16 units, never in the middle of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** The kit's id of a thread line in Coop: line ids repeat across rooms, so the report id is part of it. */
export const lineItemId = (reportId: string, lineId: string): string => `${reportId}-${lineId}`;

const isoOf = (ms: number, fallback: number): string => new Date(Number.isFinite(ms) ? ms : fallback).toISOString();

/** The room's tags as `key=value` pairs joined by a comma, cut to 200 characters; undefined when there are none. */
function roomOf(tags: Readonly<Record<string, string>> | undefined): string | undefined {
  const pairs = Object.entries(tags ?? {}).map(([k, v]) => `${k}=${String(v)}`);
  return pairs.length === 0 ? undefined : cutText(pairs.join(','), ROOM_MAX);
}

/** A number from 0 to 100, or undefined. */
const severityOf = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100 ? v : undefined);

/**
 * The thread of a report: every excerpt line in time order (ties keep the stored order), labelled by role. A person is `reporter` or `reported` when they are,
 * else `other n` in order of first appearance; a speaker the kit has no person for is told apart by seat, and the seat id is never sent.
 */
function threadOf(report: StaffReport, opts: ResolvedCoopOptions): CoopLine[] {
  const indexed = report.excerpt.map((line, i) => ({ line, i }));
  indexed.sort((a, b) => (a.line.ts === b.line.ts ? a.i - b.i : a.line.ts - b.line.ts));
  const others = new Map<string, number>();
  return indexed.map(({ line }) => {
    const person = line.p === null ? undefined : report.people[line.p];
    const key = person === undefined ? `seat:${line.seatId}` : `person:${person}`;
    let label: string;
    if (person !== undefined && person === report.reporterPerson) label = 'reporter';
    else if (person !== undefined && person === report.targetPerson) label = 'reported';
    else {
      let n = others.get(key);
      if (n === undefined) {
        n = others.size + 1;
        others.set(key, n);
      }
      label = `other ${n}`;
    }
    const datetime = isoOf(line.ts, report.createdAt);
    return {
      id: lineItemId(report.id, line.lineId),
      typeId: opts.itemTypes.line,
      datetime,
      data: { text: line.raw, author: label, datetime, ...(opts.handles === 'shown' ? { handle: line.handle } : {}) },
    };
  });
}

/**
 * The body of a Coop report for a kit report (design 8.3). `kit` supplies the rules and the profile's reasons (the suggested rule rides in the item and
 * picks the policy when no reason maps); `aiSeverity` is the adopter's hook result, sent only when it is a number from 0 to 100. Pure.
 */
export function buildReport(report: StaffReport, opts: ResolvedCoopOptions, kit: KitView, aiSeverity?: unknown): CoopReportBody {
  const reason = typeof report.reportedReason === 'string' && report.reportedReason !== '' ? report.reportedReason : null;
  const rule = suggestedRule(kit.profile.reporting.reasons, reason, kit.rules);
  const severity = severityOf(aiSeverity);
  const room = roomOf(report.tags);
  const data: CoopReportData = {
    category: report.category,
    ...(reason === null ? {} : { reportedReason: reason }),
    ...(typeof rule === 'number' ? { rule } : {}),
    ...(severity === undefined ? {} : { aiSeverity: severity }),
    ...(room === undefined ? {} : { room }),
    creator: { id: report.targetPerson, typeId: opts.itemTypes.user },
  };

  const policyId = (reason === null ? undefined : opts.policyByReason.get(reason)) ?? (typeof rule === 'number' ? opts.policyByRule.get(rule) : undefined);
  const note = opts.includeNote && typeof report.note === 'string' ? report.note.trim() : '';
  const why = { ...(policyId === undefined ? {} : { policyId }), ...(note === '' ? {} : { reason: cutText(note, TEXT_MAX) }) };

  const thread = opts.evidence === 'excerpt' && report.excerpt.length > 0 ? threadOf(report, opts) : undefined;
  const reportedLine = thread !== undefined && report.lineId !== null && report.excerpt.some((l) => l.lineId === report.lineId) ? lineItemId(report.id, report.lineId) : undefined;

  return {
    reporter: { kind: 'user', id: report.reporterPerson, typeId: opts.itemTypes.user },
    reportedAt: isoOf(report.createdAt, 0),
    reportedItem: { id: report.id, typeId: opts.itemTypes.report, data },
    ...(Object.keys(why).length === 0 ? {} : { reportedForReason: why }),
    ...(thread === undefined ? {} : { reportedItemThread: thread }),
    ...(reportedLine === undefined ? {} : { reportedItemsInThread: [{ id: reportedLine, typeId: opts.itemTypes.line }] }),
  };
}

/**
 * The audit actor of a Coop moderator: `coop:<email>` with every character outside the audit charset (`A-Z a-z 0-9 _ . : @ + -`) replaced by `_`, cut to 128;
 * `coop:unknown` when there is no email (design 5.3).
 */
export function actorOf(email: unknown): string {
  const text = typeof email === 'string' ? email.trim() : '';
  if (text === '') return 'coop:unknown';
  return `coop:${text.replace(/[^A-Za-z0-9_.:@+-]/g, '_')}`.slice(0, 128);
}

/** A string with something in it, trimmed; undefined for anything else. */
const textOf = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a callback is acknowledged and not applied. Logged as `chatwarden.coop_callback_ignored` by reason code, nothing else. */
export type IgnoreReason = 'no_actor' | 'no_policies' | 'unknown_item' | 'closed' | 'unknown_action' | 'no_rule' | 'no_reason' | 'forbidden' | 'refused';

/**
 * Step 5 of design 8.4: a callback no moderator made is never applied. No `actorEmail` is a rule-triggered action; empty `policies` and `rules` together is a
 * strike threshold. The kit sends only reported items and the checklist says to turn strikes off; one that arrives anyway is ignored.
 */
export function screenCallback(callback: Record<string, unknown>): IgnoreReason | null {
  if (textOf(callback['actorEmail']) === undefined) return 'no_actor';
  const policies = callback['policies'];
  const rules = callback['rules'];
  if (!(Array.isArray(policies) && policies.length > 0) && !(Array.isArray(rules) && rules.length > 0)) return 'no_policies';
  return null;
}

export type CoopDecisionResult = { ok: true; decision: ParsedDecision; actor: string } | { ok: false; reason: IgnoreReason };

/**
 * Design 8.4 steps 5, 7, 8 and 9: the kit decision a verified Coop callback asks for, on `report`'s own target, or why not. The action id picks the decision
 * (an unknown one is ignored); the rule is the first of `policies[].id` that `rules` maps to a citable rule, else the suggested rule, else (for a verdict that
 * acts) ignored; the reason is `decisionReason`, else `actorNote`, else a fixed text, cut to 500 (a `bad_faith` needs a real one as its evidence). Pure.
 */
export function decisionOf(callback: Record<string, unknown>, opts: ResolvedCoopOptions, report: StaffReport, kit: KitView): CoopDecisionResult {
  const screened = screenCallback(callback);
  if (screened !== null) return { ok: false, reason: screened };
  const action = isObject(callback['action']) ? callback['action'] : undefined;
  const actionId = typeof action?.['id'] === 'string' ? action['id'] : undefined;
  const meaning = actionId === undefined ? undefined : opts.actions.get(actionId);
  if (meaning === undefined) return { ok: false, reason: 'unknown_action' };

  const written = textOf(callback['decisionReason']) ?? textOf(callback['actorNote']);
  const text = cutText(written ?? DEFAULT_REASON, TEXT_MAX);
  const actor = actorOf(callback['actorEmail']);

  if (meaning.verdict === 'no_action') return { ok: true, decision: { verdict: 'no_action', actions: [], reason: text }, actor };
  if (meaning.verdict === 'bad_faith') {
    if (written === undefined) return { ok: false, reason: 'no_reason' };
    return { ok: true, decision: { verdict: 'bad_faith', actions: [], reason: text, evidence: text }, actor };
  }

  // upheld or noted: a rule must be cited.
  let rule: number | undefined;
  const policies = Array.isArray(callback['policies']) ? callback['policies'].slice(0, POLICIES_LOOKED_AT) : [];
  for (const p of policies) {
    const id = isObject(p) && typeof p['id'] === 'string' ? p['id'] : undefined;
    const mapped = id === undefined ? undefined : opts.rules.get(id);
    if (mapped !== undefined && kit.rules.isCitable(mapped)) {
      rule = mapped;
      break;
    }
  }
  if (rule === undefined) {
    const suggested = suggestedRule(kit.profile.reporting.reasons, typeof report.reportedReason === 'string' ? report.reportedReason : null, kit.rules);
    if (typeof suggested === 'number') rule = suggested;
  }
  if (rule === undefined) return { ok: false, reason: 'no_rule' };

  const kind = meaning.verdict === 'noted' ? 'note' : meaning.kind;
  const durationMs = meaning.verdict === 'upheld' && meaning.kind !== 'warning' ? (meaning.durationMs ?? null) : null;
  return { ok: true, decision: { verdict: meaning.verdict, actions: [{ subject: report.targetPerson, kind, durationMs, rule }], reason: text }, actor };
}

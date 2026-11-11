import { personTag } from './format.js';
import type { HubT } from './i18n.js';
import type { ActionRecord, SanctionKind, StaffReport } from './types.js';

// Reading a report: who is in it, whose each line is, and what a person's record says. Pure; no words here.

export type PersonRole = 'target' | 'reporter' | 'other';

/** One person the report names. `ref` is the staff ref: the page shows its 8-character tag, never the ref. */
export interface ReportPerson {
  ref: string;
  role: PersonRole;
  /** The name they were seen under: their first handle in the excerpt, else the one recorded on the report, else null. */
  handle: string | null;
  /** Every handle seen in the excerpt, in order. */
  handles: string[];
  /** How many excerpt lines they wrote. */
  lines: number;
  /** The ids of those lines (from the server's `ownLineIds`), the only lines a notice may quote. */
  lineIds: string[];
}

/** The writer of an excerpt line: `people[p]`, or null when the line has no writer or `p` points nowhere. */
function writerOf(report: StaffReport, p: number | null): string | null {
  if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= report.people.length) return null;
  return report.people[p] ?? null;
}

/**
 * The people a report names, reported person first, then the reporter, then everyone else in the order they first wrote. The kit
 * does not say who is who: roles come from comparing refs with `targetPerson` and `reporterPerson`, and handles from the lines.
 */
export function peopleOfReport(report: StaffReport): ReportPerson[] {
  const order: string[] = [];
  const add = (ref: string): void => {
    if (!order.includes(ref)) order.push(ref);
  };
  add(report.targetPerson);
  add(report.reporterPerson);
  for (const ref of report.people) add(ref);

  const handles = new Map<string, string[]>();
  const counts = new Map<string, number>();
  for (const l of report.excerpt) {
    const who = writerOf(report, l.p);
    if (who === null) continue;
    counts.set(who, (counts.get(who) ?? 0) + 1);
    const seen = handles.get(who) ?? [];
    if (!seen.includes(l.handle)) seen.push(l.handle);
    handles.set(who, seen);
  }

  return order.map((ref): ReportPerson => {
    const role: PersonRole = ref === report.targetPerson ? 'target' : ref === report.reporterPerson ? 'reporter' : 'other';
    const seen = handles.get(ref) ?? [];
    const recorded = role === 'target' ? report.targetHandle : role === 'reporter' ? report.reporterHandle : '';
    return {
      ref,
      role,
      handle: seen[0] ?? (recorded === '' ? null : recorded),
      handles: seen,
      lines: counts.get(ref) ?? 0,
      lineIds: [...(report.ownLineIds[ref] ?? [])],
    };
  });
}

/**
 * What to call a person: their handle, or "Person <tag>"; a handle two people share gets the tag too. The shape of both comes
 * from the catalog (`hub.person.unnamed`, `hub.person.named`), so a language can put the tag where it reads best.
 */
export function personName(person: ReportPerson, all: readonly ReportPerson[], t: HubT): string {
  const tag = personTag(person.ref);
  if (person.handle === null) return t('hub.person.unnamed', { tag });
  const shared = all.some((o) => o.ref !== person.ref && o.handle === person.handle);
  return shared ? t('hub.person.named', { name: person.handle, tag }) : person.handle;
}

/** One line of the excerpt, ready to show. */
export interface ExcerptLine {
  id: string;
  ts: number;
  handle: string;
  raw: string;
  /** What the others were shown; null when the line was blocked. */
  delivered: string | null;
  blocked: boolean;
  /** Seat ids that could see it; null is the whole room. */
  audience: string[] | null;
  /** The staff ref of the writer, or null when unknown. */
  person: string | null;
  /** The line the report was about. */
  reported: boolean;
}

export function excerptLines(report: StaffReport): ExcerptLine[] {
  return report.excerpt.map((l) => ({
    id: l.lineId,
    ts: l.ts,
    handle: l.handle,
    raw: l.raw,
    delivered: l.delivered,
    blocked: l.blocked,
    audience: l.audience === null ? null : [...l.audience],
    person: writerOf(report, l.p),
    reported: report.lineId !== null && l.lineId === report.lineId,
  }));
}

/** The lines of one person, or all of them for `null`. */
export function filterLines(lines: readonly ExcerptLine[], person: string | null): ExcerptLine[] {
  return person === null ? [...lines] : lines.filter((l) => l.person === person);
}

export interface RecordSummary {
  /** What stands, by kind (revoked actions are not counted). */
  counts: Partial<Record<SanctionKind, number>>;
  /** How many actions stand. */
  total: number;
  revoked: number;
}

/** A person's last 90 days, as counts: what stands, and how many were revoked. */
export function recordSummary(history: readonly ActionRecord[]): RecordSummary {
  const counts: Partial<Record<SanctionKind, number>> = {};
  let total = 0;
  let revoked = 0;
  for (const a of history) {
    if (a.revoked) {
      revoked += 1;
      continue;
    }
    counts[a.kind] = (counts[a.kind] ?? 0) + 1;
    total += 1;
  }
  return { counts, total, revoked };
}

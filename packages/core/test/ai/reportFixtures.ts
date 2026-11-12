import type { ReportExcerptLine, ReportRecord } from '../../src/types.js';

// Builds a ReportRecord for the AI tests. Synthetic names only. `who` is 'target', 'reporter' or any other key (a third person).

export interface LineSpec {
  who: string;
  text: string;
  /** Epoch ms offset from the report's start (default: 1 000 ms per line). */
  at?: number;
  blocked?: boolean;
  /** Who could see it: 'all' (default), or a list of `who` keys. */
  audience?: 'all' | string[];
  /** Give the line no subject index (a speaker the room could not identify). */
  noSubject?: boolean;
  delivered?: string | null;
}

export interface Person {
  subject: string;
  seat: string;
  handle: string;
}

export const T0 = 1_800_000_000_000;

export function person(who: string): Person {
  if (who === 'target') return { subject: 'subj-target-77a1c0de', seat: 'seat-t9x2', handle: 'zorbakplays' };
  if (who === 'reporter') return { subject: 'subj-reporter-5be2f4', seat: 'seat-r4k8', handle: 'quissel_fan' };
  return { subject: `subj-${who}-0a1b2c`, seat: `seat-${who}-z7`, handle: `${who}_handle` };
}

export function mkReport(
  lines: LineSpec[],
  o: { point?: number | null; note?: string | null; reason?: string | null; id?: string; tags?: Record<string, string> } = {},
): ReportRecord {
  const target = person('target');
  const reporter = person('reporter');
  const people: string[] = [];
  const subjectIndex = (who: string) => {
    const s = person(who).subject;
    let i = people.indexOf(s);
    if (i < 0) {
      people.push(s);
      i = people.length - 1;
    }
    return i;
  };
  const excerpt: ReportExcerptLine[] = lines.map((l, i) => {
    const p = person(l.who);
    const audience = l.audience === undefined || l.audience === 'all' ? null : l.audience.map((w) => person(w).seat);
    return {
      lineId: `line-${i}-${p.seat}`,
      ts: T0 + (l.at ?? i * 1000),
      seatId: p.seat,
      handle: p.handle,
      raw: l.text,
      delivered: l.blocked ? null : (l.delivered === undefined ? l.text : l.delivered),
      blocked: l.blocked ?? false,
      audience,
      p: l.noSubject ? null : subjectIndex(l.who),
    };
  });
  const point = o.point === undefined ? null : o.point;
  return {
    id: o.id ?? 'report-1',
    createdAt: T0 + 600_000,
    roomId: 'room-secret-42',
    tags: o.tags ?? { mode: 'ranked' },
    reporterSubject: reporter.subject,
    reporterSeat: reporter.seat,
    reporterHandle: reporter.handle,
    targetSubject: target.subject,
    targetSeat: target.seat,
    targetHandle: target.handle,
    category: 'other',
    reportedReason: o.reason ?? null,
    note: o.note ?? null,
    lineId: point === null ? null : (excerpt[point]?.lineId ?? 'line-missing'),
    excerpt,
    people,
    status: 'open',
    badFaith: false,
    actionedAt: null,
    actionedBy: null,
    modNote: null,
    badFaithEvidence: null,
  };
}

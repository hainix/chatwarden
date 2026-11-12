import type { ReportExcerptLine, ReportRecord } from '../types.js';
import { redactNote, redactText } from './redact.js';
import type { AIPerson } from './types.js';

// Line choice and aliasing (design section 8, "Choosing the lines"). Pure. A report carries up to 100 lines; a read sees at most 40,
// every one redacted, speakers as P1 (the reported person), P2 (the reporter) and P3... (everyone else, by first appearance).

/** The most lines a read sees. */
export const AI_MAX_LINES = 40;
/** How many of the reported person's latest lines are kept first. */
const OWN_LATEST = 20;
/** Lines kept before and after the one the reporter pointed at. */
const BEFORE = 12;
const AFTER = 6;

/**
 * One line a read will see. `lineId` is the server's key to map an answer's ref back to the real line: it is NOT handed to an
 * adapter, which gets refs only.
 * @experimental
 */
export interface ChosenLine {
  ref: string;
  lineId: string;
  /** Seconds since the first chosen line. */
  secondsIn: number;
  /** An alias: `P1`, `P2`, ... */
  who: string;
  /** Redacted. */
  text: string;
  /** The term filter blocked it (the raw text is sent; an adapter option may mask it). */
  blocked: boolean;
  /**
   * The profanity filter starred it in the room but did not block it: the raw text is sent. Like `blocked`, this is a line the filter
   * touched, and the same future adapter option (`mask`) governs both.
   */
  filtered: boolean;
  /** Written by the reported person. */
  byReported: boolean;
}

/**
 * What {@link chooseLines} returns.
 * @experimental
 */
export interface ChosenLines {
  lines: ChosenLine[];
  /** Lines the reporter could see were left out of the cap. */
  truncated: boolean;
  /** P1 and P2 first, then the others who spoke in a chosen line. */
  people: AIPerson[];
  /** The ref of the line the reporter pointed at, or null. */
  reportedLine: string | null;
  /** The reporter's note, redacted with the same aliases as the lines and cut to 300 characters; null when there is none. */
  note: string | null;
}

type Role = AIPerson['role'];

function roleOf(report: ReportRecord, line: ReportExcerptLine): Role {
  const subject = line.p === null ? undefined : report.people[line.p];
  if (subject !== undefined) {
    if (subject === report.targetSubject) return 'reported';
    if (subject === report.reporterSubject) return 'reporter';
    return 'other';
  }
  if (line.seatId === report.targetSeat) return 'reported';
  if (line.seatId === report.reporterSeat) return 'reporter';
  return 'other';
}

/** One key per distinct speaker: the subject when the room knew one, otherwise the seat. */
function speakerKey(report: ReportRecord, line: ReportExcerptLine): string {
  const subject = line.p === null ? undefined : report.people[line.p];
  return subject !== undefined ? `s:${subject}` : `seat:${line.seatId}`;
}

interface Analysis {
  result: ChosenLines;
  handles: string[];
  aliasOf: (h: string) => string | null;
}

function analyse(report: ReportRecord, opts: { max?: number } | undefined): Analysis {
  const max = Math.max(1, Math.floor(opts?.max ?? AI_MAX_LINES));
  // Time order, ties broken by the stored order, so the same report always gives the same choice.
  const all = report.excerpt.map((line, i) => ({ line, i })).sort((a, b) => a.line.ts - b.line.ts || a.i - b.i).map((e) => e.line);
  const visible = all.filter((l) => l.audience === null || l.audience.includes(report.reporterSeat));
  const n = visible.length;
  const roles = visible.map((l) => roleOf(report, l));

  // 1. Choose positions (in `visible`), most important first, until the cap.
  const chosen = new Set<number>();
  const add = (pos: number) => {
    if (pos >= 0 && pos < n && chosen.size < max) chosen.add(pos);
  };
  const pointed = report.lineId === null ? -1 : visible.findIndex((l) => l.lineId === report.lineId);
  if (pointed >= 0) add(pointed);
  const own: number[] = [];
  roles.forEach((r, pos) => r === 'reported' && own.push(pos));
  for (const pos of own.slice(-OWN_LATEST).reverse()) add(pos);
  if (pointed >= 0) {
    for (let d = 1; d <= BEFORE; d += 1) {
      add(pointed - d);
      if (d <= AFTER) add(pointed + d);
    }
  }
  const anchor = pointed >= 0 ? pointed : (own[own.length - 1] ?? n - 1);
  // Then the nearest others (ties go to the earlier line). The reported person's older lines are not "others": the latest 20 rule
  // already decided those.
  const spare = (pos: number) => roles[pos] !== 'reported';
  if (spare(anchor)) add(anchor);
  for (let d = 1; chosen.size < Math.min(max, n) && d <= n; d += 1) {
    if (spare(anchor - d)) add(anchor - d);
    if (spare(anchor + d)) add(anchor + d);
  }
  const positions = [...chosen].sort((a, b) => a - b);

  // 2. Aliases: P1 reported, P2 reporter, then the others by first appearance in the chosen lines, then the rest of the room.
  const alias = new Map<string, string>(); // speaker key -> alias
  let next = 3;
  const aliasFor = (line: ReportExcerptLine, role: Role): string => {
    if (role === 'reported') return 'P1';
    if (role === 'reporter') return 'P2';
    const key = speakerKey(report, line);
    let a = alias.get(key);
    if (a === undefined) {
      a = `P${next}`;
      next += 1;
      alias.set(key, a);
    }
    return a;
  };
  const people: AIPerson[] = [
    { alias: 'P1', role: 'reported' },
    { alias: 'P2', role: 'reporter' },
  ];
  const chosenLines = positions.map((pos) => visible[pos] as ReportExcerptLine);
  const whos = chosenLines.map((line, k) => {
    const role = roles[positions[k] as number] as Role;
    const a = aliasFor(line, role);
    if (role === 'other' && !people.some((p) => p.alias === a)) people.push({ alias: a, role });
    return a;
  });
  // The rest of the room (including lines the reporter could not see) is aliased too, so a handle named in a chosen line is replaced.
  for (const line of all) aliasFor(line, roleOf(report, line));

  // 3. Everything that could name a person -> that person's alias, first writer wins.
  const byName = new Map<string, string>();
  const name = (s: string | undefined, a: string) => {
    if (s !== undefined && s !== '' && !byName.has(s)) byName.set(s, a);
  };
  name(report.targetHandle, 'P1');
  name(report.targetSeat, 'P1');
  name(report.targetSubject, 'P1');
  name(report.reporterHandle, 'P2');
  name(report.reporterSeat, 'P2');
  name(report.reporterSubject, 'P2');
  for (const line of all) {
    const a = aliasFor(line, roleOf(report, line));
    name(line.handle, a);
    name(line.seatId, a);
    name(line.p === null ? undefined : report.people[line.p], a);
  }
  const handles = [...byName.keys()];
  const aliasOf = (h: string): string | null => byName.get(h) ?? null;

  // 4. Render.
  const first = chosenLines[0]?.ts ?? 0;
  const lines: ChosenLine[] = chosenLines.map((line, k) => ({
    ref: `L${k + 1}`,
    lineId: line.lineId,
    secondsIn: Math.max(0, Math.round((line.ts - first) / 1000)),
    who: whos[k] as string,
    text: redactText(line.raw, handles, aliasOf),
    blocked: line.blocked,
    // Star-masked in the room (not blocked): the filter touched it, the raw text is still what we send.
    filtered: !line.blocked && line.delivered !== null && line.delivered !== line.raw,
    byReported: roles[positions[k] as number] === 'reported',
  }));
  const reportedLine = report.lineId === null ? null : (lines.find((l) => l.lineId === report.lineId)?.ref ?? null);
  const note = redactNote(report.note, handles, aliasOf);
  return { result: { lines, truncated: chosen.size < n, people, reportedLine, note }, handles, aliasOf };
}

/**
 * Choose the lines a read sees, in time order: the pointed-at line, the reported person's latest 20, 12 before and 6 after the
 * pointed-at line, then the nearest others, up to `max` (default 40). Lines the reporter could not see are dropped. Text is
 * redacted and speakers are aliased; `P1` is the reported person and `P2` the reporter even when the reporter spoke first.
 * @experimental
 */
export function chooseLines(report: ReportRecord, opts?: { max?: number }): ChosenLines {
  return analyse(report, opts).result;
}

/**
 * The reporter's note, redacted and cut to 300 characters (the `note` of {@link chooseLines}). Pass the same `opts` as the
 * `chooseLines` call it goes with, or prefer `chooseLines(...).note`, which cannot disagree with the lines.
 * @experimental
 */
export function redactReportNote(report: ReportRecord, opts?: { max?: number }): string | null {
  const { handles, aliasOf } = analyse(report, opts);
  return redactNote(report.note, handles, aliasOf);
}

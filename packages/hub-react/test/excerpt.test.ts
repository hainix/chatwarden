import { describe, expect, it } from 'vitest';
import { excerptLines, filterLines, peopleOfReport, personName, recordSummary } from '../src/excerpt.js';
import type { ActionRecord, StaffReport } from '../src/types.js';

// Pure rules for reading a report: who is in it, which lines are whose, and what a person's record says.

const line = (lineId: string, p: number | null, handle: string, extra: Partial<StaffReport['excerpt'][number]> = {}): StaffReport['excerpt'][number] => ({
  lineId,
  ts: 1_800_000_000_000 + Number(lineId) * 1000,
  seatId: `seat-${handle}`,
  handle,
  raw: `${handle} says ${lineId}`,
  delivered: `${handle} says ${lineId}`,
  blocked: false,
  audience: null,
  p,
  ...extra,
});

function report(over: Partial<StaffReport> = {}): StaffReport {
  return {
    id: 'r1',
    createdAt: 1_800_000_100_000,
    roomId: 'room-1',
    tags: {},
    reporterSubject: 'sub-reporter-0000',
    reporterSeat: 's1',
    reporterHandle: 'Rae',
    targetSubject: 'sub-target-0000',
    targetSeat: 's2',
    targetHandle: 'Mallory',
    category: 'harassment',
    note: null,
    lineId: '2',
    excerpt: [line('1', 0, 'Rae'), line('2', 1, 'Mallory'), line('3', 2, 'Bystander'), line('4', 1, 'Mallory')],
    people: ['sub-reporter-0000', 'sub-target-0000', 'sub-bystander-0'],
    status: 'open',
    badFaith: false,
    actionedAt: null,
    actionedBy: null,
    modNote: null,
    badFaithEvidence: null,
    targetPerson: 'sub-target-0000',
    reporterPerson: 'sub-reporter-0000',
    ownLineIds: { 'sub-reporter-0000': ['1'], 'sub-target-0000': ['2', '4'], 'sub-bystander-0': ['3'] },
    ...over,
  } as StaffReport;
}

describe('peopleOfReport', () => {
  it('lists the reported person first, then the reporter, then everyone else in the order they first wrote', () => {
    const people = peopleOfReport(report());
    expect(people.map((p) => [p.ref, p.role])).toEqual([
      ['sub-target-0000', 'target'],
      ['sub-reporter-0000', 'reporter'],
      ['sub-bystander-0', 'other'],
    ]);
  });

  it('takes handles from the excerpt lines, not from the order of people', () => {
    const people = peopleOfReport(report());
    expect(people.map((p) => p.handle)).toEqual(['Mallory', 'Rae', 'Bystander']);
  });

  it('does not rely on the server listing the reported person first (the kit lists first-seen writers)', () => {
    const r = report({ people: ['sub-bystander-0', 'sub-target-0000', 'sub-reporter-0000'], excerpt: [line('1', 2, 'Rae'), line('2', 1, 'Mallory'), line('3', 0, 'Bystander')] });
    const people = peopleOfReport(r);
    expect(people.map((p) => [p.role, p.handle])).toEqual([
      ['target', 'Mallory'],
      ['reporter', 'Rae'],
      ['other', 'Bystander'],
    ]);
  });

  it('counts the lines each person wrote and carries their own line ids', () => {
    const [target, reporter, other] = peopleOfReport(report());
    expect(target).toMatchObject({ lines: 2, lineIds: ['2', '4'] });
    expect(reporter).toMatchObject({ lines: 1, lineIds: ['1'] });
    expect(other).toMatchObject({ lines: 1, lineIds: ['3'] });
  });

  it('keeps every handle a person used, the first one as their name', () => {
    const r = report({ excerpt: [line('1', 1, 'Mallory'), line('2', 1, 'Mal'), line('3', 0, 'Rae')], people: ['sub-reporter-0000', 'sub-target-0000'] });
    const target = peopleOfReport(r).find((p) => p.role === 'target');
    expect(target?.handle).toBe('Mallory');
    expect(target?.handles).toEqual(['Mallory', 'Mal']);
  });

  it('a person with no lines falls back to the handle recorded on the report, and says they sent none', () => {
    const r = report({ excerpt: [line('1', 0, 'Rae')], people: ['sub-reporter-0000'], ownLineIds: { 'sub-reporter-0000': ['1'] } });
    const target = peopleOfReport(r).find((p) => p.role === 'target');
    expect(target).toMatchObject({ ref: 'sub-target-0000', handle: 'Mallory', lines: 0, lineIds: [] });
  });

  it('a person with no handle anywhere has a null handle', () => {
    const r = report({ targetHandle: '', excerpt: [], people: [], ownLineIds: {} });
    expect(peopleOfReport(r).find((p) => p.role === 'target')?.handle).toBeNull();
  });

  it('merges two people entries that are the same person after a merge', () => {
    const r = report({
      people: ['sub-target-0000', 'sub-target-0000', 'sub-reporter-0000'],
      excerpt: [line('1', 0, 'Mallory'), line('2', 1, 'Mal'), line('3', 2, 'Rae')],
      ownLineIds: { 'sub-target-0000': ['1', '2'], 'sub-reporter-0000': ['3'] },
    });
    const people = peopleOfReport(r);
    expect(people).toHaveLength(2);
    expect(people[0]).toMatchObject({ role: 'target', lines: 2, handles: ['Mallory', 'Mal'] });
  });

  it('ignores a line whose p points outside people', () => {
    const r = report({ excerpt: [line('1', 7, 'Ghost'), line('2', null, 'System')] });
    expect(peopleOfReport(r).flatMap((p) => p.handles)).not.toContain('Ghost');
    expect(peopleOfReport(r).flatMap((p) => p.handles)).not.toContain('System');
  });

  it('survives an empty report', () => {
    const r = report({ excerpt: [], people: [], ownLineIds: {}, targetHandle: '', reporterHandle: '' });
    expect(peopleOfReport(r)).toHaveLength(2);
  });
});

describe('personName', () => {
  it('is the handle, or "Person" plus the tag when there is none', () => {
    const people = peopleOfReport(report({ targetHandle: '', excerpt: [], people: [], ownLineIds: {} }));
    const target = people.find((p) => p.role === 'target')!;
    expect(personName(target, people, 'Person')).toBe('Person sub-targ');
    const reporter = people.find((p) => p.role === 'reporter')!;
    expect(personName(reporter, people, 'Person')).toBe('Rae');
  });

  it('adds the tag to a handle two people share, so they can be told apart', () => {
    const r = report({ excerpt: [line('1', 0, 'Sam'), line('2', 1, 'Sam')], people: ['sub-reporter-0000', 'sub-target-0000'], ownLineIds: {} });
    const people = peopleOfReport(r);
    expect(people.map((p) => personName(p, people, 'Person'))).toEqual(['Sam (sub-targ)', 'Sam (sub-repo)']);
  });

  it('never shows more than the 8-character tag', () => {
    const people = peopleOfReport(report({ targetHandle: '', excerpt: [], people: [], ownLineIds: {} }));
    for (const p of people) expect(personName(p, people, 'Person')).not.toContain('0000');
  });
});

describe('excerptLines', () => {
  it('marks the reported line and nothing else', () => {
    const lines = excerptLines(report());
    expect(lines.filter((l) => l.reported).map((l) => l.id)).toEqual(['2']);
  });

  it('no reported line when the report cites none', () => {
    expect(excerptLines(report({ lineId: null })).some((l) => l.reported)).toBe(false);
  });

  it('keeps the order of the excerpt and says whose each line is', () => {
    const lines = excerptLines(report());
    expect(lines.map((l) => [l.id, l.person])).toEqual([
      ['1', 'sub-reporter-0000'],
      ['2', 'sub-target-0000'],
      ['3', 'sub-bystander-0'],
      ['4', 'sub-target-0000'],
    ]);
  });

  it('carries blocked, the delivered text, who could see it and when', () => {
    const r = report({ excerpt: [line('1', 1, 'Mallory', { blocked: true, delivered: null, audience: ['s1', 's2'] }), line('2', 1, 'Mallory', { delivered: 'm*****' })] });
    const [a, b] = excerptLines(r);
    expect(a).toMatchObject({ blocked: true, delivered: null, audience: ['s1', 's2'] });
    expect(b).toMatchObject({ blocked: false, delivered: 'm*****', audience: null });
    expect(a?.ts).toBe(r.excerpt[0]?.ts);
  });

  it('a line with no writer has a null person', () => {
    expect(excerptLines(report({ excerpt: [line('1', null, 'System')] }))[0]?.person).toBeNull();
  });
});

describe('filterLines', () => {
  it('everyone: all lines', () => {
    expect(filterLines(excerptLines(report()), null)).toHaveLength(4);
  });
  it('only one person: just their lines', () => {
    expect(filterLines(excerptLines(report()), 'sub-target-0000').map((l) => l.id)).toEqual(['2', '4']);
  });
  it('a person with no lines: nothing', () => {
    expect(filterLines(excerptLines(report()), 'sub-nobody')).toEqual([]);
  });
});

describe('recordSummary', () => {
  const rec = (kind: ActionRecord['kind'], over: Partial<ActionRecord> = {}): ActionRecord => ({ kind, durationMs: null, startsAt: 1, revoked: false, automated: false, roomId: null, ...over });

  it('nothing on record', () => {
    expect(recordSummary([])).toEqual({ counts: {}, total: 0, revoked: 0 });
  });
  it('counts what stands, by kind', () => {
    const s = recordSummary([rec('warning'), rec('warning'), rec('chat', { durationMs: 1 }), rec('note')]);
    expect(s).toEqual({ counts: { warning: 2, chat: 1, note: 1 }, total: 4, revoked: 0 });
  });
  it('keeps revoked actions apart from the counts', () => {
    const s = recordSummary([rec('ban', { revoked: true }), rec('warning')]);
    expect(s).toEqual({ counts: { warning: 1 }, total: 1, revoked: 1 });
  });
  it('only revoked: total is 0 and revoked says how many', () => {
    expect(recordSummary([rec('area', { revoked: true })])).toEqual({ counts: {}, total: 0, revoked: 1 });
  });
});

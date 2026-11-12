// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { personTag } from '../src/format.js';
import { peopleOfReport, personName, excerptLines } from '../src/excerpt.js';
import { createT, en } from '../src/i18n.js';
import { displayName, groupName } from '../src/labels.js';
import { groupQueue } from '../src/queue.js';
import type { ReportSummary, StaffReport } from '../src/types.js';

// displayName is the one way a handle becomes text (names, design 5.5). A handle the server flags is the "hidden" label until a moderator shows it; an
// unflagged handle, or one from a server that flags nothing, is as typed. Synthetic names only.

const t = createT(en);
const HIDDEN = en['hub.mask.label'];
const NAME = 'zorbakKid';

describe('displayName', () => {
  it('shows a flagged handle as the hide label, and as typed once revealed', () => {
    expect(displayName(t, { handle: NAME, flagged: true })).toBe(HIDDEN);
    expect(displayName(t, { handle: NAME, flagged: true, revealed: false })).toBe(HIDDEN);
    expect(displayName(t, { handle: NAME, flagged: true, revealed: true })).toBe(NAME);
  });

  it('never carries any part of a hidden handle', () => {
    const text = displayName(t, { handle: NAME, flagged: true });
    expect(text.toLowerCase()).not.toContain('zorbak');
    expect(text.length).toBe(HIDDEN.length);
  });

  it('leaves an unflagged handle exactly as typed, revealed or not', () => {
    expect(displayName(t, { handle: 'Mallory', flagged: false })).toBe('Mallory');
    expect(displayName(t, { handle: 'Mallory', flagged: false, revealed: true })).toBe('Mallory');
    expect(displayName(t, { handle: 'Mallory' })).toBe('Mallory');
  });

  it('an older server that sends no flag (undefined) shows names as before', () => {
    expect(displayName(t, { handle: NAME, flagged: undefined })).toBe(NAME);
    expect(displayName(t, { handle: NAME })).toBe(NAME);
  });

  it('is empty for no handle, flagged or not', () => {
    expect(displayName(t, { handle: null })).toBe('');
    expect(displayName(t, { handle: null, flagged: true })).toBe('');
  });

  it('keeps a name that only looks like a mask a name: exactly what was typed', () => {
    expect(displayName(t, { handle: HIDDEN, flagged: false })).toBe(HIDDEN);
  });
});

describe('groupName', () => {
  const person = 's_abcdefghijk';
  it('masks a flagged group handle; the tag fallback is unchanged', () => {
    expect(groupName(t, { handle: NAME, handleFlagged: true, person })).toBe(HIDDEN);
    expect(groupName(t, { handle: NAME, handleFlagged: true, person }, true)).toBe(NAME);
    expect(groupName(t, { handle: 'Mallory', person })).toBe('Mallory');
    expect(groupName(t, { handle: NAME, person })).toBe(NAME);
    expect(groupName(t, { handle: null, person })).toBe(t('hub.person.unnamed', { tag: personTag(person) }));
  });
});

const summary = (over: Partial<ReportSummary>): ReportSummary =>
  ({
    id: 'r1',
    createdAt: 1000,
    roomId: 'room',
    tags: {},
    category: 'harassment',
    reportedReason: null,
    status: 'open',
    badFaith: false,
    targetPerson: 's_target',
    reporterPerson: 's_reporter',
    actionedAt: null,
    actionedBy: null,
    targetHandle: 'Mallory',
    reporterHandle: 'Rep',
    claim: null,
    viewing: [],
    ...over,
  }) as ReportSummary;

describe('the queue group carries the flag', () => {
  it('handleFlagged is set from targetHandleFlagged, with the flagged handles named; an unflagged group has neither key', () => {
    const [flagged] = groupQueue([summary({ targetHandle: NAME, targetHandleFlagged: true })]);
    expect(flagged?.handleFlagged).toBe(true);
    expect(flagged?.flaggedHandles).toEqual([NAME]);
    const [plain] = groupQueue([summary({})]);
    expect('handleFlagged' in (plain as object)).toBe(false);
    expect('flaggedHandles' in (plain as object)).toBe(false);
    expect('reporterHandlesFlagged' in (plain as object)).toBe(false);
  });

  it('an older handle that is flagged is named in flaggedHandles, and the newest unflagged handle is not masked', () => {
    const [g] = groupQueue([summary({ id: 'a', createdAt: 1, targetHandle: NAME, targetHandleFlagged: true }), summary({ id: 'b', createdAt: 2, targetHandle: 'Mallory' })]);
    expect(g?.handle).toBe('Mallory');
    expect(g?.handleFlagged).toBeUndefined();
    expect(g?.flaggedHandles).toEqual([NAME]);
  });

  it('a flagged reporter handle is remembered by reporter', () => {
    const [g] = groupQueue([summary({ reporterHandle: NAME, reporterHandleFlagged: true })]);
    expect(g?.reporterHandlesFlagged).toEqual({ s_reporter: true });
  });
});

const report = (over: Record<string, unknown> = {}): StaffReport =>
  ({
    id: 'r1',
    createdAt: 1000,
    roomId: 'room',
    tags: {},
    category: 'harassment',
    status: 'open',
    badFaith: false,
    targetPerson: 's_target',
    reporterPerson: 's_reporter',
    targetHandle: 'Mallory',
    reporterHandle: 'Rep',
    people: ['s_reporter', 's_target'],
    lineId: '2',
    ownLineIds: { s_target: ['2'] },
    excerpt: [
      { lineId: '1', ts: 1, seatId: 'p1', handle: 'Rep', raw: 'hello', delivered: 'hello', blocked: false, audience: null, p: 0 },
      { lineId: '2', ts: 2, seatId: 'p2', handle: NAME, raw: 'hi', delivered: 'hi', blocked: false, audience: null, p: 1, handleFlagged: true },
    ],
    ...over,
  }) as unknown as StaffReport;

describe('a report carries the flag to its lines and people', () => {
  it('excerpt lines and the people they belong to', () => {
    const r = report();
    expect(excerptLines(r).map((l) => l.handleFlagged)).toEqual([false, true]);
    const people = peopleOfReport(r);
    expect(people.map((p) => [p.role, p.handleFlagged])).toEqual([
      ['target', true],
      ['reporter', false],
    ]);
  });

  it("a person seen in no line takes the report's own flag for the recorded handle", () => {
    const r = report({ excerpt: [], targetHandle: NAME, targetHandleFlagged: true, reporterHandle: 'Rep' });
    const people = peopleOfReport(r);
    expect(people.find((p) => p.role === 'target')?.handleFlagged).toBe(true);
    expect(people.find((p) => p.role === 'reporter')?.handleFlagged).toBe(false);
  });

  it('personName masks a flagged person, and shows it once revealed', () => {
    const people = peopleOfReport(report());
    const target = people.find((p) => p.role === 'target');
    const rep = people.find((p) => p.role === 'reporter');
    if (target === undefined || rep === undefined) throw new Error('no people');
    expect(personName(target, people, t)).toBe(HIDDEN);
    expect(personName(target, people, t, true)).toBe(NAME);
    expect(personName(rep, people, t)).toBe('Rep');
  });

  it('an older server (no flag anywhere) reads exactly as before', () => {
    const r = report({ excerpt: report().excerpt.map((l) => ({ ...l, handleFlagged: undefined })) });
    const people = peopleOfReport(r);
    expect(people.map((p) => p.handleFlagged)).toEqual([false, false]);
    expect(personName(people[0] as never, people, t)).toBe(NAME);
  });
});

// A lint-style test: every place in src/ that reads a handle (`.handle`, `.handles`, `targetHandle`, `reporterHandle(s)`) either turns it into text through
// displayName / groupName / personName / NameValue on that line, or is on this list, each entry with its reason. A new surface that draws a raw handle
// fails here until it goes through displayName or is added with a reason a reviewer can read.
const SRC = fileURLToPath(new URL('../src', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : /\.tsx?$/.test(n) ? [join(dir, n)] : []));
const READS = /\.handles?\b|\btargetHandle\b|\breporterHandles?\b|\bhandle:/;
const TEXT = /displayName\(|groupName\(|personName\(|<NameValue\b/;

/** Whole files that only carry or build handles (data in, text made by the helpers), and the unrelated uses of the word. */
const FILES: Record<string, string> = {
  'queue.ts': 'builds the groups from the server rows: data, not text',
  'excerpt.ts': 'reads the report into people and lines: data; personName is here',
  'types.ts': 'the shapes',
  'labels.ts': 'displayName and groupName are here',
  'headless/env.ts': 'a timer handle',
  'transport.ts': 'a request handler',
};
/** Single lines elsewhere: file -> [text of the line, why]. */
const LINES: Record<string, Array<[string, string]>> = {
  'screens/Person.tsx': [
    ['data?.handle ?? null', 'read once; every use goes through groupName or NameValue'],
  ],
  'case/AppealCard.tsx': [['history.data?.handle ?? null', 'read once; it goes through groupName and NameValue']],
  'shell/CasePanel.tsx': [['group?.reporterHandles[ref]', 'feeds displayName on the next line']],
  'shell/CommandBar.tsx': [['keywords:', 'searched, never drawn: typing a name still finds the person']],
  'QueueRow.tsx': [
    ['group.handle === null', 'whether there is a name; the text is groupName'],
    ['group.handles.slice(1).map', 'each goes through displayName'],
    ['group.handles.length > 1', 'a count'],
  ],
};

describe('every surface that renders a handle goes through displayName', () => {
  const found: Array<{ file: string; line: string }> = [];
  for (const path of walk(SRC)) {
    const file = relative(SRC, path).replaceAll(sep, '/');
    if (file === 'i18n.ts' || file in FILES) continue;
    for (const line of readFileSync(path, 'utf8').split(String.fromCharCode(10))) if (READS.test(line)) found.push({ file, line: line.trim() });
  }

  it('no raw handle is drawn: each read is turned into text by the helpers, or is allowed with a reason', () => {
    const stray = found.filter(({ file, line }) => !TEXT.test(line) && !(LINES[file] ?? []).some(([part]) => line.includes(part)) && !/^(\/\/|\*|\/\*)/.test(line));
    expect(stray).toEqual([]);
  });

  it('the list does not rot: every allowed file and line is still there', () => {
    for (const file of Object.keys(FILES)) expect(() => statSync(join(SRC, file)), file).not.toThrow();
    for (const [file, parts] of Object.entries(LINES)) for (const [part] of parts) expect(found.some((f) => f.file === file && f.line.includes(part)), `${file}: ${part}`).toBe(true);
  });
});

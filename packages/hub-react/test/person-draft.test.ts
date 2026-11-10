import { describe, expect, it } from 'vitest';
import { GAP_NOTE_MAX, REASON_MAX } from '../src/decision.js';
import { durationChoices, emptySanction, sanctionProblems, toSanctionInput } from '../src/person/sanctionDraft.js';
import type { SanctionContext, SanctionDraft } from '../src/person/sanctionDraft.js';

// The direct-sanction form as plain data: what it holds, what it refuses before sending, and the body it sends. It reuses the
// decision form's checks, so a rule cannot be accepted here that a decision would refuse.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CTX: SanctionContext = { rules: [1, 2, 3], canApply: true, canPermanent: false };
const SUBJECT = 'p-subject';

const draft = (over: Partial<SanctionDraft> = {}): SanctionDraft => ({ ...emptySanction('sanction'), kind: 'chat', rule: '2', reason: 'spam in the lobby', ...over });
const problems = (d: SanctionDraft, mode: 'sanction' | 'note' = 'sanction', ctx: SanctionContext = CTX) => sanctionProblems(d, mode, ctx);

describe('emptySanction', () => {
  it('a sanction starts with nothing chosen (no default that could be sent by accident), 24 hours ready, no IP', () => {
    expect(emptySanction('sanction')).toEqual({ kind: '', duration: '24h', rule: '', gapNote: '', reason: '', includeIp: false });
  });
  it('a note is a note from the start', () => {
    expect(emptySanction('note')).toEqual({ kind: 'note', duration: '24h', rule: '', gapNote: '', reason: '', includeIp: false });
  });
});

describe('durationChoices', () => {
  it('a restriction offers 1 hour to permanent when the role may make it permanent', () => {
    expect(durationChoices('chat', true)).toEqual(['1h', '24h', '7d', '30d', 'permanent']);
    expect(durationChoices('area', false)).toEqual(['1h', '24h', '7d', '30d', 'permanent']);
  });
  it('only a ban needs the permanent permission: without it a ban stops at 30 days', () => {
    expect(durationChoices('ban', false)).toEqual(['1h', '24h', '7d', '30d']);
    expect(durationChoices('ban', true)).toEqual(['1h', '24h', '7d', '30d', 'permanent']);
  });
  it('a warning, a note and nothing chosen have no length', () => {
    expect(durationChoices('warning', true)).toEqual([]);
    expect(durationChoices('note', true)).toEqual([]);
    expect(durationChoices('', true)).toEqual([]);
  });
});

describe('sanctionProblems', () => {
  it('a complete draft has none', () => {
    expect(problems(draft())).toEqual({ count: 0 });
  });

  it('an empty sanction needs what happens, a rule and a reason, and counts three', () => {
    const p = problems(emptySanction('sanction'));
    expect(p.kind?.key).toBe('hub.decide.error.whatRequired');
    expect(p.rule?.key).toBe('hub.decide.error.ruleRequired');
    expect(p.reason?.key).toBe('hub.decide.error.reasonRequired');
    expect(p.count).toBe(3);
  });

  it('a reason of only spaces is no reason', () => {
    expect(problems(draft({ reason: '   \n ' })).reason?.key).toBe('hub.decide.error.reasonRequired');
  });

  it('a reason over the limit is refused, one at the limit is not (control)', () => {
    expect(problems(draft({ reason: 'x'.repeat(REASON_MAX) })).count).toBe(0);
    const long = problems(draft({ reason: 'x'.repeat(REASON_MAX + 1) }));
    expect(long.reason).toEqual({ key: 'hub.decide.error.reasonLong', params: { max: REASON_MAX } });
  });

  it('a rule that is not in force is refused, one that is, is not', () => {
    expect(problems(draft({ rule: '9' })).rule?.key).toBe('hub.decide.error.ruleUnknown');
    expect(problems(draft({ rule: '3' })).rule).toBeUndefined();
  });

  it('"no rule covers this" needs a gap note, and a gap note over the limit is refused', () => {
    expect(problems(draft({ rule: 'uncovered' })).gapNote?.key).toBe('hub.decide.error.gapRequired');
    expect(problems(draft({ rule: 'uncovered', gapNote: '  ' })).gapNote?.key).toBe('hub.decide.error.gapRequired');
    expect(problems(draft({ rule: 'uncovered', gapNote: 'a hole in the rules' })).count).toBe(0);
    expect(problems(draft({ rule: 'uncovered', gapNote: 'x'.repeat(GAP_NOTE_MAX + 1) })).gapNote?.key).toBe('hub.decide.error.gapLong');
  });

  it('a gap note left over from "no rule covers this" is not checked once a numbered rule is chosen', () => {
    expect(problems(draft({ rule: '2', gapNote: 'x'.repeat(GAP_NOTE_MAX + 50) })).count).toBe(0);
  });

  it('a permanent ban needs the permission, a permanent chat restriction does not', () => {
    expect(problems(draft({ kind: 'ban', duration: 'permanent' })).kind?.key).toBe('hub.decide.error.permanent');
    expect(problems(draft({ kind: 'ban', duration: 'permanent' }), 'sanction', { ...CTX, canPermanent: true }).count).toBe(0);
    expect(problems(draft({ kind: 'chat', duration: 'permanent' })).count).toBe(0);
  });

  it('a duration left over from a timed kind does not matter for a warning', () => {
    expect(problems(draft({ kind: 'warning', duration: 'permanent' })).count).toBe(0);
  });

  it('a role that cannot apply sanctions has a problem whatever it fills in', () => {
    expect(problems(draft(), 'sanction', { ...CTX, canApply: false }).list?.key).toBe('hub.decide.error.cannotApply');
  });

  describe('a note', () => {
    it('needs a rule and the note, and says "note" rather than "reason"', () => {
      const p = problems(emptySanction('note'), 'note');
      expect(p.kind).toBeUndefined();
      expect(p.rule?.key).toBe('hub.decide.error.ruleRequired');
      expect(p.reason?.key).toBe('hub.person.note.error.required');
      expect(p.count).toBe(2);
    });
    it('a note over the limit is refused with a note wording', () => {
      const p = problems({ ...emptySanction('note'), rule: '1', reason: 'x'.repeat(REASON_MAX + 1) }, 'note');
      expect(p.reason?.key).toBe('hub.person.note.error.long');
    });
    it('a complete note has none, and needs no permission beyond applying', () => {
      expect(problems({ ...emptySanction('note'), rule: 'uncovered', gapNote: 'unclear', reason: 'watching this one' }, 'note').count).toBe(0);
    });
  });
});

describe('toSanctionInput', () => {
  it('a timed restriction: the length in milliseconds, the rule as a number, the reason trimmed, and the IP choice as given', () => {
    expect(toSanctionInput(SUBJECT, draft({ kind: 'chat', duration: '24h', reason: '  spam in the lobby  ', includeIp: true }), 'sanction')).toEqual({
      subject: SUBJECT,
      kind: 'chat',
      durationMs: DAY,
      rule: 2,
      reason: 'spam in the lobby',
      includeIp: true,
    });
  });

  it.each([
    ['1h', HOUR],
    ['24h', DAY],
    ['7d', 7 * DAY],
    ['30d', 30 * DAY],
    ['permanent', null],
  ] as const)('the length %s is sent as %s', (duration, ms) => {
    expect(toSanctionInput(SUBJECT, draft({ kind: 'area', duration }), 'sanction').durationMs).toBe(ms);
  });

  it('a warning has no length and never asks for the IP, even if the box was ticked before the kind changed', () => {
    const input = toSanctionInput(SUBJECT, draft({ kind: 'warning', duration: '7d', includeIp: true }), 'sanction');
    expect(input).toMatchObject({ kind: 'warning', durationMs: null, includeIp: false });
  });

  it('"no rule covers this" sends the word and the trimmed gap note; a numbered rule sends no gap note', () => {
    expect(toSanctionInput(SUBJECT, draft({ rule: 'uncovered', gapNote: '  hole  ' }), 'sanction')).toMatchObject({ rule: 'uncovered', gapNote: 'hole' });
    expect('gapNote' in toSanctionInput(SUBJECT, draft({ rule: '1', gapNote: 'old text' }), 'sanction')).toBe(false);
  });

  it('a note is a note-kind sanction with no length and no IP, and the note is the reason', () => {
    expect(toSanctionInput(SUBJECT, { ...emptySanction('note'), rule: '3', reason: ' watch for repeats ', includeIp: true }, 'note')).toEqual({
      subject: SUBJECT,
      kind: 'note',
      durationMs: null,
      rule: 3,
      reason: 'watch for repeats',
      includeIp: false,
    });
  });

  it('takeOver is added only when asked for', () => {
    expect('takeOver' in toSanctionInput(SUBJECT, draft(), 'sanction')).toBe(false);
    expect(toSanctionInput(SUBJECT, draft(), 'sanction', { takeOver: true }).takeOver).toBe(true);
  });
});

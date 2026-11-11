import { describe, expect, it } from 'vitest';
import { emptyForm, newDraft, resolveDraft, toInput, validate } from '../../src/decision.js';
import type { Draft, ValidationContext } from '../../src/decision.js';
import { durationChoices, emptySanction, sanctionProblems, toSanctionInput } from '../../src/person/sanctionDraft.js';

// The decision form and the sanction form take their lengths from the profile: its `durations`, "Custom length" when the profile
// allows it, and permanent. These are the pure rules; the pages are tested in pickers.test.tsx.

const H = 3_600_000;
const D = 24 * H;
const CTX: ValidationContext = { target: 'T', people: ['T', 'R'], rules: [1, 2], canApply: true, canPermanent: true, ownLineIds: {} };
const other = (patch: Partial<Draft>): Draft => ({ ...newDraft('a', 'T', 1), what: 'other', customKind: 'chat', ...patch });
const form = (d: Draft) => ({ ...emptyForm(), verdict: 'fair' as const, reason: 'why', actions: [d] });

describe('a draft with a length from the profile', () => {
  it('a listed length, as milliseconds text', () => {
    expect(resolveDraft(other({ customDuration: String(6 * H) }))).toEqual({ kind: 'chat', durationMs: 6 * H });
    expect(resolveDraft(other({ customKind: 'ban', customDuration: String(3 * D) }))).toEqual({ kind: 'ban', durationMs: 3 * D });
  });
  it('a custom length is the number and the unit', () => {
    expect(resolveDraft(other({ customDuration: 'custom', customAmount: '5', customUnit: 'hours' }))).toEqual({ kind: 'chat', durationMs: 5 * H });
    expect(resolveDraft(other({ customDuration: 'custom', customAmount: '2', customUnit: 'days' }))).toEqual({ kind: 'chat', durationMs: 2 * D });
  });
  it('a custom length that is not valid yet resolves to nothing (so it can never be sent as permanent)', () => {
    for (const customAmount of ['', 'x', '0', '999']) {
      expect(resolveDraft(other({ customDuration: 'custom', customAmount, customUnit: 'days' })), customAmount).toBeNull();
    }
    expect(resolveDraft(other({ customDuration: 'custom' }))).toBeNull();
  });
  it('the old keys still read (a draft made before the profile came in)', () => {
    expect(resolveDraft(other({ customDuration: '24h' }))).toEqual({ kind: 'chat', durationMs: D });
    expect(resolveDraft(other({ customDuration: 'permanent' }))).toEqual({ kind: 'chat', durationMs: null });
  });
  it('a warning or note has no length, whatever the field holds', () => {
    expect(resolveDraft(other({ customKind: 'warning', customDuration: 'custom', customAmount: '' }))).toEqual({ kind: 'warning', durationMs: null });
  });
  it('is sent with that length', () => {
    const input = toInput(form(other({ customDuration: 'custom', customAmount: '36', customUnit: 'hours', rule: '1' })));
    expect(input.actions[0]).toMatchObject({ kind: 'chat', durationMs: 36 * H });
  });
});

describe('validate: a custom length', () => {
  const problemsFor = (d: Draft) => validate(form(d), CTX).actions.a;
  it('a good one has no problem', () => {
    expect(problemsFor(other({ rule: '1', customDuration: 'custom', customAmount: '5', customUnit: 'hours' }))).toBeUndefined();
  });
  it.each<[string, 'hours' | 'days', string]>([
    ['', 'hours', 'hub.length.error.empty'],
    ['abc', 'hours', 'hub.length.error.number'],
    ['0', 'hours', 'hub.length.error.short'],
    ['400', 'days', 'hub.length.error.long'],
    ['1.00001', 'hours', 'hub.length.error.whole'],
  ])('%j %s is refused on the length field: %s', (customAmount, customUnit, key) => {
    const found = problemsFor(other({ rule: '1', customDuration: 'custom', customAmount, customUnit }));
    expect(found?.length?.key).toBe(key);
    expect(found?.what).toBeUndefined();
  });
  it('counts as a problem, so the decision cannot be sent', () => {
    expect(validate(form(other({ rule: '1', customDuration: 'custom', customAmount: '' })), CTX).count).toBe(1);
  });
  it('permanent still needs the permission for a ban only', () => {
    const noPerm = { ...CTX, canPermanent: false };
    expect(validate(form(other({ rule: '1', customKind: 'ban', customDuration: 'permanent' })), noPerm).actions.a?.what?.key).toBe('hub.decide.error.permanent');
    expect(validate(form(other({ rule: '1', customKind: 'chat', customDuration: 'permanent' })), noPerm).actions.a).toBeUndefined();
  });
});

describe('durationChoices for the sanction form', () => {
  it('without a profile it is the old list', () => {
    expect(durationChoices('chat', true)).toEqual(['1h', '24h', '7d', '30d', 'permanent']);
  });
  it('with a profile it is its durations, permanent, and custom when allowed', () => {
    const lengths = { durations: [H, 6 * H, 12 * H], custom: true };
    expect(durationChoices('chat', true, lengths)).toEqual(['1h', String(6 * H), String(12 * H), 'permanent', 'custom']);
    expect(durationChoices('area', false, lengths)).toEqual(['1h', String(6 * H), String(12 * H), 'permanent', 'custom']);
  });
  it('custom is left out when the profile turns it off, and a ban without the permission has no permanent', () => {
    const lengths = { durations: [H, D], custom: false };
    expect(durationChoices('ban', false, lengths)).toEqual(['1h', '24h']);
    expect(durationChoices('ban', true, lengths)).toEqual(['1h', '24h', 'permanent']);
  });
  it('a warning, a note and nothing chosen have no length', () => {
    const lengths = { durations: [H], custom: true };
    expect(durationChoices('warning', true, lengths)).toEqual([]);
    expect(durationChoices('note', true, lengths)).toEqual([]);
    expect(durationChoices('', true, lengths)).toEqual([]);
  });
});

describe('the sanction form with a profile length', () => {
  const ctx = { rules: [1], canApply: true, canPermanent: true };
  const draft = (patch: object) => ({ ...emptySanction('sanction'), kind: 'chat' as const, rule: '1', reason: 'because', ...patch });
  it('sends a listed length and a custom one', () => {
    expect(toSanctionInput('s', draft({ duration: String(6 * H) }), 'sanction').durationMs).toBe(6 * H);
    expect(toSanctionInput('s', draft({ duration: 'custom', customAmount: '3', customUnit: 'days' }), 'sanction').durationMs).toBe(3 * D);
  });
  it('a custom length with a bad number is a problem on the length', () => {
    const p = sanctionProblems(draft({ duration: 'custom', customAmount: '0', customUnit: 'hours' }), 'sanction', ctx);
    expect(p.length?.key).toBe('hub.length.error.short');
    expect(p.count).toBe(1);
  });
  it('a warning ignores a bad custom length', () => {
    expect(sanctionProblems(draft({ kind: 'warning', duration: 'custom', customAmount: '' }), 'sanction', ctx).count).toBe(0);
  });
  it('the untouched draft is as before (no new keys)', () => {
    expect(emptySanction('sanction')).toEqual({ kind: '', duration: '24h', rule: '', gapNote: '', reason: '', includeIp: false });
  });
});

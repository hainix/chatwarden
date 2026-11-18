import { describe, expect, it } from 'vitest';
import { suggest } from '../src/ladder.js';
import type { ActionRecord } from '../src/ladder.js';
import { PRESETS, resolveProfile } from '../src/profile.js';
import type { SanctionKind } from '../src/types.js';

// The ladder follows the evidence kind (0.2.2, audit S1, P12): nouns, the default level, the area swap and the rename step.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const warned: ActionRecord = { kind: 'warning' as SanctionKind, durationMs: 0, startsAt: NOW - DAY, revoked: false, automated: false, roomId: null };
const CHATWORDS = /hostile|aggressive|banter|message|chat|insult/i;
const RELAXED = PRESETS.relaxed;
const STANDARD = PRESETS.standard;
const kindOf = (o: ReturnType<typeof suggest>['outcome']): string => (typeof o === 'string' ? o : o.kind);

describe('S1: a play report with no level and a clean record', () => {
  it('relaxed + afk: no hostile conduct, no chat word, says gameplay', () => {
    const s = suggest(RELAXED, [], null, 6, NOW, { evidence: 'play' });
    expect(s.why).not.toMatch(CHATWORDS);
    expect(s.why).toMatch(/gameplay conduct/);
    expect(s.why).toContain('first gameplay conduct with a clean record');
  });
  it('a null level reads as rude for play, not hostile: relaxed notes it, standard warns it', () => {
    expect(suggest(RELAXED, [], null, 6, NOW, { evidence: 'play' }).outcome).toBe('note');
    expect(suggest(STANDARD, [], null, 6, NOW, { evidence: 'play' }).outcome).toBe('warning');
  });
  it('chat (and no kind) still reads a null level as hostile, with the same words as before', () => {
    const before = suggest(RELAXED, [], null, 2, NOW);
    expect(before.why).toBe('Relaxed profile: first hostile conduct with a clean record gets a warning.');
    expect(suggest(RELAXED, [], null, 2, NOW, { evidence: 'chat' })).toEqual(before);
  });
  it('an explicit level is honoured for play, with play nouns', () => {
    const s = suggest(STANDARD, [], 'severe', 6, NOW, { evidence: 'play' });
    expect(s.why).not.toMatch(/hostile|aggressive|banter|message|insult/i);
    expect(kindOf(s.outcome)).toBe('area');
  });
  it('banter on a play report: not moderated, no chat word', () => {
    const s = suggest(RELAXED, [], 'banter', 6, NOW, { evidence: 'play' });
    expect(s.outcome).toBe('none');
    expect(s.why).not.toMatch(/banter|message|chat/i);
    expect(s.why).toMatch(/not moderated/);
  });
  it('rude on a play report names gameplay conduct, never "aggressive message"', () => {
    const s = suggest(STANDARD, [], 'rude', 6, NOW, { evidence: 'play' });
    expect(s.why).not.toMatch(/aggressive message/);
    expect(s.why).toMatch(/gameplay conduct/);
  });
});

describe('P12: the swap follows the evidence kind', () => {
  it('play evidence under a custom rule (CR 2) is a ban from public rooms, not "Restrict chat"', () => {
    const s = suggest(STANDARD, [], 'hostile', 2, NOW, { evidence: 'play' });
    expect(kindOf(s.outcome)).toBe('area');
    expect(s.label).not.toMatch(/chat/i);
  });
  it('a record step with a warning: play stays out of chat', () => {
    const s = suggest(STANDARD, [warned], 'rude', 12, NOW, { evidence: 'play' });
    expect(kindOf(s.outcome)).toBe('area');
  });
  it('name evidence never suggests a chat restriction either', () => {
    for (const level of ['rude', 'hostile', 'severe'] as const) {
      expect(kindOf(suggest(STANDARD, [warned], level, 7, NOW, { evidence: 'name' }).outcome), level).not.toBe('chat');
      expect(kindOf(suggest(STANDARD, [warned], level, 12, NOW, { evidence: 'name' }).outcome), level).not.toBe('chat');
    }
  });
  it('chat evidence under a chat rule is still a chat restriction (control)', () => {
    expect(kindOf(suggest(STANDARD, [], 'hostile', 2, NOW, { evidence: 'chat' }).outcome)).toBe('chat');
    expect(kindOf(suggest(STANDARD, [], 'hostile', 2, NOW).outcome)).toBe('chat');
  });
  it('no kind falls back to the rule: CR 6 is play and CR 7 is name, as areaRules always made CR 5 and 6', () => {
    expect(kindOf(suggest(STANDARD, [], 'hostile', 6, NOW).outcome)).toBe('area');
    expect(kindOf(suggest(STANDARD, [], 'hostile', 7, NOW).outcome)).not.toBe('chat');
  });
  it('areaRules stays an explicit override: a profile that lists CR 2 swaps chat evidence under it', () => {
    const p = resolveProfile('standard', { areaRules: [2] });
    expect(kindOf(suggest(p, [], 'hostile', 2, NOW, { evidence: 'chat' }).outcome)).toBe('area');
    expect(suggest(p, [], 'hostile', 2, NOW, { evidence: 'chat' }).why).toContain('this rule bans from public rooms instead of restricting chat');
  });
  it('an unknown kind is read as no kind', () => {
    expect(suggest(STANDARD, [], 'hostile', 2, NOW, { evidence: 'moon' as never })).toEqual(suggest(STANDARD, [], 'hostile', 2, NOW));
  });
});

describe('P12: a name suggests a rename first', () => {
  const renames = resolveProfile('relaxed', { names: { renames: true } });
  it('with renames on, a clean-record name is a warning and the words say to ask for a new name first', () => {
    const s = suggest(renames, [], null, 7, NOW, { evidence: 'name' });
    expect(s.outcome).toBe('warning');
    expect(Object.hasOwn(s, 'rename')).toBe(false);
    expect(s.why).toMatch(/offensive name/);
    expect(s.why).toMatch(/new name/);
    expect(s.why).not.toMatch(CHATWORDS);
  });
  it('with renames off the step is the warning', () => {
    const s = suggest(RELAXED, [], null, 7, NOW, { evidence: 'name' });
    expect(s.outcome).toBe('warning');
    expect(Object.hasOwn(s, 'rename')).toBe(false);
    expect(s.why).not.toMatch(CHATWORDS);
  });
  it('play and chat never carry a rename field', () => {
    expect(Object.hasOwn(suggest(renames, [], 'rude', 6, NOW, { evidence: 'play' }), 'rename')).toBe(false);
    expect(Object.hasOwn(suggest(renames, [], 'hostile', 2, NOW, { evidence: 'chat' }), 'rename')).toBe(false);
  });
  it('a name under a record with a warning is not asked to rename again: the ladder step applies, in rooms not chat', () => {
    const s = suggest(renames, [warned], 'hostile', 7, NOW, { evidence: 'name' });
    expect(kindOf(s.outcome)).toBe('area');
    expect(Object.hasOwn(s, 'rename')).toBe(false);
  });
  it('a name with banter level is still not acted on', () => {
    const s = suggest(renames, [], 'banter', 7, NOW, { evidence: 'name' });
    expect(s.outcome).toBe('none');
    expect(Object.hasOwn(s, 'rename')).toBe(false);
  });
});

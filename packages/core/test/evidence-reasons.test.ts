import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_REASONS,
  EVIDENCE_KINDS,
  defaultReporting,
  evidenceKindOf,
  evidenceOfReason,
  evidenceOfRule,
  fillReporting,
  isEvidenceKind,
  legacyCategoryOf,
  playerReporting,
  resolveReporting,
} from '../src/reporting.js';
import { defineProfile, PRESETS, ProfileError } from '../src/profile.js';
import type { ModerationProfile } from '../src/profile.js';

// Evidence kind (0.2.2, audit S11, S10, P10, C3, C4): a report reason says what the evidence is, chat, play or a name. Built-in reasons have defaults,
// a custom reason with none set is neutral, and the kind is checked like the other reason fields.

const byId = (id: string) => DEFAULT_REPORT_REASONS.find((r) => r.id === id);
const withReasons = (reasons: unknown[]): ModerationProfile => ({ ...PRESETS.standard, reporting: { reasons } }) as unknown as ModerationProfile;
const other = { id: 'other', label: 'Something else' };
const failure = (fn: () => unknown): ProfileError => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError');
};

describe('the kinds', () => {
  it('there are three, in this order, and isEvidenceKind knows exactly them', () => {
    expect(EVIDENCE_KINDS).toEqual(['chat', 'play', 'name']);
    for (const k of EVIDENCE_KINDS) expect(isEvidenceKind(k)).toBe(true);
    for (const v of ['', 'Chat', 'gameplay', null, undefined, 3, {}]) expect(isEvidenceKind(v)).toBe(false);
  });
});

describe('default reasons (S11)', () => {
  it.each(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'impersonation', 'welfare'])('%s is chat evidence', (id) => {
    expect(byId(id)?.evidence).toBe('chat');
  });
  it.each(['cheating', 'griefing', 'afk'])('%s is play evidence', (id) => {
    expect(byId(id)?.evidence).toBe('play');
  });
  it('name is name evidence', () => {
    expect(byId('name')?.evidence).toBe('name');
  });
  it('other has no kind: it is neutral', () => {
    expect(byId('other')).toBeDefined();
    expect(byId('other')?.evidence ?? null).toBeNull();
    expect(evidenceOfReason(defaultReporting().reasons, 'other')).toBeUndefined();
  });
  it('a fresh default copy carries the kinds and stays valid', () => {
    const copy = defaultReporting();
    expect(copy.reasons.find((r) => r.id === 'afk')?.evidence).toBe('play');
    expect(() => defineProfile({ ...PRESETS.standard, reporting: copy })).not.toThrow();
  });
  it('the player never reads the kind: it is staff side', () => {
    for (const r of playerReporting(defaultReporting()).reasons) expect(Object.keys(r)).not.toContain('evidence');
  });
  it('legacy categories are unchanged', () => {
    expect(legacyCategoryOf('afk')).toBe('disruption');
    expect(legacyCategoryOf('name')).toBe('other');
  });
});

describe('validation and resolving', () => {
  it('a custom reason with no kind reads neutral (ruling 1)', () => {
    const p = defineProfile(withReasons([{ id: 'zorbak', label: 'Zorbak' }, other]));
    expect(evidenceOfReason(p.reporting.reasons, 'zorbak')).toBeUndefined();
  });
  it.each(['chat', 'play', 'name'] as const)('a custom reason may say %s and it round-trips', (kind) => {
    const p = defineProfile(withReasons([{ id: 'zorbak', label: 'Zorbak', evidence: kind }, other]));
    expect(p.reporting.reasons[0]?.evidence).toBe(kind);
    expect(defineProfile(p).reporting.reasons[0]).toEqual(p.reporting.reasons[0]);
    expect(evidenceOfReason(p.reporting.reasons, 'zorbak')).toBe(kind);
  });
  it('null is accepted and means no kind, even on a built-in id', () => {
    const p = defineProfile(withReasons([{ id: 'afk', label: 'AFK', evidence: null }, other]));
    expect(evidenceOfReason(p.reporting.reasons, 'afk')).toBeUndefined();
    // Resolving it again does not bring the default back.
    expect(evidenceOfReason(defineProfile(p).reporting.reasons, 'afk')).toBeUndefined();
  });
  it.each(['gameplay', 'Chat', '', 4, true, [], {}])('a kind of %j is refused with the field path', (bad) => {
    const e = failure(() => defineProfile(withReasons([{ id: 'zorbak', label: 'Zorbak', evidence: bad }, other])));
    expect(e.path).toBe('profile.reporting.reasons[0].evidence');
    expect(e.message).not.toContain('Zorbak');
  });
  it('a stored layer that lists a built-in id with no kind gets its default (0.2.1 layers keep working)', () => {
    const filled = fillReporting({ reasons: [{ id: 'afk', label: 'Leaving' }, { id: 'name', label: 'Name' }, { id: 'zorbak', label: 'Z' }, other] }) as { reasons: Array<{ id: string; evidence?: unknown }> };
    expect(filled.reasons.map((r) => r.evidence)).toEqual(['play', 'name', undefined, undefined]);
    expect(Object.hasOwn(filled.reasons[2] as object, 'evidence')).toBe(false);
  });
  it('resolveReporting keeps an explicit kind over the default', () => {
    const r = resolveReporting({ reasons: [{ id: 'afk', label: 'Leaving', evidence: 'chat' }, other] });
    expect(r.reasons[0]?.evidence).toBe('chat');
  });
});

describe('evidenceOfRule: the fallback', () => {
  it('CR 5 and 6 are play, CR 7 is name, every other rule has no kind', () => {
    expect(evidenceOfRule(5)).toBe('play');
    expect(evidenceOfRule(6)).toBe('play');
    expect(evidenceOfRule(7)).toBe('name');
    for (const r of [1, 2, 3, 4, 8, 99, 'uncovered', null, undefined] as const) expect(evidenceOfRule(r)).toBeUndefined();
  });
});

describe('evidenceKindOf: the reason first, then the rule', () => {
  const reasons = resolveReporting({ reasons: [{ id: 'zorbak', label: 'Z' }, { id: 'vlemmo', label: 'V', evidence: 'chat' }, { id: 'afk', label: 'A' }, other] }).reasons;
  it('the reason wins over the rule', () => {
    expect(evidenceKindOf(reasons, 'vlemmo', 6)).toBe('chat');
    expect(evidenceKindOf(reasons, 'afk', 2)).toBe('play');
  });
  it('a reason with no kind falls back to the rule, and to nothing when the rule says nothing', () => {
    expect(evidenceKindOf(reasons, 'zorbak', 6)).toBe('play');
    expect(evidenceKindOf(reasons, 'zorbak', 7)).toBe('name');
    expect(evidenceKindOf(reasons, 'zorbak', 2)).toBeUndefined();
    expect(evidenceKindOf(reasons, 'other', 2)).toBeUndefined();
  });
  it('no reason, an unknown reason and a legacy alias', () => {
    expect(evidenceKindOf(reasons, null, 6)).toBe('play');
    expect(evidenceKindOf(reasons, null, 2)).toBeUndefined();
    expect(evidenceKindOf(reasons, 'no_such', 7)).toBe('name');
    expect(evidenceKindOf(defaultReporting().reasons, 'disruption', 2)).toBe('play');
  });
  it('no rule given: the reason alone', () => {
    expect(evidenceKindOf(reasons, 'vlemmo')).toBe('chat');
    expect(evidenceKindOf(reasons, 'zorbak')).toBeUndefined();
  });
});

describe('report picker groups and hints (P10, C4)', () => {
  it('name, impersonation and welfare are not filed under the Chat group', () => {
    for (const id of ['name', 'impersonation', 'welfare']) expect(byId(id)?.group, id).not.toBe('Chat');
    expect(byId('name')?.group).toBe('Players');
    expect(DEFAULT_REPORT_REASONS.filter((r) => r.group === 'Chat').map((r) => r.id)).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info']);
    expect(DEFAULT_REPORT_REASONS.filter((r) => r.group === 'Gameplay').map((r) => r.id)).toEqual(['cheating', 'griefing', 'afk']);
  });
  it('the spam hint covers invites and ads, not only messages', () => {
    expect(byId('spam')?.hint).toBe('Repeated messages, invites or ads');
  });
});

import { describe, expect, it } from 'vitest';
import { APPEAL_WORDS } from '@chatwarden/core/notice-locales';
import { defaultReporting } from '@chatwarden/core';
import type { ReportingSettings } from '@chatwarden/core';
import { defaultLines, emptyForm, initialForm, levelKey, newDraft, toInput, withSuggestion } from '../src/decision.js';
import type { DecisionForm, Draft, ValidationContext } from '../src/decision.js';
import { en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { decideOp } from '../src/preview/ops.js';
import { reportingDirty, reportingDraftOf, reportingLayer } from '../src/policy/reporting.js';

// Evidence kind in the hub model (0.2.2, audit P3, S2, S3, P5, C2): no chat line is attached unless the evidence is chat, the decision body drops lines a
// report about play or a name cannot carry, the level picker and the ladder hints read neutral, and the reasons editor carries the kind.

const T = 'target-ref-000000';
const ctx = (over: Partial<ValidationContext> = {}): ValidationContext => ({
  target: T,
  people: [T],
  rules: [1, 2, 3, 4, 5, 6, 7],
  canApply: true,
  canPermanent: false,
  ownLineIds: { [T]: ['t1', 't2', 't3'] },
  ...over,
});
const warning = { kind: 'warning', durationMs: null } as never;

describe('defaultLines follows the evidence kind (P3)', () => {
  it('chat: as always, up to five, the pointed line kept', () => {
    expect(defaultLines(['a', 'b'], 'b', 'chat')).toEqual(['a', 'b']);
    expect(defaultLines(['1', '2', '3', '4', '5', '6', '7'], '1', 'chat')).toEqual(['1', '4', '5', '6', '7']);
  });
  it.each(['play', 'name'] as const)('%s: none, even with a pointed line of their own', (kind) => {
    expect(defaultLines(['a', 'b', 'c'], null, kind)).toEqual([]);
    expect(defaultLines(['a', 'b', 'c'], 'b', kind)).toEqual([]);
  });
  it('no kind (neutral): none, except a line that was pointed at and is theirs', () => {
    expect(defaultLines(['a', 'b', 'c'], null)).toEqual([]);
    expect(defaultLines(['a', 'b', 'c'], 'b')).toEqual(['b']);
    expect(defaultLines(['a', 'b', 'c'], 'zzz')).toEqual([]);
    expect(defaultLines([], 'b')).toEqual([]);
  });
});

describe('initialForm and withSuggestion by kind', () => {
  const lines = (f: DecisionForm): string[] => f.actions[0]?.lineIds ?? ['<no action>'];
  it('chat pre-attaches their latest lines; play and name pre-attach none', () => {
    expect(lines(initialForm(ctx({ evidence: 'chat' }), warning, 2, 't2', 'a1'))).toEqual(['t1', 't2', 't3']);
    expect(lines(initialForm(ctx({ evidence: 'play' }), warning, 6, 't2', 'a1'))).toEqual([]);
    expect(lines(initialForm(ctx({ evidence: 'name' }), warning, 7, 't2', 'a1'))).toEqual([]);
  });
  it('the Moxgate repro: an AFK warning has no lines though the target said "Hello"', () => {
    const f = initialForm(ctx({ evidence: 'play', ownLineIds: { [T]: ['hello'] } }), warning, 6, 'hello', 'a1');
    expect(f.actions).toHaveLength(1);
    expect(f.actions[0]?.lineIds).toEqual([]);
    expect(toInput({ ...f, verdict: 'fair', reason: 'AFK' }, 'play').actions[0]).not.toHaveProperty('lineIds');
  });
  it('neutral: only the pointed line', () => {
    expect(lines(initialForm(ctx(), warning, 2, 't2', 'a1'))).toEqual(['t2']);
    expect(lines(initialForm(ctx(), warning, 2, null, 'a1'))).toEqual([]);
  });
  it('a suggestion added later takes the lines it is given (the quick actions and "Add this action")', () => {
    const f = withSuggestion(emptyForm(), ctx({ evidence: 'play' }), 'warning', 6, 'a1', defaultLines(['t1'], null, 'play'));
    expect(f?.actions[0]?.lineIds).toEqual([]);
  });
});

describe('toInput never sends a chat line the server will refuse', () => {
  const withLines = (rule: number): DecisionForm => ({
    ...emptyForm(),
    verdict: 'fair',
    reason: 'because',
    actions: [{ ...newDraft('a1', T, rule), what: 'warning:null', lineIds: ['t1', 't2'] }],
  });
  it('chat keeps them', () => {
    expect(toInput(withLines(2), 'chat').actions[0]?.lineIds).toEqual(['t1', 't2']);
  });
  it.each(['play', 'name'] as const)('%s drops them', (kind) => {
    expect(toInput(withLines(2), kind).actions[0]).not.toHaveProperty('lineIds');
  });
  it('no kind: the rule decides, as the server does (CR 5, 6 play, CR 7 name; CR 2 keeps)', () => {
    expect(toInput(withLines(6)).actions[0]).not.toHaveProperty('lineIds');
    expect(toInput(withLines(7)).actions[0]).not.toHaveProperty('lineIds');
    expect(toInput(withLines(2)).actions[0]?.lineIds).toEqual(['t1', 't2']);
  });
  it('a reason that says chat wins over the rule (a chat report under CR 6 keeps its lines)', () => {
    expect(toInput(withLines(6), 'chat').actions[0]?.lineIds).toEqual(['t1', 't2']);
  });
  it('the moderator override: evidenceKind chat is sent and keeps the lines on an AFK report', () => {
    const f: DecisionForm = { ...withLines(6), evidenceKind: 'chat' };
    const input = toInput(f, 'play');
    expect(input.evidenceKind).toBe('chat');
    expect(input.actions[0]?.lineIds).toEqual(['t1', 't2']);
  });
  it('no override: no evidenceKind key at all', () => {
    expect(toInput(withLines(2), 'chat')).not.toHaveProperty('evidenceKind');
    expect(emptyForm()).not.toHaveProperty('evidenceKind');
  });
  it('a note never carries lines (as before)', () => {
    const f = withLines(2);
    f.actions[0] = { ...(f.actions[0] as Draft), what: 'note:null' };
    expect(toInput(f, 'chat').actions[0]).not.toHaveProperty('lineIds');
  });
});

describe('the severity picker reads per kind (S2)', () => {
  it('chat keeps the four words', () => {
    expect(levelKey('banter', 'chat')).toBe('hub.decide.suggest.level.banter');
    expect(levelKey('severe', undefined)).toBe('hub.decide.suggest.level.severe');
  });
  it('play and name have their own words, in all three languages', () => {
    for (const kind of ['play', 'name'] as const) {
      for (const level of ['banter', 'rude', 'hostile', 'severe'] as const) {
        const key = levelKey(level, kind);
        expect(key).toBe(`hub.decide.suggest.level.${kind}.${level}`);
        for (const [name, cat] of [['en', en], ['es', es], ['pt', pt]] as const) expect((cat as Record<string, string>)[key], `${name} ${key}`).toBeTruthy();
      }
    }
    expect(en['hub.decide.suggest.level.play.banter']).toBe('Minor');
    expect(en['hub.decide.suggest.level.play.rude']).toBe('Once');
    expect(en['hub.decide.suggest.level.play.hostile']).toBe('Deliberate or repeated');
    expect(en['hub.decide.suggest.level.name.rude']).toBe('Offensive');
    for (const k of ['play', 'name']) expect(en[`hub.decide.suggest.level.hint.${k}` as keyof typeof en]).toMatch(/\S/);
  });
  it('none of the play or name words is a chat word', () => {
    for (const [k, v] of Object.entries(en)) if (/^hub\.decide\.suggest\.level\.(play|name)\./.test(k)) expect(v, k).not.toMatch(/rude|hostile|banter|message|chat|insult/i);
  });
});

describe('the ladder hints read neutral (S3)', () => {
  it('the guide says low or medium is minor or isolated and high is serious or repeated, with the chat examples as examples', () => {
    const hint = en['hub.guide.ladder.hint'];
    expect(hint).toMatch(/minor or isolated/);
    expect(hint).toMatch(/serious or repeated/);
    expect(hint).toMatch(/banter|rude/);
    expect(hint.indexOf('minor or isolated')).toBeLessThan(hint.indexOf('banter'));
  });
});

describe('the words of an appeal reason are the core words (P5, C2)', () => {
  it.each([
    ['uphold', 'rule_applies', 'upheld'],
    ['uphold', 'evidence_clear', 'upheld'],
    ['uphold', 'context_considered', 'upheld'],
    ['reduce', 'context_considered', 'reduced'],
    ['revoke', 'not_a_violation', 'revoked'],
    ['revoke', 'context_considered', 'revoked'],
  ] as const)('%s %s says what the player is told', (outcome, code, status) => {
    expect(en[`hub.appeals.reasonCode.${outcome}.${code}` as keyof typeof en]).toBe(APPEAL_WORDS[`player.appeal.reason.${status}.${code}` as keyof typeof APPEAL_WORDS]);
  });
  it('no hub reason word says "what was said", "the chat record" or "the whole conversation"', () => {
    for (const [k, v] of Object.entries(en)) if (k.startsWith('hub.appeals.reasonCode.')) expect(v, k).not.toMatch(/what was said|chat record|whole conversation/i);
  });
  it('the appeal "what they were shown" words still say that no lines were kept (C2)', () => {
    expect(en['hub.appeals.shown.none']).toBe('No lines were kept with the notice.');
  });
});

describe('the reasons editor carries the kind (S11)', () => {
  const defaults = defaultReporting();
  it('a draft holds each reason kind, and none as the empty string', () => {
    const d = reportingDraftOf(defaults);
    expect(d.reasons.find((r) => r.id === 'afk')?.evidence).toBe('play');
    expect(d.reasons.find((r) => r.id === 'name')?.evidence).toBe('name');
    expect(d.reasons.find((r) => r.id === 'harassment')?.evidence).toBe('chat');
    expect(d.reasons.find((r) => r.id === 'other')?.evidence).toBe('');
  });
  it('an unchanged draft is not dirty and sends no layer', () => {
    const d = reportingDraftOf(defaults);
    expect(reportingDirty(d, defaults)).toBe(false);
    expect(reportingLayer(d, defaults)).toBeNull();
  });
  it('changing a kind is a change and the list goes out whole with the kind (null for none)', () => {
    const d = reportingDraftOf(defaults);
    const reasons = d.reasons.map((r) => (r.id === 'afk' ? { ...r, evidence: 'chat' as const } : r.id === 'hate' ? { ...r, evidence: '' as const } : r));
    const changed = { ...d, reasons };
    expect(reportingDirty(changed, defaults)).toBe(true);
    const layer = reportingLayer(changed, defaults) as ReportingSettings;
    const byId = Object.fromEntries((layer.reasons ?? []).map((r) => [r.id, r]));
    expect(byId['afk']?.evidence).toBe('chat');
    expect(byId['hate']?.evidence).toBeNull();
    expect(byId['name']?.evidence).toBe('name');
    expect(byId['other']?.evidence).toBeNull();
  });
});

describe('review R2 I2: "chat" is the decision\u2019s word only when a line goes with it', () => {
  const base = (lineIds: string[], what = 'warning:null'): DecisionForm => ({
    ...emptyForm(),
    verdict: 'fair',
    reason: 'because',
    evidenceKind: 'chat',
    actions: [{ ...newDraft('a1', T, 6), what, lineIds }],
  });
  const o = { target: T, reporter: 'R', lineOf: (id: string) => ({ text: `line ${id}`, day: '2027-01-15' }), order: ['t1', 't2'] };
  it('Add a line and none chosen: no evidenceKind is sent', () => {
    const input = toInput(base([]), 'play');
    expect(input).not.toHaveProperty('evidenceKind');
    expect(input.actions[0]).not.toHaveProperty('lineIds');
  });
  it('Add a line and one chosen: chat and the line are sent', () => {
    const input = toInput(base(['t1']), 'play');
    expect(input.evidenceKind).toBe('chat');
    expect(input.actions[0]?.lineIds).toEqual(['t1']);
  });
  it('a line only on a note does not count (a note carries none)', () => {
    expect(toInput(base(['t1'], 'note:null'), 'play')).not.toHaveProperty('evidenceKind');
  });
  it('two actions, a line on the second: chat is sent', () => {
    const f = base([]);
    f.actions = [...f.actions, { ...newDraft('a2', T, 6), what: 'warning:null', lineIds: ['t2'] }];
    expect(toInput(f, 'play').evidenceKind).toBe('chat');
  });
  it('the preview follows: no kind with no line, chat with one', () => {
    expect(decideOp(base([]), { ...o, evidence: 'play' })).toMatchObject({ evidenceKind: 'play' });
    expect(decideOp(base(['t1']), { ...o, evidence: 'play' })).toMatchObject({ evidenceKind: 'chat' });
    expect(decideOp(base([]), o)).toMatchObject({ evidenceKind: 'play' });
  });
  it('a chat report is as it was: no override, the lines go', () => {
    const f: DecisionForm = { ...base(['t1']) };
    delete f.evidenceKind;
    const input = toInput(f, 'chat');
    expect(input).not.toHaveProperty('evidenceKind');
    expect(input.actions[0]?.lineIds).toEqual(['t1']);
  });
});

describe('review R2 M5: the level hint for a report about play gives examples of each level', () => {
  const play = en['hub.decide.suggest.level.hint.play'];
  it('english names a gameplay example for each level', () => {
    expect(play).toMatch(/slow turn|short pause/);
    expect(play).toMatch(/leaving a match once/);
    expect(play).toMatch(/stalling|leaving match after match/);
    expect(play).toMatch(/cheat|exploit/);
  });
  it.each([
    ['es', es],
    ['pt', pt],
  ] as const)('%s has the same key with the longer text, not the old short one', (_name, cat) => {
    const text = (cat as Record<string, string>)['hub.decide.suggest.level.hint.play'] ?? '';
    expect(text.length).toBeGreaterThan(play.length * 0.7);
    expect(text).not.toBe(play);
  });
  it('every example is a play example, not a chat insult', () => {
    expect(play).not.toMatch(/insult|slur/i);
  });
});

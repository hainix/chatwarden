import { describe, expect, it } from 'vitest';
import { AI_ACT_MAX_AGE_MS, capsOk, dueAt, evaluateChecks, isHeldBack, preFilter } from '../../src/ai/actPlan.js';
import type { ActFacts, CapUse } from '../../src/ai/actPlan.js';
import { AI_ACT_CAPS_DEFAULTS } from '../../src/ai/caps.js';
import { sha256Hex } from '../../src/crypto.js';

// The act planner (design 4.1, 4.2, ruling 7 and 10): pure. Every refusal code has its own test, paired with a control that passes without that one fault, and the order of the
// table is the order of the codes.

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const CAPS = AI_ACT_CAPS_DEFAULTS;
const OK_USE: CapUse = { hour: 0, day: 0, unreviewed: 0, oldestUnreviewedAt: null };

/** Facts under which every check holds: acting on, an open report of 20 minutes, a usable read, everything known and fine. */
const good = (): ActFacts => ({
  mode: 'shadow',
  paused: false,
  appealsEnabled: true,
  report: { open: true, badFaith: false, ageMs: 20 * 60_000, claimed: false, system: false },
  readUsable: true,
  confirmAgrees: true,
  cellAllowed: true,
  gateFailed: null,
  ceiling: null,
  evidenceInExcerpt: true,
  automationAllowed: true,
  personProtected: false,
  reporterHabitual: false,
  caps: { ...OK_USE },
  heldBack: false,
});
const refusal = (f: ActFacts): string | null => preFilter(f, CAPS, NOW);

describe('a control: every fact fine', () => {
  it('passes, in shadow and with acting on, and the name evaluateChecks is the same function', () => {
    expect(refusal(good())).toBeNull();
    expect(refusal({ ...good(), mode: 'on' })).toBeNull();
    expect(evaluateChecks).toBe(preFilter);
  });
});

describe('one refusal code at a time (each with its control)', () => {
  const cases: Array<[string, (f: ActFacts) => ActFacts, string]> = [
    ['acting_off', (f) => ({ ...f, mode: 'off' }), 'acting_off'],
    ['paused', (f) => ({ ...f, paused: true }), 'paused'],
    ['no_appeals', (f) => ({ ...f, appealsEnabled: false }), 'no_appeals'],
    ['not_open (decided)', (f) => ({ ...f, report: { ...f.report, open: false } }), 'not_open'],
    ['not_open (marked bad faith, a hard stop)', (f) => ({ ...f, report: { ...f.report, badFaith: true } }), 'not_open'],
    ['too_old', (f) => ({ ...f, report: { ...f.report, ageMs: AI_ACT_MAX_AGE_MS + 1 } }), 'too_old'],
    ['too_new', (f) => ({ ...f, report: { ...f.report, ageMs: CAPS.holdMs - 1 } }), 'too_new'],
    ['claimed', (f) => ({ ...f, report: { ...f.report, claimed: true } }), 'claimed'],
    ['read_not_usable', (f) => ({ ...f, readUsable: false }), 'read_not_usable'],
    ['confirm_disagrees', (f) => ({ ...f, confirmAgrees: false }), 'confirm_disagrees'],
    ['cell_not_allowed', (f) => ({ ...f, cellAllowed: false }), 'cell_not_allowed'],
    ['gate_failed:volume', (f) => ({ ...f, gateFailed: 'volume' }), 'gate_failed:volume'],
    ['gate_failed:breadth', (f) => ({ ...f, gateFailed: 'breadth' }), 'gate_failed:breadth'],
    ['gate_failed:agreement', (f) => ({ ...f, gateFailed: 'agreement' }), 'gate_failed:agreement'],
    ['gate_failed:override', (f) => ({ ...f, gateFailed: 'override' }), 'gate_failed:override'],
    ['gate_failed:recency', (f) => ({ ...f, gateFailed: 'recency' }), 'gate_failed:recency'],
    ['gate_failed:appeals_rule', (f) => ({ ...f, gateFailed: 'appeals_rule' }), 'gate_failed:appeals_rule'],
    ['gate_failed:appeals_acts', (f) => ({ ...f, gateFailed: 'appeals_acts' }), 'gate_failed:appeals_acts'],
    ['gate_failed:keep', (f) => ({ ...f, gateFailed: 'keep' }), 'gate_failed:keep'],
    ['ceiling_kind', (f) => ({ ...f, ceiling: 'ceiling_kind' }), 'ceiling_kind'],
    ['ceiling_duration', (f) => ({ ...f, ceiling: 'ceiling_duration' }), 'ceiling_duration'],
    ['ceiling_evidence', (f) => ({ ...f, ceiling: 'ceiling_evidence' }), 'ceiling_evidence'],
    ['evidence_missing', (f) => ({ ...f, evidenceInExcerpt: false }), 'evidence_missing'],
    ['do_not_automate', (f) => ({ ...f, automationAllowed: false }), 'do_not_automate'],
    ['person_protected', (f) => ({ ...f, personProtected: true }), 'person_protected'],
    ['reporter_habitual', (f) => ({ ...f, reporterHabitual: true }), 'reporter_habitual'],
    ['system_report', (f) => ({ ...f, report: { ...f.report, system: true } }), 'system_report'],
    ['cap_hour', (f) => ({ ...f, caps: { ...OK_USE, hour: CAPS.perHour } }), 'cap_hour'],
    ['cap_day', (f) => ({ ...f, caps: { ...OK_USE, day: CAPS.perDay } }), 'cap_day'],
    ['review_debt (too many)', (f) => ({ ...f, caps: { ...OK_USE, unreviewed: CAPS.reviewDebtMax + 1 } }), 'review_debt'],
    ['review_debt (too old)', (f) => ({ ...f, caps: { ...OK_USE, unreviewed: 1, oldestUnreviewedAt: NOW - CAPS.reviewWithinMs - 1 } }), 'review_debt'],
    ['held_back', (f) => ({ ...f, heldBack: true }), 'held_back'],
  ];
  it.each(cases)('refuses %s, and the same facts without the fault pass', (_name, fault, code) => {
    expect(refusal(fault(good()))).toBe(code);
    expect(refusal(good())).toBeNull();
  });

  it('every code of design 4.2 is covered here', () => {
    const covered = new Set(cases.map((c) => c[2].replace(/:.*/, '')));
    for (const code of [
      'acting_off', 'paused', 'no_appeals', 'not_open', 'too_old', 'too_new', 'claimed', 'read_not_usable', 'confirm_disagrees', 'cell_not_allowed', 'gate_failed',
      'ceiling_kind', 'ceiling_duration', 'ceiling_evidence', 'evidence_missing', 'do_not_automate', 'person_protected', 'reporter_habitual', 'system_report', 'cap_hour',
      'cap_day', 'review_debt', 'held_back',
    ]) {
      expect(covered.has(code), code).toBe(true);
    }
  });
});

describe('the order of the table is the order of the codes', () => {
  const faults: Array<[string, (f: ActFacts) => ActFacts]> = [
    ['acting_off', (f) => ({ ...f, mode: 'off' })],
    ['paused', (f) => ({ ...f, paused: true })],
    ['no_appeals', (f) => ({ ...f, appealsEnabled: false })],
    ['not_open', (f) => ({ ...f, report: { ...f.report, open: false } })],
    ['too_old', (f) => ({ ...f, report: { ...f.report, ageMs: AI_ACT_MAX_AGE_MS + 1 } })],
    ['claimed', (f) => ({ ...f, report: { ...f.report, claimed: true } })],
    ['read_not_usable', (f) => ({ ...f, readUsable: false })],
    ['confirm_disagrees', (f) => ({ ...f, confirmAgrees: false })],
    ['cell_not_allowed', (f) => ({ ...f, cellAllowed: false })],
    ['gate_failed:volume', (f) => ({ ...f, gateFailed: 'volume' })],
    ['ceiling_kind', (f) => ({ ...f, ceiling: 'ceiling_kind' })],
    ['evidence_missing', (f) => ({ ...f, evidenceInExcerpt: false })],
    ['do_not_automate', (f) => ({ ...f, automationAllowed: false })],
    ['person_protected', (f) => ({ ...f, personProtected: true })],
    ['reporter_habitual', (f) => ({ ...f, reporterHabitual: true })],
    ['system_report', (f) => ({ ...f, report: { ...f.report, system: true } })],
    ['cap_hour', (f) => ({ ...f, caps: { ...OK_USE, hour: CAPS.perHour } })],
    ['held_back', (f) => ({ ...f, heldBack: true })],
  ];
  it('with a fault and every later fault at once, the earlier code wins', () => {
    for (let i = 0; i < faults.length; i += 1) {
      const all = faults.slice(i).reduce((f, [, fault]) => fault(f), good());
      expect(refusal(all), faults[i]?.[0]).toBe(faults[i]?.[0]);
    }
  });
});

describe('the boundaries', () => {
  it('a report of exactly 24 hours is acted on; one millisecond more is too old', () => {
    expect(refusal({ ...good(), report: { ...good().report, ageMs: AI_ACT_MAX_AGE_MS } })).toBeNull();
    expect(refusal({ ...good(), report: { ...good().report, ageMs: AI_ACT_MAX_AGE_MS + 1 } })).toBe('too_old');
  });

  it('a report exactly as old as the hold is acted on; one millisecond less is too new (and the hold follows the configured number)', () => {
    expect(refusal({ ...good(), report: { ...good().report, ageMs: CAPS.holdMs } })).toBeNull();
    expect(refusal({ ...good(), report: { ...good().report, ageMs: CAPS.holdMs - 1 } })).toBe('too_new');
    const long = { ...CAPS, holdMs: H };
    expect(preFilter({ ...good(), report: { ...good().report, ageMs: 30 * 60_000 } }, long, NOW)).toBe('too_new');
    expect(preFilter({ ...good(), report: { ...good().report, ageMs: H } }, long, NOW)).toBeNull();
  });

  it('the hold is ten minutes by default', () => {
    expect(CAPS.holdMs).toBe(600_000);
    expect(dueAt(1000, CAPS.holdMs)).toBe(601_000);
    expect(dueAt(NOW, 300_000)).toBe(NOW + 300_000);
  });

  it('the 11th action in an hour is refused, the 10th is allowed; the 51st in a day likewise', () => {
    expect(capsOk({ ...OK_USE, hour: 9 }, CAPS, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, hour: 10 }, CAPS, NOW)).toBe('cap_hour');
    expect(capsOk({ ...OK_USE, hour: 3, day: 49 }, CAPS, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, hour: 3, day: 50 }, CAPS, NOW)).toBe('cap_day');
    expect(capsOk({ ...OK_USE, hour: 10, day: 50 }, CAPS, NOW)).toBe('cap_hour');
  });

  it('review debt: 25 unreviewed is not debt, 26 is; 72 hours is not debt, 72 hours and a millisecond is', () => {
    expect(capsOk({ ...OK_USE, unreviewed: 25 }, CAPS, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, unreviewed: 26 }, CAPS, NOW)).toBe('review_debt');
    expect(capsOk({ ...OK_USE, unreviewed: 1, oldestUnreviewedAt: NOW - 72 * H }, CAPS, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, unreviewed: 1, oldestUnreviewedAt: NOW - 72 * H - 1 }, CAPS, NOW)).toBe('review_debt');
  });

  it('the caps follow the configured numbers: a band edge each', () => {
    expect(capsOk({ ...OK_USE, hour: 59 }, { ...CAPS, perHour: 60 }, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, hour: 60 }, { ...CAPS, perHour: 60 }, NOW)).toBe('cap_hour');
    expect(capsOk({ ...OK_USE, hour: 1 }, { ...CAPS, perHour: 1 }, NOW)).toBe('cap_hour');
    expect(capsOk({ ...OK_USE, day: 499 }, { ...CAPS, perDay: 500 }, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, unreviewed: 100 }, { ...CAPS, reviewDebtMax: 100 }, NOW)).toBeNull();
    expect(capsOk({ ...OK_USE, unreviewed: 1, oldestUnreviewedAt: NOW - H - 1 }, { ...CAPS, reviewWithinMs: H }, NOW)).toBe('review_debt');
  });
});

describe('skipping what the caller does not know yet', () => {
  it('a fact that is absent is not checked: the AI module asks only what it can read before it spends a call', () => {
    const cheap: ActFacts = { mode: 'shadow', paused: false, appealsEnabled: true, report: { open: true, badFaith: false, ageMs: CAPS.holdMs, claimed: false, system: false } };
    expect(refusal(cheap)).toBeNull();
    expect(refusal({ ...cheap, readUsable: false })).toBe('read_not_usable');
    expect(refusal({ ...cheap, confirmAgrees: undefined, heldBack: undefined })).toBeNull();
  });

  it('is pure: it does not change the facts and gives the same answer twice', () => {
    const f = Object.freeze({ ...good(), caps: Object.freeze({ ...OK_USE, hour: 10 }), report: Object.freeze({ ...good().report }) });
    expect(preFilter(f, CAPS, NOW)).toBe('cap_hour');
    expect(preFilter(f, CAPS, NOW)).toBe('cap_hour');
  });

  it('knows nothing of signals, counts or flags: the facts have no such field and an extra one changes nothing', () => {
    const noisy = { ...good(), signals: { muted: 999 }, reportCount: 1000, flags: 50, reports: 40 } as ActFacts;
    expect(refusal(noisy)).toBeNull();
    expect(refusal({ ...noisy, gateFailed: 'volume' })).toBe('gate_failed:volume');
  });
});

describe('the holdback', () => {
  const hmac = (secret: string) => (input: string) => sha256Hex(`${secret}|${input}`);
  const ids = Array.from({ length: 1000 }, (_, i) => `report-${i}-${(i * 7919) % 10007}`);
  const share = (hasher: (s: string) => string, s: number): number => ids.filter((id) => isHeldBack(id, hasher, s)).length / ids.length;

  it('is the same report on every call, for the same secret', () => {
    const h = hmac('kit-secret');
    for (const id of ids.slice(0, 50)) expect(isHeldBack(id, h, 0.2)).toBe(isHeldBack(id, hmac('kit-secret'), 0.2));
  });

  it('is about 20% of a thousand ids (and never all or none)', () => {
    const f = share(hmac('kit-secret'), 0.2);
    expect(f).toBeGreaterThan(0.16);
    expect(f).toBeLessThan(0.24);
  });

  it('is keyed with the kit secret: another secret holds back another set', () => {
    const a = new Set(ids.filter((id) => isHeldBack(id, hmac('secret-a'), 0.2)));
    const b = new Set(ids.filter((id) => isHeldBack(id, hmac('secret-b'), 0.2)));
    const both = [...a].filter((id) => b.has(id)).length;
    expect(both).toBeLessThan(a.size * 0.6);
    expect(b.size).toBeGreaterThan(0);
  });

  it('is configurable inside its band: 10% to 50% each hold back about that share', () => {
    for (const s of [0.1, 0.2, 0.3, 0.5]) {
      const f = share(hmac('kit-secret'), s);
      expect(f, String(s)).toBeGreaterThan(s - 0.04);
      expect(f, String(s)).toBeLessThan(s + 0.04);
    }
  });

  it('a larger share holds back everything a smaller one does (a threshold, not a reshuffle)', () => {
    const h = hmac('kit-secret');
    for (const id of ids) if (isHeldBack(id, h, 0.1)) expect(isHeldBack(id, h, 0.2)).toBe(true);
  });

  it('a share of 0 (or less, or not a number) holds back none, a share of 1 or more holds back all', () => {
    const h = hmac('kit-secret');
    for (const s of [0, -0.5, Number.NaN]) expect(share(h, s), String(s)).toBe(0);
    for (const s of [1, 1.5]) expect(share(h, s), String(s)).toBe(1);
  });

  it('a hasher that answers something that is not hex holds nobody back (it never throws)', () => {
    expect(isHeldBack('r1', () => 'zzzzzzzz', 0.5)).toBe(false);
    expect(isHeldBack('r1', () => '', 0.5)).toBe(false);
  });

  it('asks the hasher for the report id only, under its own prefix, so it can never collide with another use of the secret', () => {
    const seen: string[] = [];
    isHeldBack('rep-1', (s) => (seen.push(s), 'ffffffff'), 0.2);
    expect(seen).toEqual(['ai-holdback:rep-1']);
  });
});

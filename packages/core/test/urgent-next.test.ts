import { describe, expect, it } from 'vitest';
import type { World } from './reportingWorld.js';
import { HOUR, MIN, world } from './reportingWorld.js';

// U4: take next serves an urgent case first, under the caller's filters, ignoring the habitual-reporter rank-down and the signal boost for that pass, and never
// over a claim. With no urgent case free it is the ordinary scan, unchanged.

const MOD_A = 'mod_ann';
const MOD_B = 'mod_bea';

/** A report against a fresh person, in a fresh room, `step` later than the last. */
async function filed(w: World, reason: string | undefined, key: string, reporter?: string) {
  w.clock.t += MIN;
  const f = await w.file(reason === undefined ? {} : { reason }, { target: `t-${key}`, ...(reporter === undefined ? { reporter: `r-${key}` } : { reporter }) });
  return f;
}

describe('take next: the urgent pass', () => {
  it('returns the oldest free urgent case first, even when ordinary cases are older', async () => {
    const w = await world();
    const ordinary = await filed(w, 'harassment', 'o1');
    const urgentOld = await filed(w, 'threat', 'u1');
    await filed(w, 'harassment', 'o2');
    const urgentNew = await filed(w, 'threat', 'u2');
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(urgentOld.id);
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(urgentNew.id);
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(ordinary.id);
  });

  it('applies the caller\'s category filter and reason filter to the urgent pass', async () => {
    const w = await world();
    const hateOrdinary = await filed(w, 'hate', 'h1');
    const threat = await filed(w, 'threat', 't1');
    const hate = await filed(w, 'hate', 'h2');
    // hate is not urgent by default; flag it for this test
    expect(w.store.setReportUrgent?.(hate.id, true)).toBe(true);
    // category harassment: threat's legacy category: the urgent pass with that filter finds the threat, not the urgent hate report
    expect(w.cw.cases.next(MOD_A, { category: 'harassment' })?.reportId).toBe(threat.id);
    // reason filter: hate: the urgent hate case first, then the ordinary one
    expect(w.cw.cases.next(MOD_B, { reason: 'hate' })?.reportId).toBe(hate.id);
    expect(w.cw.cases.next(MOD_B, { reason: 'hate' })?.reportId).toBe(hateOrdinary.id);
    expect(w.cw.cases.next(MOD_B, { reason: 'hate' })).toBeNull();
  });

  it('an urgent case held by another moderator is skipped', async () => {
    const w = await world();
    const first = await filed(w, 'threat', 'u1');
    const second = await filed(w, 'threat', 'u2');
    expect(w.cw.cases.claim(first.target, MOD_B)).toMatchObject({ ok: true });
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(second.id);
  });

  it('with only held urgent cases the ordinary scan runs', async () => {
    const w = await world();
    const urgent = await filed(w, 'threat', 'u1');
    const ordinary = await filed(w, 'harassment', 'o1');
    w.cw.cases.claim(urgent.target, MOD_B);
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(ordinary.id);
    expect(w.cw.cases.next(MOD_A)).toBeNull();
  });

  it('with none urgent the order equals the ordinary order', async () => {
    const a = await world();
    const b = await world();
    const idsA: string[] = [];
    const idsB: string[] = [];
    for (const key of ['x1', 'x2', 'x3', 'x4']) {
      idsA.push((await filed(a, 'harassment', key)).id);
      idsB.push((await filed(b, 'spam', key)).id);
    }
    const orderA = [a.cw.cases.next(MOD_A), a.cw.cases.next(MOD_A), a.cw.cases.next(MOD_A), a.cw.cases.next(MOD_A)].map((c) => idsA.indexOf(c?.reportId ?? ''));
    const orderB = [b.cw.cases.next(MOD_A), b.cw.cases.next(MOD_A), b.cw.cases.next(MOD_A), b.cw.cases.next(MOD_A)].map((c) => idsB.indexOf(c?.reportId ?? ''));
    expect(orderA).toEqual([0, 1, 2, 3]);
    expect(orderB).toEqual(orderA);
  });

  it('a decided urgent report is no longer served as urgent', async () => {
    const w = await world();
    const urgent = await filed(w, 'threat', 'u1');
    const ordinary = await filed(w, 'harassment', 'o1');
    await w.cw.decide({ reportId: urgent.id, verdict: 'no_action', actions: [], actor: MOD_B });
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(ordinary.id);
  });

  it('a person with an urgent and an ordinary open report is one case, opened on the newest report', async () => {
    const w = await world();
    const a = await w.file({ reason: 'threat' }, { reporter: 'r-a', target: 't-same' });
    w.clock.t += MIN;
    const b = await w.file({ reason: 'harassment' }, { reporter: 'r-b', target: 't-same' });
    const got = w.cw.cases.next(MOD_A);
    expect(got?.person).toBe(a.target);
    expect(got?.reportId).toBe(b.id);
  });
});

describe('take next: habitual reporters and the signal boost', () => {
  /** A reporter whose last five reports were all dismissed: habitual. Returns their key. */
  async function habitual(w: World, key: string): Promise<string> {
    for (let i = 0; i < 5; i++) {
      w.clock.t += MIN;
      const f = await w.file({ reason: 'spam' }, { reporter: key, target: `t-${key}-${i}` });
      await w.cw.decide({ reportId: f.id, verdict: 'no_action', actions: [], actor: MOD_B });
    }
    return key;
  }

  it('ignores the habitual-reporter rank-down for an urgent case and still ranks down ordinary ones', async () => {
    const w = await world();
    await habitual(w, 'serial');
    // the habitual reporter files an ordinary report first, then a threat; a normal reporter files an ordinary one last
    const downOrdinary = await filed(w, 'harassment', 'd1', 'serial');
    const threat = await filed(w, 'threat', 'd2', 'serial');
    const normal = await filed(w, 'harassment', 'n1');
    const opts = { rankDownHabitual: true };
    // the threat from a habitual reporter is read first; then the normal reporter's case; the habitual ordinary one is served last
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(threat.id);
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(normal.id);
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(downOrdinary.id);
  });

  it('signalBoost does not reorder the urgent pass', async () => {
    const w = await world();
    const old = await filed(w, 'harassment', 'o1');
    w.clock.t += 2 * HOUR;
    const u1 = await filed(w, 'threat', 'u1');
    const u2 = await filed(w, 'threat', 'u2');
    w.clock.t += 30 * HOUR;
    const opts = { signalBoost: true };
    // the first ordinary case is overdue (24 h) and would be the boosted choice; the urgent pass comes first all the same, oldest first
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(u1.id);
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(u2.id);
    expect(w.cw.cases.next(MOD_A, opts)?.reportId).toBe(old.id);
  });
});

describe('take next: two moderators at once', () => {
  it('get two different urgent cases, or one falls through, never the same', async () => {
    const w = await world();
    const u1 = await filed(w, 'threat', 'u1');
    const u2 = await filed(w, 'threat', 'u2');
    const o1 = await filed(w, 'harassment', 'o1');
    const a = w.cw.cases.next(MOD_A);
    const b = w.cw.cases.next(MOD_B);
    expect(a?.reportId).toBe(u1.id);
    expect(b?.reportId).toBe(u2.id);
    // a third moderator now falls through to the ordinary case; a fourth gets nothing
    expect(w.cw.cases.next('mod_cyd')?.reportId).toBe(o1.id);
    expect(w.cw.cases.next('mod_dee')).toBeNull();
  });

  it('a moderator who already holds the urgent case is not handed it again', async () => {
    const w = await world();
    await filed(w, 'threat', 'u1');
    const o1 = await filed(w, 'harassment', 'o1');
    expect(w.cw.cases.next(MOD_A)).not.toBeNull();
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(o1.id);
  });
});

describe('take next: a store that cannot filter by urgent', () => {
  it('takes the ordinary scan, and never treats an unfiltered page as urgent', async () => {
    const { MemoryStore } = await import('@chatwarden/store-memory');
    class Old extends MemoryStore {
      constructor() {
        super();
        // @ts-expect-error: a custom store written before the urgent lane has none of its methods
        this.countOpenUrgent = undefined;
      }
    }
    const w = await world({}, new Old());
    const first = await filed(w, 'harassment', 'o1');
    await filed(w, 'threat', 'u1');
    expect(w.cw.cases.next(MOD_A)?.reportId).toBe(first.id);
  });
});

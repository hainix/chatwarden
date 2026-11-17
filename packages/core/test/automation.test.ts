import { MemoryStore, withMemoryAi } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { automationAllowed } from '../src/ai/ceilings.js';
import { AUTOMATION_CODES } from '../src/automation.js';
import type { Store } from '../src/types.js';
import { aiWorld } from './ai/aiWorld.js';
import { NOW } from './reportingWorld.js';

// "Do not automate" (AI levels 3 and 4, design 6.4, ruling 17): a mark on a person that only seniors set, with a closed reason code and no
// free text. The mark follows a merge. Reads and drafts are still produced for a marked person; only acting is refused (nothing acts yet).

const SENIOR = 'sen_ann';

type MarkStore = Required<Pick<Store, 'loadNoAutomation' | 'setNoAutomation'>>;

/** A kit over a store that has the AI methods (and with them the mark), with a way to seat one person. */
async function kit() {
  const w = await aiWorld({ level: 2 });
  let n = 0;
  const seat = (key: string, accountId?: string): string => {
    n += 1;
    const room = `seat-room-${n}`;
    w.cw.rooms.seat(room, 'p1', { clientKey: key, ...(accountId === undefined ? {} : { accountId }) }, 'Pat');
    return w.cw.rooms.subjectAt(room, 'p1') as string;
  };
  return { ...w, seat, marks: w.store as unknown as MarkStore };
}

describe('cw.people.automation', () => {
  it('the codes are the five closed ones, frozen', () => {
    expect([...AUTOMATION_CODES]).toEqual(['vulnerable', 'under_review', 'staff', 'sensitive_case', 'other']);
    expect(Object.isFrozen(AUTOMATION_CODES)).toBe(true);
  });

  it('a person is allowed by default', async () => {
    const k = await kit();
    const p = k.seat('k1');
    expect(k.cw.people.automation.get(p)).toEqual({ allowed: true, code: null, at: null });
    expect(k.cw.people.automation.get('s_never_seen')).toEqual({ allowed: true, code: null, at: null });
  });

  it('set false stores the code and the actor and get returns it', async () => {
    const k = await kit();
    const p = k.seat('k1');
    expect(k.cw.people.automation.set(p, { allowed: false, code: 'vulnerable', actor: SENIOR })).toEqual({ ok: true });
    expect(k.cw.people.automation.get(p)).toEqual({ allowed: false, code: 'vulnerable', at: NOW });
    // the actor is kept in the store (audit-class), never in the answer
    expect(k.marks.loadNoAutomation(p)).toEqual({ subject: p, code: 'vulnerable', setBy: SENIOR, setAt: NOW });
    expect(JSON.stringify(k.cw.people.automation.get(p))).not.toContain(SENIOR);
  });

  it('setting again replaces the code and the time', async () => {
    const k = await kit();
    const p = k.seat('k1');
    k.cw.people.automation.set(p, { allowed: false, code: 'staff', actor: SENIOR });
    k.clock.t += 5_000;
    k.cw.people.automation.set(p, { allowed: false, code: 'other', actor: 'sen_bo' });
    expect(k.cw.people.automation.get(p)).toEqual({ allowed: false, code: 'other', at: NOW + 5_000 });
  });

  it('set true clears it', async () => {
    const k = await kit();
    const p = k.seat('k1');
    k.cw.people.automation.set(p, { allowed: false, code: 'under_review', actor: SENIOR });
    expect(k.cw.people.automation.set(p, { allowed: true, actor: SENIOR })).toEqual({ ok: true });
    expect(k.cw.people.automation.get(p)).toEqual({ allowed: true, code: null, at: null });
    expect(k.marks.loadNoAutomation(p)).toBeNull();
    // clearing a person with no mark is fine
    expect(k.cw.people.automation.set(k.seat('k2'), { allowed: true, actor: SENIOR })).toEqual({ ok: true });
  });

  it('a bad code or a missing code for false is invalid, and nothing is written', async () => {
    const k = await kit();
    const p = k.seat('k1');
    const bad: unknown[] = [
      { allowed: false, actor: SENIOR },
      { allowed: false, code: undefined, actor: SENIOR },
      { allowed: false, code: 'because', actor: SENIOR },
      { allowed: false, code: '', actor: SENIOR },
      { allowed: false, code: 'VULNERABLE', actor: SENIOR },
      { allowed: false, code: 'toString', actor: SENIOR },
      { allowed: false, code: '__proto__', actor: SENIOR },
      { allowed: false, code: 7, actor: SENIOR },
      { allowed: false, code: null, actor: SENIOR },
      { allowed: false, code: ['other'], actor: SENIOR },
      { allowed: false, code: 'other' },
      { allowed: false, code: 'other', actor: '' },
      { allowed: false, code: 'other', actor: '   ' },
      { allowed: false, code: 'other', actor: 5 },
      { allowed: 'false', code: 'other', actor: SENIOR },
      { allowed: 0, code: 'other', actor: SENIOR },
      { allowed: undefined, code: 'other', actor: SENIOR },
      // a code on a "true" is a mistake, not a mark
      { allowed: true, code: 'other', actor: SENIOR },
      { allowed: true },
      null,
      undefined,
      'x',
    ];
    for (const input of bad) {
      expect(k.cw.people.automation.set(p, input as never), JSON.stringify(input)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(k.cw.people.automation.get(p).allowed).toBe(true);
    expect(k.marks.loadNoAutomation(p)).toBeNull();
  });

  it('a subject that is not a known person is invalid, and get never throws on junk', async () => {
    const k = await kit();
    for (const s of ['s_nobody', '', '   ', 5, null, undefined, {}]) {
      expect(k.cw.people.automation.set(s as never, { allowed: false, code: 'other', actor: SENIOR }), String(s)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(k.cw.people.automation.get(5 as never)).toEqual({ allowed: true, code: null, at: null });
  });

  it('every code is accepted, and the actor is trimmed', async () => {
    const k = await kit();
    for (const code of AUTOMATION_CODES) {
      const p = k.seat(`k-${code}`);
      expect(k.cw.people.automation.set(p, { allowed: false, code, actor: `  ${SENIOR}  ` })).toEqual({ ok: true });
      expect(k.cw.people.automation.get(p)).toMatchObject({ allowed: false, code });
      expect(k.marks.loadNoAutomation(p)?.setBy).toBe(SENIOR);
    }
  });

  it('marking one person does not mark another', async () => {
    const k = await kit();
    const a = k.seat('k1');
    const b = k.seat('k2');
    k.cw.people.automation.set(a, { allowed: false, code: 'staff', actor: SENIOR });
    expect(k.cw.people.automation.get(b).allowed).toBe(true);
  });

  it('the mark follows a merge: marking either alias marks the canonical person', async () => {
    const k = await kit();
    const a = k.seat('ka', 'acct-m');
    const b = k.seat('kb');
    k.seat('kb', 'acct-m'); // the second key meets the first one's account: the two are one person
    const root = k.cw.people.canonical(a);
    expect(k.cw.people.canonical(b)).toBe(root);
    const alias = a === root ? b : a;
    expect(alias).not.toBe(root);
    k.cw.people.automation.set(alias, { allowed: false, code: 'sensitive_case', actor: SENIOR });
    expect(k.cw.people.automation.get(root)).toMatchObject({ allowed: false, code: 'sensitive_case' });
    expect(k.cw.people.automation.get(alias)).toMatchObject({ allowed: false, code: 'sensitive_case' });
    // the row is under the canonical person
    expect(k.marks.loadNoAutomation(root)?.code).toBe('sensitive_case');
    // clearing through the other alias clears it for both
    k.cw.people.automation.set(root, { allowed: true, actor: SENIOR });
    expect(k.cw.people.automation.get(alias).allowed).toBe(true);
    expect(k.cw.people.automation.get(root).allowed).toBe(true);
  });

  it('a mark set before two people merge still marks the merged person; the newest wins; clearing clears every row', async () => {
    const k = await kit();
    const a = k.seat('ka', 'acct-1');
    const b = k.seat('kb');
    k.cw.people.automation.set(b, { allowed: false, code: 'vulnerable', actor: SENIOR });
    k.clock.t += 1_000;
    k.cw.people.automation.set(a, { allowed: false, code: 'staff', actor: SENIOR });
    expect(k.cw.people.canonical(a)).not.toBe(k.cw.people.canonical(b));
    // b meets a's account: they are one person now
    k.seat('kb', 'acct-1');
    expect(k.cw.people.canonical(a)).toBe(k.cw.people.canonical(b));
    const merged = k.cw.people.automation.get(a);
    expect(merged).toEqual({ allowed: false, code: 'staff', at: NOW + 1_000 });
    expect(k.cw.people.automation.get(b)).toEqual(merged);
    k.cw.people.automation.set(b, { allowed: true, actor: SENIOR });
    expect(k.cw.people.automation.get(a).allowed).toBe(true);
    expect(k.marks.loadNoAutomation(a)).toBeNull();
    expect(k.marks.loadNoAutomation(b)).toBeNull();
  });

  it('a store that fails on a read means "not allowed" (fail closed), and a failing write throws its own error', async () => {
    const k = await kit();
    const p = k.seat('k1');
    k.cw.people.automation.set(p, { allowed: false, code: 'other', actor: SENIOR });
    k.marks.loadNoAutomation = () => {
      throw new Error('disk gone');
    };
    k.marks.setNoAutomation = () => {
      throw new Error('disk gone');
    };
    expect(k.cw.people.automation.get(p)).toMatchObject({ allowed: false });
    expect(() => k.cw.people.automation.set(p, { allowed: true, actor: SENIOR })).toThrow('disk gone');
  });
});

describe('automationAllowed', () => {
  it('is false for a marked person and the old signature still works for a plain id', () => {
    expect(automationAllowed('anyone')).toBe(true);
    expect(automationAllowed('')).toBe(true);
    const marked = new Set(['s_m']);
    const lookup = (p: string): boolean => !marked.has(p);
    expect(automationAllowed('s_m', lookup)).toBe(false);
    expect(automationAllowed('s_other', lookup)).toBe(true);
  });

  it('a lookup that throws, or answers anything but true, means not allowed', () => {
    expect(
      automationAllowed('s_x', () => {
        throw new Error('boom');
      }),
    ).toBe(false);
    for (const v of [undefined, null, 0, 1, 'true', {}]) expect(automationAllowed('s_x', () => v as never), String(v)).toBe(false);
    expect(automationAllowed('s_x', () => true)).toBe(true);
  });
});

describe('a marked person is still read', () => {
  it('reads and drafts are still produced for a marked person', async () => {
    const k = await aiWorld({ level: 2 });
    const r = await k.report();
    k.cw.people.automation.set(r.target, { allowed: false, code: 'vulnerable', actor: SENIOR });
    await k.idle();
    const read = k.cw.ai.read(r.id);
    expect(read).not.toBeNull();
    expect(read?.recommendation).not.toBeNull();
    expect(k.adapter.callCount).toBe(1);
    expect(k.cw.ai.gates().actingAvailable).toBe(false);
  });
});

describe('a store without the methods', () => {
  it('answers unsupported and the AI still reads', async () => {
    const s = withMemoryAi(new MemoryStore());
    const target = s as unknown as Record<string, unknown>;
    delete target.setNoAutomation;
    delete target.loadNoAutomation;
    const k = await aiWorld({ level: 2, store: s });
    const r = await k.report();
    expect(k.cw.people.automation.set(r.target, { allowed: false, code: 'other', actor: SENIOR })).toEqual({ ok: false, error: 'unsupported' });
    // with no mark possible, nobody is marked
    expect(k.cw.people.automation.get(r.target)).toEqual({ allowed: true, code: null, at: null });
    await k.idle();
    expect(k.cw.ai.read(r.id)?.recommendation).not.toBeNull();
  });

  it('a plain memory store has no mark methods at all', () => {
    const plain = new MemoryStore() as unknown as Record<string, unknown>;
    expect(plain.setNoAutomation).toBeUndefined();
    expect(plain.loadNoAutomation).toBeUndefined();
  });
});

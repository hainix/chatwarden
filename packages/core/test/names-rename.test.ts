import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryAppeals } from '@chatwarden/store-memory';
import type { KitEvent } from '../src/events.js';
import type { NoticeRow, RawWho, Store, SubjectId } from '../src/types.js';
import { NOW, world } from './reportingWorld.js';

// Requiring a rename: cw.names.requireRename, pendingRename and renamed, and cw.people.accountIds. A rename is a notice (no name, no
// excerpt) and an event (a staff ref, a time, a rule); the kit never learns the new name.

const ACTOR = 'mod_ann';
const REASON = 'private note: a name against the rules';

async function kit(names: Record<string, unknown> = { renames: true }, over: Record<string, unknown> = {}, store: Store = new MemoryStore()) {
  const pushed: Array<{ subject: SubjectId; count: number }> = [];
  const w = await world(
    {
      ...over,
      overrides: { names, ...(over['overrides'] as object | undefined) },
      platform: {
        identify: (ctx: unknown) => ctx as RawWho,
        notify: (subject: SubjectId, e: { count: number }) => void pushed.push({ subject, count: e.count }),
      },
    } as never,
    store,
  );
  const events: KitEvent[] = [];
  w.cw.on('*', (e) => void events.push(e));
  const seat = async (key: string, extra: RawWho = {}): Promise<{ who: RawWho; subject: SubjectId }> => {
    const who: RawWho = { clientKey: key, ...extra };
    w.cw.rooms.seat(`room-${key}`, 'p1', who, 'Name');
    await w.cw.flush();
    return { who, subject: w.cw.rooms.subjectAt(`room-${key}`, 'p1') as SubjectId };
  };
  const rows = (): NoticeRow[] => (w.store as MemoryStore).rawNotices();
  return { ...w, events, pushed, seat, rows };
}

const ask = (k: Awaited<ReturnType<typeof kit>>, subject: SubjectId, over: Record<string, unknown> = {}) =>
  k.cw.names.requireRename({ subject, actor: ACTOR, reason: REASON, ...over } as never);

describe('requireRename: each result', () => {
  it('off while names.renames is false: nothing written, nothing emitted, whatever the input', async () => {
    const k = await kit({});
    const p = await k.seat('k1');
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'off' });
    expect(ask(k, p.subject, { reason: '' })).toEqual({ ok: false, error: 'off' });
    expect(ask(k, 'nobody')).toEqual({ ok: false, error: 'off' });
    expect(k.rows()).toEqual([]);
    expect(k.events.filter((e) => e.type === 'rename.required')).toEqual([]);
    expect(k.cw.names.pendingRename(p.who)).toBe(false);
  });

  it('off with no names settings at all (the default)', async () => {
    const w = await world();
    w.cw.rooms.seat('room', 'p1', { clientKey: 'k1' }, 'Name');
    await w.cw.flush();
    const subject = w.cw.rooms.subjectAt('room', 'p1') as SubjectId;
    expect(w.cw.names.requireRename({ subject, actor: ACTOR, reason: REASON })).toEqual({ ok: false, error: 'off' });
  });

  it('the setting is read when asked: turning it on in the policy takes effect at once', async () => {
    const k = await kit({});
    const p = await k.seat('k1');
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'off' });
    k.cw.policy.save({ names: { renames: true } }, { version: 0, actor: 'owner', reason: 'family game' });
    expect(ask(k, p.subject)).toMatchObject({ ok: true });
  });

  it('not_found for a person the kit does not hold, and for ids that are not subject ids at all', async () => {
    const k = await kit();
    for (const s of ['s_nobody', 'x', 'S_', '\u0000', 'a'.repeat(10_000)]) expect(ask(k, s), s.slice(0, 12)).toEqual({ ok: false, error: 'not_found' });
    expect(k.rows()).toEqual([]);
  });

  it('invalid: an empty or blank reason, 501 characters, a non-string reason, a bad rule, a bad actor, a bad input', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const bad: Array<Record<string, unknown>> = [
      { reason: '' },
      { reason: '   \n\t ' },
      { reason: 'x'.repeat(501) },
      { reason: `  ${'x'.repeat(501)}  ` },
      { reason: undefined },
      { reason: 5 },
      { reason: null },
      { rule: 1.5 },
      { rule: Number.NaN },
      { rule: Number.POSITIVE_INFINITY },
      { rule: 0 },
      { rule: -1 },
      { rule: '2' },
      { rule: null },
      { rule: 9999 },
      { actor: '' },
      { actor: 'has a space' },
      { actor: 5 },
      { actor: undefined },
    ];
    for (const o of bad) expect(ask(k, p.subject, o), JSON.stringify(o)).toEqual({ ok: false, error: 'invalid' });
    expect(k.cw.names.requireRename(null as never)).toEqual({ ok: false, error: 'invalid' });
    expect(k.cw.names.requireRename('x' as never)).toEqual({ ok: false, error: 'invalid' });
    expect(k.cw.names.requireRename({ actor: ACTOR, reason: REASON } as never)).toEqual({ ok: false, error: 'invalid' });
    expect(k.cw.names.requireRename({ subject: 5, actor: ACTOR, reason: REASON } as never)).toEqual({ ok: false, error: 'invalid' });
    expect(k.rows()).toEqual([]);
    expect(k.events).toEqual([]);
  });

  it('a reason of exactly 500 characters (after trimming) and of 1 are valid; each success is a pending request', async () => {
    const k = await kit();
    const a = await k.seat('k1');
    const b = await k.seat('k2');
    expect(ask(k, a.subject, { reason: `  ${'x'.repeat(500)}  ` })).toMatchObject({ ok: true });
    expect(ask(k, b.subject, { reason: 'x' })).toMatchObject({ ok: true });
  });

  it('the order of the answers: off, then invalid, then not_found, then pending', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    expect(ask(k, 'nobody', { reason: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(ask(k, 'nobody')).toEqual({ ok: false, error: 'not_found' });
    expect(ask(k, p.subject)).toMatchObject({ ok: true });
    expect(ask(k, p.subject, { reason: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'pending' });
  });

  it('pending while an unreleased request exists, seen or not; the second request writes and tells nothing', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const first = ask(k, p.subject) as { ok: true; noticeId: string };
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'pending' });
    // The player has read it: still pending until the game releases them.
    expect(k.cw.notices.ack(p.who, first.noticeId)).toBe(true);
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'pending' });
    expect(k.rows()).toHaveLength(1);
    expect(k.events.filter((e) => e.type === 'rename.required')).toHaveLength(1);
  });

  it('pending covers a person reached through a merged alias', async () => {
    const k = await kit();
    const a = await k.seat('ka', { accountId: 'acct-m' });
    const b = await k.seat('kb');
    k.cw.rooms.seat('room-link', 'p1', { clientKey: 'kb', accountId: 'acct-m' }, 'Both');
    await k.cw.flush();
    expect(k.cw.people.canonical(a.subject)).toBe(k.cw.people.canonical(b.subject));
    expect(ask(k, a.subject)).toMatchObject({ ok: true });
    expect(ask(k, b.subject)).toEqual({ ok: false, error: 'pending' });
    expect(k.cw.names.pendingRename({ clientKey: 'kb' })).toBe(true);
  });

  it('success: one notice of kind rename_required with no excerpt, no name, no reason; the rule defaults to autoRestrictRule', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const res = ask(k, p.subject);
    expect(res).toEqual({ ok: true, noticeId: expect.any(String) });
    expect(k.rows()).toHaveLength(1);
    expect(k.rows()[0]).toMatchObject({ id: (res as { noticeId: string }).noticeId, subject: p.subject, groupId: null, kind: 'rename_required', rule: '1', until: null, refCode: null, excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    const shown = k.cw.notices.pending(p.who);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({ kind: 'rename_required', rule: 1, until: null, refCode: null, excerpt: [], createdAt: NOW });
    const flat = JSON.stringify([shown, k.rows()]);
    expect(flat).not.toContain(REASON);
    expect(flat).not.toContain(ACTOR);
    expect(flat).not.toContain('Name');
  });

  it('a rule can be given (an active one); a retired or unknown one is invalid', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    expect(ask(k, p.subject, { rule: 2 })).toMatchObject({ ok: true });
    expect(k.rows()[0]?.rule).toBe('2');
    const q = await k.seat('k2');
    expect(ask(k, q.subject, { rule: 4242 })).toEqual({ ok: false, error: 'invalid' });
  });

  it('a request for an alias id is the person\'s: one notice under the surviving person', async () => {
    const k = await kit();
    const a = await k.seat('ka', { accountId: 'acct-n' });
    const b = await k.seat('kb');
    k.cw.rooms.seat('room-link2', 'p1', { clientKey: 'kb', accountId: 'acct-n' }, 'Both');
    await k.cw.flush();
    const survivor = k.cw.people.canonical(a.subject);
    const alias = survivor === a.subject ? b.subject : a.subject;
    expect(ask(k, alias)).toMatchObject({ ok: true });
    expect(k.rows()[0]?.subject).toBe(survivor);
  });

  it('a store failure throws after logging the class only, and writes nothing; the player is told nothing and no event goes out', async () => {
    const store = new MemoryStore();
    const k = await kit({ renames: true }, {}, store);
    const p = await k.seat('k1');
    const insert = store.insertNotice.bind(store);
    store.insertNotice = () => {
      throw new RangeError(`disk full for ${REASON}`);
    };
    expect(() => ask(k, p.subject)).toThrow(RangeError);
    expect(k.logged).toContainEqual(['chatwarden.rename_failed', { error: 'RangeError' }]);
    expect(JSON.stringify(k.logged)).not.toContain(REASON);
    expect(k.events).toEqual([]);
    expect(k.pushed).toEqual([]);
    store.insertNotice = insert;
    expect(ask(k, p.subject)).toMatchObject({ ok: true });
  });

  it('a store that cannot withdraw one notice answers off (a rename could never be released)', async () => {
    const store = new MemoryStore();
    (store as { withdrawNotice?: unknown }).withdrawNotice = undefined;
    const k = await kit({ renames: true }, {}, store);
    const p = await k.seat('k1');
    expect(ask(k, p.subject)).toEqual({ ok: false, error: 'off' });
    expect(k.cw.names.renamed(p.who)).toBe(false);
  });
});

describe('rename.required', () => {
  it('after the commit, once, carrying a staff ref, a time and a rule, and no account id', async () => {
    const k = await kit();
    const p = await k.seat('k1', { accountId: 'acct-secret-9' });
    const seenAtEvent: number[] = [];
    k.cw.on('rename.required', () => void seenAtEvent.push(k.rows().length));
    clockAdvance(k, 5_000);
    const res = ask(k, p.subject, { rule: 2 });
    expect(res).toMatchObject({ ok: true });
    const ev = k.events.filter((e) => e.type === 'rename.required');
    expect(ev).toEqual([{ type: 'rename.required', at: NOW + 5_000, target: k.cw.people.canonical(p.subject), rule: 2 }]);
    // The notice was already in the store when the listener ran.
    expect(seenAtEvent).toEqual([1]);
    const flat = JSON.stringify(ev);
    expect(flat).not.toMatch(/acct-secret|k1|Name|private|mod_ann/);
    expect(Object.keys(ev[0] as object).sort()).toEqual(['at', 'rule', 'target', 'type']);
  });

  it('the player\'s client is told once, with the final pending count', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject);
    expect(k.pushed).toEqual([{ subject: k.cw.people.canonical(p.subject), count: 1 }]);
  });

  it('a throwing or rejecting listener never reaches the caller', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    k.cw.on('rename.required', () => {
      throw new TypeError('listener broke');
    });
    k.cw.on('rename.required', () => Promise.reject(new RangeError('async listener broke')));
    expect(ask(k, p.subject)).toMatchObject({ ok: true });
    expect(k.rows()).toHaveLength(1);
  });

  it('a refused request raises nothing', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject, { reason: '' });
    ask(k, 'nobody');
    expect(k.events.filter((e) => e.type === 'rename.required')).toEqual([]);
  });
});

function clockAdvance(k: { clock: { t: number } }, ms: number): void {
  k.clock.t += ms;
}

describe('pendingRename and renamed', () => {
  it('pendingRename is true until renamed(who) releases the player; renamed says whether it did', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    expect(k.cw.names.pendingRename(p.who)).toBe(false);
    expect(k.cw.names.renamed(p.who)).toBe(false);
    ask(k, p.subject);
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
    expect(k.cw.names.renamed(p.who)).toBe(true);
    expect(k.cw.names.pendingRename(p.who)).toBe(false);
    expect(k.cw.names.renamed(p.who)).toBe(false);
    // The notice is withdrawn: not pending any more, and kept in the store as withdrawn.
    expect(k.cw.notices.pending(p.who)).toEqual([]);
    expect(k.rows()[0]?.withdrawnAt).toBe(NOW);
  });

  it('pendingRename stays true after the player has seen the notice, until the game releases them', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    const res = ask(k, p.subject) as { noticeId: string };
    k.cw.notices.ack(p.who, res.noticeId);
    expect(k.cw.notices.pending(p.who)).toEqual([]);
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
  });

  it('is true until the notice is withdrawn some other way too (a withdrawn row is no longer pending)', async () => {
    const store = new MemoryStore();
    const k = await kit({ renames: true }, {}, store);
    const p = await k.seat('k1');
    const res = ask(k, p.subject) as { noticeId: string };
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
    expect(store.withdrawNotice?.(res.noticeId, NOW + 1)).toBe(true);
    expect(k.cw.names.pendingRename(p.who)).toBe(false);
    expect(k.cw.names.renamed(p.who)).toBe(false);
  });

  it('is found by key or by account, across a merge; an IP alone finds nobody', async () => {
    const k = await kit();
    const p = await k.seat('k1', { accountId: 'acct-1', ip: '203.0.113.9' });
    ask(k, p.subject);
    expect(k.cw.names.pendingRename({ clientKey: 'k1' })).toBe(true);
    expect(k.cw.names.pendingRename({ accountId: 'acct-1' })).toBe(true);
    expect(k.cw.names.pendingRename({ ip: '203.0.113.9' })).toBe(false);
    expect(k.cw.names.renamed({ ip: '203.0.113.9' })).toBe(false);
    expect(k.cw.names.pendingRename({ accountId: 'acct-1' })).toBe(true);
    expect(k.cw.names.renamed({ accountId: 'acct-1' })).toBe(true);
    expect(k.cw.names.pendingRename({ clientKey: 'k1' })).toBe(false);
  });

  it('an unknown who is false and creates no subject; hostile values are false and never throw', async () => {
    const k = await kit();
    await k.seat('k0');
    const before = await k.store.loadSubjects();
    expect(k.cw.names.pendingRename({ clientKey: 'never-seen', accountId: 'acct-never', ip: '203.0.113.7' })).toBe(false);
    expect(k.cw.names.renamed({ clientKey: 'never-seen' })).toBe(false);
    for (const who of [undefined, null, 5, 'x', {}, [], { clientKey: 5 }, { accountId: {} }, Object.create(null)]) {
      expect(k.cw.names.pendingRename(who as never), JSON.stringify(who)).toBe(false);
      expect(k.cw.names.renamed(who as never), JSON.stringify(who)).toBe(false);
    }
    const thrower = {
      get clientKey(): string {
        throw new Error('boom');
      },
    };
    expect(k.cw.names.pendingRename(thrower)).toBe(false);
    expect(k.cw.names.renamed(thrower)).toBe(false);
    await k.cw.flush();
    expect(await k.store.loadSubjects()).toEqual(before);
  });

  it('renamed withdraws every pending rename notice of the person (and nothing else): a warning notice is left alone', async () => {
    const store = new MemoryStore();
    const k = await kit({ renames: true }, {}, store);
    const p = await k.seat('k1');
    const q = await k.seat('k2');
    ask(k, p.subject);
    // A second pending rename row (an older build, or another process) and an unrelated notice of the same person.
    store.insertNotice({ id: 'extra-rename', subject: p.subject, groupId: null, kind: 'rename_required', rule: '1', until: null, refCode: null, excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    store.insertNotice({ id: 'a-warning', subject: p.subject, groupId: 'g-w', kind: 'warning', rule: '2', until: null, refCode: 'M-ABCDE', excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    ask(k, q.subject);
    expect(k.cw.names.renamed(p.who)).toBe(true);
    const byId = new Map(k.rows().map((r) => [r.id, r]));
    expect(byId.get('extra-rename')?.withdrawnAt).toBe(NOW);
    expect(byId.get('a-warning')?.withdrawnAt).toBeNull();
    expect(k.cw.notices.pending(p.who).map((n) => n.kind)).toEqual(['warning']);
    // The other player is still waiting.
    expect(k.cw.names.pendingRename(q.who)).toBe(true);
  });

  it('works while names.renames is off: a request made earlier can still be released, and pendingRename reads true', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject);
    k.cw.policy.save({ names: { renames: false } }, { version: 0, actor: 'owner', reason: 'off again' });
    expect(k.cw.names.pendingRename(p.who)).toBe(true);
    expect(k.cw.names.renamed(p.who)).toBe(true);
  });

  it('renamed announces the new pending count to the player\'s client', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject);
    k.pushed.length = 0;
    k.cw.names.renamed(p.who);
    expect(k.pushed).toEqual([{ subject: k.cw.people.canonical(p.subject), count: 0 }]);
    k.pushed.length = 0;
    k.cw.names.renamed(p.who);
    expect(k.pushed).toEqual([]);
  });
});

describe('what the notice is not', () => {
  it('not on My record, not appealable, not mustAcknowledge; a second request after renamed is allowed', async () => {
    const k = await kit({ renames: true }, { overrides: { appeals: { enabled: true } } }, withMemoryAppeals(new MemoryStore()));
    const p = await k.seat('k1');
    const first = ask(k, p.subject) as { ok: true; noticeId: string };
    expect(first.ok).toBe(true);
    expect(k.cw.notices.record(p.who)).toEqual([]);
    expect(k.cw.notices.pending(p.who)[0]?.mustAcknowledge).toBe(false);
    expect(k.cw.notices.pendingWarning(p.who)).toBe(false);
    expect(k.cw.appeals.enabled()).toBe(true);
    expect(k.cw.appeals.file(p.who, { noticeId: first.noticeId, statement: 'my name is fine' })).toEqual({ ok: false, refused: 'not_appealable' });
    expect(k.cw.appeals.mine(p.who)).toEqual([]);
    k.cw.notices.ack(p.who, first.noticeId);
    expect(k.cw.notices.record(p.who)).toEqual([]);
    expect(k.cw.names.renamed(p.who)).toBe(true);
    const second = ask(k, p.subject) as { ok: true; noticeId: string };
    expect(second.ok).toBe(true);
    expect(second.noticeId).not.toBe(first.noticeId);
    expect(k.rows().map((r) => [r.id, r.withdrawnAt !== null])).toEqual([
      [first.noticeId, true],
      [second.noticeId, false],
    ]);
    expect(k.events.filter((e) => e.type === 'rename.required')).toHaveLength(2);
  });

  it('a rename request does not count as a sanction: nothing in the sanction list, the ladder or the chat path changes', async () => {
    const k = await kit();
    const p = await k.seat('k1');
    ask(k, p.subject);
    expect(k.cw.sanctions.forPerson(p.subject)).toEqual([]);
    expect(k.cw.chat.accept(`room-k1`, 'p1', 'hello')).toMatchObject({ deliver: expect.anything() });
  });
});

describe('people.accountIds', () => {
  it('returns only the strings the game passed as accountId: sorted, folded across merged aliases', async () => {
    const k = await kit();
    const a = await k.seat('ka', { accountId: 'acct-zeta', ip: '203.0.113.1' });
    const b = await k.seat('kb', { accountId: 'acct-alpha' });
    expect(k.cw.people.accountIds(a.subject)).toEqual(['acct-zeta']);
    expect(k.cw.people.accountIds(b.subject)).toEqual(['acct-alpha']);
    // One connection shows both accounts: the two people become one.
    k.cw.rooms.seat('room-both', 'p1', { clientKey: 'ka', accountId: 'acct-alpha' }, 'Both');
    await k.cw.flush();
    expect(k.cw.people.canonical(a.subject)).toBe(k.cw.people.canonical(b.subject));
    expect(k.cw.people.accountIds(a.subject)).toEqual(['acct-alpha', 'acct-zeta']);
    expect(k.cw.people.accountIds(b.subject)).toEqual(['acct-alpha', 'acct-zeta']);
    const flat = JSON.stringify([k.cw.people.accountIds(a.subject), k.cw.people.accountIds(b.subject)]);
    expect(flat).not.toMatch(/ka|kb|203\.0\.113/);
  });

  it('is empty for a guest (a key and no account), an unknown id and anything that is not an id', async () => {
    const k = await kit();
    const guest = await k.seat('k-guest');
    expect(k.cw.people.accountIds(guest.subject)).toEqual([]);
    expect(k.cw.people.accountIds('s_nobody')).toEqual([]);
    for (const bad of ['', undefined, null, 5, {}, ['s_x']]) expect(k.cw.people.accountIds(bad as never), String(bad)).toEqual([]);
  });

  it('is a copy: changing the answer changes nothing', async () => {
    const k = await kit();
    const a = await k.seat('ka', { accountId: 'acct-one' });
    const first = k.cw.people.accountIds(a.subject);
    first.push('tampered');
    expect(k.cw.people.accountIds(a.subject)).toEqual(['acct-one']);
  });

  it('a rename request does not change what accountIds returns, and the event never carries it', async () => {
    const k = await kit();
    const a = await k.seat('ka', { accountId: 'acct-three' });
    ask(k, a.subject);
    expect(k.cw.people.accountIds(a.subject)).toEqual(['acct-three']);
    expect(JSON.stringify(k.events)).not.toContain('acct-three');
  });
});

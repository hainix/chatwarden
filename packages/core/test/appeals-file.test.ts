import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { APPEAL_STATEMENT_MAX, normalizeStatement } from '../src/appeals.js';
import { createChatwarden } from '../src/chatwarden.js';
import type { Platform, RawWho } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';

// Filing: the player side of cw.appeals. The order of checks, the statement, the rate, what is written and what is announced.

const ok = (r: unknown): { ok: true; appeal: { id: string; noticeId: string; status: string; createdAt: number; decidedAt: number | null } } => {
  expect(r).toMatchObject({ ok: true });
  return r as never;
};

describe('file: the happy path', () => {
  it.each(['warning', 'chat', 'area', 'ban'] as const)('a %s notice can be appealed: a row, a PlayerAppeal back, an event', async (kind) => {
    const k = await appealsKit();
    const s = await k.sanction({ kind, durationMs: kind === 'ban' ? null : 6 * HOUR });
    const res = ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' }));
    expect(res.appeal).toEqual({ id: expect.any(String), noticeId: s.noticeId, status: 'open', createdAt: NOW, decidedAt: null });
    const rows = k.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject: s.subject, groupId: s.groupId, noticeId: s.noticeId, reportId: s.reportId, rule: '2', kind, statement: 'It was not me.', status: 'open', createdAt: NOW });
    expect(k.cw.appeals.mine(s.who)).toEqual([res.appeal]);
    const ev = k.events.filter((e) => e.type === 'appeal.created');
    expect(ev).toEqual([{ type: 'appeal.created', appealId: res.appeal.id, createdAt: NOW, target: s.subject, kind, rule: 2 }]);
  });

  it('enabled() is true with the setting and the store methods', async () => {
    const k = await appealsKit();
    expect(k.cw.appeals.enabled()).toBe(true);
  });
});

describe('file: refusals, in order', () => {
  it('off, then not_found, then not_appealable, then statement_invalid, then already_appealed, then rate', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 1 });
    const a = await k.sanction({ key: 'pk' });
    const b = await k.sanction({ key: 'pk' });
    const c = await k.sanction({ key: 'pk' });
    const bad = { noticeId: 'nope', statement: '' };
    // not_found beats everything after it
    expect(k.cw.appeals.file(a.who, bad)).toEqual({ ok: false, refused: 'not_found' });
    // statement_invalid beats already_appealed and rate
    ok(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'one' }));
    expect(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: '   ' })).toEqual({ ok: false, refused: 'statement_invalid' });
    // already_appealed beats rate (the cap of 1 is reached too)
    expect(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'two' })).toEqual({ ok: false, refused: 'already_appealed' });
    // rate, for another sanction
    const r = k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'three' });
    expect(r).toMatchObject({ ok: false, refused: 'rate', retryAfterMs: 7 * DAY });
    void c;
    // a report outcome notice: not_appealable, ahead of an invalid statement
    const reporter = { clientKey: 'key-reporter' };
    const outcome = k.cw.notices.pending(reporter).find((n) => n.kind === 'report_outcome');
    expect(outcome).toBeDefined();
    expect(k.cw.appeals.file(reporter, { noticeId: (outcome as { id: string }).id, statement: '' })).toEqual({ ok: false, refused: 'not_appealable' });
    // and off beats all of it
    const off = await appealsKit({}, { enabled: false });
    const s = await off.sanction();
    expect(off.cw.appeals.file(s.who, { noticeId: 'nope', statement: '' })).toEqual({ ok: false, refused: 'off' });
  });

  it("another player's notice, an unknown id and a malformed id are all not_found with no difference in shape", async () => {
    const k = await appealsKit();
    const a = await k.sanction({ key: 'ka' });
    const b = await k.sanction({ key: 'kb' });
    const answers = [
      k.cw.appeals.file(b.who, { noticeId: a.noticeId, statement: 'x' }),
      k.cw.appeals.file(a.who, { noticeId: 'no-such-notice', statement: 'x' }),
      k.cw.appeals.file(a.who, { noticeId: '', statement: 'x' }),
      k.cw.appeals.file(a.who, { noticeId: 5 as never, statement: 'x' }),
      k.cw.appeals.file(a.who, { noticeId: a.noticeId.toUpperCase(), statement: 'x' }),
      k.cw.appeals.file({ clientKey: 'a-stranger' }, { noticeId: a.noticeId, statement: 'x' }),
      k.cw.appeals.file({ ip: '203.0.113.9' }, { noticeId: a.noticeId, statement: 'x' }),
      k.cw.appeals.file(a.who, null as never),
      k.cw.appeals.file(a.who, 'x' as never),
      k.cw.appeals.file(null as never, { noticeId: a.noticeId, statement: 'x' }),
    ];
    for (const r of answers) expect(r).toEqual({ ok: false, refused: 'not_found' });
    expect(k.rows()).toEqual([]);
  });

  it('a revoke that commits between the read and the insert (another process) leaves no appeal: not_appealable, no row, nothing open or counted, no event', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 1 });
    const s = await k.sanction({ key: 'kr' });
    const real = k.store.transaction.bind(k.store);
    let raced = false;
    (k.store as unknown as { transaction: unknown }).transaction = <T>(fn: () => T): T => {
      if (!raced) {
        raced = true;
        // the other process's revoke: straight to the store, so no hook ran and the notice was not withdrawn
        k.store.revokeSanctionGroup(s.groupId, 'other_proc', NOW, 'lifted');
      }
      return real(fn);
    };
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'late' })).toEqual({ ok: false, refused: 'not_appealable' });
    expect(k.rows()).toEqual([]);
    expect(k.store.countOpenAppeals()).toBe(0);
    expect(k.cw.appeals.openCount()).toBe(0);
    expect(k.events.filter((e) => e.type === 'appeal.created')).toEqual([]);
    // the refusal cost nothing against the weekly cap
    const other = await k.sanction({ key: 'kr' });
    expect(k.cw.appeals.file(other.who, { noticeId: other.noticeId, statement: 'fine' })).toMatchObject({ ok: true });
  });

  it('control: with no revoke in between the same filing is accepted', async () => {
    const k = await appealsKit();
    const s = await k.sanction({ key: 'kc' });
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'ok' })).toMatchObject({ ok: true });
    expect(k.rows()).toHaveLength(1);
  });

  it('a report_outcome, rename_required, appeal outcome and a withdrawn notice are not_appealable', async () => {
    const k = await appealsKit();
    const s = await k.sanction({ key: 'kw' });
    const subject = s.subject;
    const make = (kind: 'rename_required' | 'appeal_upheld' | 'appeal_reduced' | 'appeal_revoked') => {
      k.store.insertNotice({ id: `m-${kind}`, subject, groupId: null, kind, rule: '2', until: null, refCode: 'M-AAAAA', excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
      return `m-${kind}`;
    };
    for (const kind of ['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'] as const) {
      expect(k.cw.appeals.file(s.who, { noticeId: make(kind), statement: 'x' }), kind).toEqual({ ok: false, refused: 'not_appealable' });
    }
    // revoke the sanction: its notice is withdrawn, so it is no longer appealable (and not found either way is fine: not_appealable)
    await k.cw.sanctions.revoke(s.groupId, 'mod_cy', 'lifted');
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'not_appealable' });
    expect(k.rows()).toEqual([]);
  });
});

describe('file: the statement', () => {
  const file = async (statement: unknown) => {
    const k = await appealsKit();
    const s = await k.sanction();
    return { k, s, res: k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: statement as string }) };
  };

  it('empty, whitespace-only, control-only, zero-width-only and blank-lines-only are statement_invalid; a non-string too', async () => {
    for (const st of ['', '   ', '\t \t', '\n\n\n', ' \n \n ', '\u0007\u0008', '\u200b\u200c\u200d\ufeff', '\u202e\u202d', '\u0000', '\uD800', undefined, null, 5, {}]) {
      const { k, res } = await file(st);
      expect(res, JSON.stringify(st)).toEqual({ ok: false, refused: 'statement_invalid' });
      expect(k.rows()).toEqual([]);
    }
  });

  it('only-invisible statements (Hangul fillers, braille blank, grapheme joiner, variation selectors, annotation marks, tag characters) are statement_invalid', async () => {
    const onlyInvisible = [
      '\u115f',
      '\u1160',
      '\u3164',
      '\uffa0',
      '\u2800',
      '\u034f',
      '\ufe00',
      '\ufe0f',
      '\u{e0100}',
      '\u{e01ef}',
      '\ufff9',
      '\ufffa',
      '\ufffb',
      '\u{e0000}',
      '\u{e0001}',
      '\u{e0041}\u{e0042}\u{e007f}',
      '\u3164\u2800 \u115f\u1160\u034f\ufe0f',
    ];
    for (const st of onlyInvisible) {
      const { k, res } = await file(st);
      expect(res, JSON.stringify(st)).toEqual({ ok: false, refused: 'statement_invalid' });
      expect(k.rows()).toEqual([]);
    }
  });

  it('those characters are removed from a real statement, at every position, and the edges of each range are covered', () => {
    const edges = ['\u115f', '\u1160', '\u3164', '\uffa0', '\u2800', '\u034f', '\ufe00', '\ufe08', '\ufe0f', '\u{e0100}', '\u{e0170}', '\u{e01ef}', '\ufff9', '\ufffa', '\ufffb', '\u{e0000}', '\u{e0020}', '\u{e007f}'];
    for (const c of edges) {
      expect(normalizeStatement(`a${c}b`), c).toBe('ab');
      expect(normalizeStatement(`${c}ab${c}`), c).toBe('ab');
    }
    // tag characters that hide a word inside a visible line do not survive
    expect(normalizeStatement('hello\u{e0073}\u{e0065}\u{e0063}\u{e0072}\u{e0065}\u{e0074} world')).toBe('hello world');
  });

  it('the characters just outside each stripped range are kept', () => {
    for (const c of ['\u115e', '\u1161', '\u3163', '\u3165', '\uff9f', '\uffa1', '\u27ff', '\u2801', '\u034e', '\u0350', '\ufdff', '\ufe10', '\u{dffff}', '\u{e0080}', '\u{e00ff}', '\u{e01f0}', '\ufff8', '\ufffc']) {
      expect(normalizeStatement(`a${c}b`), c).toBe(`a${c}b`);
    }
  });

  it('the cleaner stays idempotent and counts after stripping: 1000 visible characters plus invisible padding are accepted', async () => {
    const mixed = 'x\u3164y\u2800\u{e0041}\ufe0f\ufff9z';
    expect(normalizeStatement(mixed)).toBe('xyz');
    expect(normalizeStatement(normalizeStatement(mixed))).toBe('xyz');
    expect((await file('a'.repeat(1000) + '\u3164\u{e0041}'.repeat(400))).res).toMatchObject({ ok: true });
  });

  it('1000 code points are accepted and 1001 are refused; 1000 emoji are accepted (code points, not UTF-16 units)', async () => {
    expect(APPEAL_STATEMENT_MAX).toBe(1000);
    expect((await file('a'.repeat(1000))).res).toMatchObject({ ok: true });
    expect((await file('a'.repeat(1001))).res).toEqual({ ok: false, refused: 'statement_invalid' });
    const emoji = await file('\u{1F4AC}'.repeat(1000));
    expect(emoji.res).toMatchObject({ ok: true });
    expect(emoji.k.rows()[0]?.statement).toBe('\u{1F4AC}'.repeat(1000));
    expect((await file('\u{1F4AC}'.repeat(1001))).res).toEqual({ ok: false, refused: 'statement_invalid' });
  });

  it('a count is taken after stripping: zero-width padding does not count, and a huge input is refused without being worked through', async () => {
    expect((await file('a'.repeat(1000) + '\u200b'.repeat(500))).res).toMatchObject({ ok: true });
    expect((await file('a'.repeat(100_000))).res).toEqual({ ok: false, refused: 'statement_invalid' });
  });

  it('a lone surrogate and a NUL are stripped, without throwing', async () => {
    const { k, res } = await file('a\uD800b\u0000c\uDC00d');
    expect(res).toMatchObject({ ok: true });
    expect(k.rows()[0]?.statement).toBe('abcd');
    // a valid pair beside a lone one survives
    const two = await file('\u{1F4AC}\uD800\u{1F4AC}');
    expect(two.k.rows()[0]?.statement).toBe('\u{1F4AC}\u{1F4AC}');
  });

  it('bidi, zero-width and control characters are stripped; runs of blank lines collapse to one; the stored text is the normalized text', async () => {
    const { k, res } = await file('  Hello\u202e \u200bworld\u0007\r\n\r\n\r\n\r\nsecond\u2028line\ttab  \n   \n\n\nend\u00ad  ');
    expect(res).toMatchObject({ ok: true });
    const stored = k.rows()[0]?.statement;
    expect(stored).toBe('Hello world\n\nsecond\nline tab\n\nend');
    // eslint-disable-next-line no-control-regex
    expect(stored).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff\u00ad]/);
  });

  it('normalizeStatement is pure, idempotent and never throws', () => {
    for (const v of ['x', ' a\u200bb ', '\n\n\na\n\n\n\nb\n\n\n', '\u{1F4AC}', '', 5, null, undefined, {}, Symbol.iterator, 'a\uD800']) {
      const once = normalizeStatement(v);
      expect(typeof once).toBe('string');
      expect(normalizeStatement(once)).toBe(once);
    }
    expect(normalizeStatement('a\n\n\n\nb')).toBe('a\n\nb');
    expect(normalizeStatement('a\n\nb')).toBe('a\n\nb');
    expect(normalizeStatement('a\nb')).toBe('a\nb');
  });

  it('a statement that is a matcher term is stored as written (the hub masks it on read)', async () => {
    const { k, res } = await file('you zorbak');
    expect(res).toMatchObject({ ok: true });
    expect(k.rows()[0]?.statement).toBe('you zorbak');
  });
});

describe('file: one appeal per sanction', () => {
  it('already_appealed on a second file for one sanction, after the first was decided, and from a merged alias', async () => {
    const k = await appealsKit();
    const s = await k.sanction({ key: 'kA' });
    // link a second key to the person through a shared account
    k.cw.rooms.seat('room-x', 'p1', { clientKey: 'kA', accountId: 'acct-1' }, 'A');
    k.cw.rooms.seat('room-x', 'p2', { clientKey: 'kB', accountId: 'acct-1' }, 'B');
    const first = ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'one' }));
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'two' })).toEqual({ ok: false, refused: 'already_appealed' });
    // from the alias: the notice is theirs across aliases, and the sanction already has its appeal
    const alias: RawWho = { clientKey: 'kB', accountId: 'acct-1' };
    expect(k.cw.appeals.file(alias, { noticeId: s.noticeId, statement: 'three' })).toEqual({ ok: false, refused: 'already_appealed' });
    expect(k.cw.appeals.mine(alias)).toEqual([first.appeal]);
    // after the first was decided
    k.store.decideAppeal(first.appeal.id, { status: 'upheld', at: NOW, by: 'bea', reason: 'r', replacementGroupId: null });
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'four' })).toEqual({ ok: false, refused: 'already_appealed' });
    expect(k.rows()).toHaveLength(1);
  });
});

describe('file: the weekly rate', () => {
  it('the exact retryAfterMs at perPlayerPerWeek; accepted again once the oldest leaves the window; a refusal writes no row', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 2 });
    const [a, b, c] = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
    ok(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: '1' }));
    k.clock.t += 2 * DAY;
    ok(k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: '2' }));
    k.clock.t += DAY;
    const refused = k.cw.appeals.file(c.who, { noticeId: c.noticeId, statement: '3' });
    // the oldest was filed at NOW, so it leaves the window 7 days after that: 4 days from here
    expect(refused).toEqual({ ok: false, refused: 'rate', retryAfterMs: 4 * DAY });
    expect(k.rows()).toHaveLength(2);
    expect(k.events.filter((e) => e.type === 'appeal.created')).toHaveLength(2);
    // one millisecond before: still refused; at the stated time: accepted
    k.clock.t += 4 * DAY - 1;
    expect(k.cw.appeals.file(c.who, { noticeId: c.noticeId, statement: '3' })).toEqual({ ok: false, refused: 'rate', retryAfterMs: 1 });
    k.clock.t += 1;
    ok(k.cw.appeals.file(c.who, { noticeId: c.noticeId, statement: '3' }));
    expect(k.rows()).toHaveLength(3);
  });

  it('is counted across aliases, and a different person is not held by it', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 1 });
    const a = await k.sanction({ key: 'kA' });
    const b = await k.sanction({ key: 'kB' });
    const other = await k.sanction({ key: 'kC' });
    k.cw.rooms.seat('room-x', 'p1', { clientKey: 'kA', accountId: 'acct-1' }, 'A');
    k.cw.rooms.seat('room-x', 'p2', { clientKey: 'kB', accountId: 'acct-1' }, 'B');
    ok(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: '1' }));
    expect(k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: '2' })).toMatchObject({ ok: false, refused: 'rate' });
    ok(k.cw.appeals.file(other.who, { noticeId: other.noticeId, statement: '3' }));
  });

  it('perPlayerPerWeek comes from the live profile: raising it in the layer lets the next one through', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 1 });
    const [a, b] = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
    ok(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: '1' }));
    expect(k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: '2' })).toMatchObject({ refused: 'rate' });
    k.cw.policy.save({ appeals: { perPlayerPerWeek: 2 } }, { version: 0, actor: 'owner', reason: 'more' });
    ok(k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: '2' }));
  });
});

describe('file: what can be appealed', () => {
  it("a reduced sanction's replacement can be appealed once", async () => {
    const k = await appealsKit();
    const s = await k.sanction({ key: 'kp', kind: 'ban', durationMs: null });
    ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'first' }));
    // a replacement written by hand, as the decide service writes it: a new group with its own notice
    const second = await k.sanction({ key: 'kp', kind: 'chat' });
    ok(k.cw.appeals.file(s.who, { noticeId: second.noticeId, statement: 'second' }));
    expect(k.cw.appeals.file(s.who, { noticeId: second.noticeId, statement: 'again' })).toMatchObject({ refused: 'already_appealed' });
  });

  it('a warning at 89 days is appealable and at 91 is not; a timed sanction ended 10 days ago is appealable; a permanent ban until revoked', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const warn = await k.sanction({ key: 'kw', kind: 'warning' });
    const timed = await k.sanction({ key: 'kt', kind: 'chat', durationMs: HOUR });
    const perm = await k.sanction({ key: 'kb', kind: 'ban', durationMs: null });
    k.clock.t = NOW + 89 * DAY;
    expect(k.cw.appeals.file(warn.who, { noticeId: warn.noticeId, statement: 'x' })).toMatchObject({ ok: true });
    k.clock.t = NOW + 91 * DAY;
    const warn2 = await k.sanction({ key: 'kw2', kind: 'warning' });
    k.clock.t = NOW + 91 * DAY + 91 * DAY;
    expect(k.cw.appeals.file(warn2.who, { noticeId: warn2.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'not_appealable' });
    // the 89-day one at 91 days is gone from the record
    const old = await appealsKit({}, { perPlayerPerWeek: 20 });
    const w = await old.sanction({ key: 'ow', kind: 'warning' });
    old.clock.t = NOW + 91 * DAY;
    expect(old.cw.appeals.file(w.who, { noticeId: w.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'not_appealable' });
    // a timed sanction that ended 10 days ago is still in the record
    const t = await old.sanction({ key: 'ot', kind: 'chat', durationMs: HOUR });
    old.clock.t += 10 * DAY;
    expect(old.cw.appeals.file(t.who, { noticeId: t.noticeId, statement: 'x' })).toMatchObject({ ok: true });
    // a permanent ban, long after, until it is revoked
    const p = await old.sanction({ key: 'op', kind: 'ban', durationMs: null });
    old.clock.t += 200 * DAY;
    expect(old.cw.appeals.file(p.who, { noticeId: p.noticeId, statement: 'x' })).toMatchObject({ ok: true });
    void timed;
    void perm;
  });
});

describe('file: privacy and events', () => {
  it('a spy logger sees event names and error classes only; the statement is absent from events, notices, audit rows and logs', async () => {
    const SECRET = 'MY-PRIVATE-STATEMENT-qwxz';
    const k = await appealsKit();
    const s = await k.sanction();
    ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: SECRET }));
    expect(JSON.stringify(k.events)).not.toContain(SECRET);
    expect(JSON.stringify(k.store.rawNotices())).not.toContain(SECRET);
    expect(JSON.stringify(k.cw.notices.pending(s.who))).not.toContain(SECRET);
    expect(JSON.stringify(k.cw.audit.list({ limit: 50 }))).not.toContain(SECRET);
    expect(JSON.stringify(k.logged)).not.toContain(SECRET);
    // the statement lives in exactly one place
    expect(JSON.stringify(k.store.listAppeals({ limit: 5 }))).toContain(SECRET);
    // the PlayerAppeal carries no staff field, no reason, no sanction or person id
    const mine = k.cw.appeals.mine(s.who);
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual(['createdAt', 'decidedAt', 'id', 'noticeId', 'status']);
    expect(JSON.stringify(mine)).not.toContain(s.groupId);
    expect(JSON.stringify(mine)).not.toContain(s.subject);
  });

  it('appeal.created is emitted after the commit, once, and not for a refusal', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 1 });
    const [a, b] = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
    let rowsAtEvent = -1;
    k.cw.on('appeal.created', () => {
      rowsAtEvent = k.rows().length;
    });
    ok(k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'x' }));
    expect(rowsAtEvent).toBe(1);
    k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'x' });
    k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'x' });
    k.cw.appeals.file(b.who, { noticeId: 'nope', statement: 'x' });
    expect(k.events.filter((e) => e.type === 'appeal.created')).toHaveLength(1);
  });

  it('a throwing listener cannot fail the filing', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    k.cw.on('appeal.created', () => {
      throw new Error('listener boom');
    });
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toMatchObject({ ok: true });
    expect(k.rows()).toHaveLength(1);
  });

  it('filing moves the change token', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    const before = k.cw.changes.token();
    ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' }));
    expect(k.cw.changes.token()).not.toBe(before);
    const after = k.cw.changes.token();
    k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' });
    expect(k.cw.changes.token()).toBe(after);
  });
});

describe('file: failures and off', () => {
  it('a store failure answers not_found and logs by class', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    k.store.insertAppeal = () => {
      throw new TypeError('disk with secret detail');
    };
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.logged).toContainEqual(['chatwarden.appeal_failed', { error: 'TypeError' }]);
    expect(JSON.stringify(k.logged)).not.toContain('secret detail');
    // mine reads as empty on a failing store
    k.store.listAppealsBy = () => {
      throw new RangeError('x');
    };
    expect(k.cw.appeals.mine(s.who)).toEqual([]);
  });

  it('off: file and mine answer off or [] and write nothing, and no store method is touched', async () => {
    const k = await appealsKit({}, { enabled: false });
    const s = await k.sanction();
    const touched: string[] = [];
    for (const m of ['insertAppeal', 'listAppealsBy', 'loadAppeal', 'countAppealsBy', 'loadSanctionSubjectRow'] as const) {
      const real = (k.store as unknown as Record<string, (...a: unknown[]) => unknown>)[m] as (...a: unknown[]) => unknown;
      (k.store as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        touched.push(m);
        return real.apply(k.store, a);
      };
    }
    expect(k.cw.appeals.enabled()).toBe(false);
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'off' });
    expect(k.cw.appeals.mine(s.who)).toEqual([]);
    expect(touched).toEqual([]);
    expect(k.rows()).toEqual([]);
    // turning it on in the layer makes the next call work
    k.cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect(k.cw.appeals.enabled()).toBe(true);
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toMatchObject({ ok: true });
  });

  it('createChatwarden throws a plain message when appeals are enabled on a store without the methods; enabled() is false otherwise', async () => {
    const platform: Platform = { identify: (ctx) => ctx as RawWho };
    const base = { secret: 's', platform, clock: { now: () => NOW }, retention: false as const };
    await expect(createChatwarden({ ...base, store: new MemoryStore(), overrides: { appeals: { enabled: true } } })).rejects.toThrow(/appeals/);
    const message = await createChatwarden({ ...base, store: new MemoryStore(), overrides: { appeals: { enabled: true } } }).then(
      () => '',
      (e: Error) => e.message,
    );
    expect(message).not.toMatch(/undefined|\[object/);
    const cw = await createChatwarden({ ...base, store: new MemoryStore() });
    expect(cw.appeals.enabled()).toBe(false);
    expect(cw.appeals.file({ clientKey: 'k' }, { noticeId: 'n', statement: 'x' })).toEqual({ ok: false, refused: 'off' });
    expect(cw.appeals.mine({ clientKey: 'k' })).toEqual([]);
    // a layer that turns it on over a store without the methods leaves enabled() false (it cannot work)
    cw.policy.save({ appeals: { enabled: true } }, { version: 0, actor: 'owner', reason: 'on' });
    expect(cw.appeals.enabled()).toBe(false);
  });
});

describe('mine', () => {
  it('lists the caller\'s own appeals, newest first, at most 50, without moot ones; an unknown person gets []', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await k.sanction({ key: 'km' });
      const r = ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: `s${i}` }));
      ids.push(r.appeal.id);
      k.clock.t += 1000;
    }
    const who: RawWho = { clientKey: 'km' };
    expect(k.cw.appeals.mine(who).map((a) => a.id)).toEqual([...ids].reverse());
    // a moot one is omitted
    const rows = k.rows();
    k.store.closeAppealsForGroup((rows[0] as { groupId: string }).groupId, 'x', NOW);
    expect(k.cw.appeals.mine(who).map((a) => a.id)).toEqual([ids[2], ids[1]]);
    expect(k.cw.appeals.mine({ clientKey: 'nobody' })).toEqual([]);
    expect(k.cw.appeals.mine({ ip: '203.0.113.1' })).toEqual([]);
  });

  it('shows a decided appeal as its status with the decision time, and nothing about who or why', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    const r = ok(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' }));
    k.store.decideAppeal(r.appeal.id, { status: 'reduced', at: NOW + 5, by: 'bea', reason: 'private', replacementGroupId: 'g-new' });
    const [mine] = k.cw.appeals.mine(s.who);
    expect(mine).toEqual({ id: r.appeal.id, noticeId: s.noticeId, status: 'reduced', createdAt: NOW, decidedAt: NOW + 5 });
    expect(JSON.stringify(mine)).not.toMatch(/bea|private|g-new/);
  });

  it('caps at 50', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const s = await k.sanction({ key: 'cap' });
    for (let i = 0; i < 55; i++) {
      k.store.insertAppeal({ id: `a${String(i).padStart(2, '0')}`, subject: s.subject, groupId: `gx${i}`, noticeId: `n${i}`, reportId: null, rule: '2', kind: 'chat', statement: 'x', status: 'open', createdAt: NOW + i, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    }
    const got = k.cw.appeals.mine(s.who);
    expect(got).toHaveLength(50);
    expect(got[0]?.id).toBe('a54');
  });
});

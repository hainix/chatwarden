import { describe, expect, it } from 'vitest';
import type { AppealFileResult } from '../src/appeals.js';
import { mintAppealToken } from '../src/appealLink.js';
import type { AppealDecision } from '../src/appeals.js';
import type { RawWho } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// Filing from the link: the same body as `file` (one code path), the person taken from the notice and never from the caller.

const LANDING = 'https://game.example/appeal';
const kit = (settings: Record<string, unknown> = {}) => appealsKit({ appeals: { landingUrl: LANDING } } as never, settings);
const tokenOf = (url: string | null): string => new URL(url as string).searchParams.get('t') as string;
const linkOf = (k: AppealsKit, noticeId: string): string => tokenOf(k.cw.appeals.link(noticeId));
const decision = (appealId: string, over: Partial<AppealDecision> = {}): AppealDecision => ({ appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'r', ...over });

describe('fileByLink', () => {
  it('files for the person on the notice: the row has that subject, the notice id and the group id; appeal.created is emitted once', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'chat', durationMs: 6 * HOUR });
    const res = k.cw.appeals.fileByLink(linkOf(k, s.noticeId), { statement: 'It was not me.' });
    expect(res).toEqual({ ok: true, appeal: { id: expect.any(String), noticeId: s.noticeId, status: 'open', createdAt: NOW, decidedAt: null } });
    expect(k.rows()).toHaveLength(1);
    expect(k.rows()[0]).toMatchObject({ subject: s.subject, groupId: s.groupId, noticeId: s.noticeId, reportId: s.reportId, rule: '2', kind: 'chat', statement: 'It was not me.', status: 'open' });
    expect(k.events.filter((e) => e.type === 'appeal.created')).toEqual([{ type: 'appeal.created', appealId: (res as { appeal: { id: string } }).appeal.id, createdAt: NOW, target: s.subject, kind: 'chat', rule: 2 }]);
    expect(k.cw.appeals.mine(s.who)).toHaveLength(1);
  });

  it('a merged alias files under the canonical person, whichever key the notice was made for', async () => {
    const k = await kit();
    const s = await k.sanction({ key: 'kA' });
    k.cw.rooms.seat('room-x', 'p1', { clientKey: 'kA', accountId: 'acct-1' }, 'A');
    k.cw.rooms.seat('room-x', 'p2', { clientKey: 'kB', accountId: 'acct-1' }, 'B');
    const res = k.cw.appeals.fileByLink(linkOf(k, s.noticeId), { statement: 'mine' });
    expect(res).toMatchObject({ ok: true });
    const person = k.rows()[0]?.subject;
    expect(k.cw.appeals.mine({ clientKey: 'kB', accountId: 'acct-1' })).toHaveLength(1);
    expect(person).toBeDefined();
    expect(k.cw.appeals.fileByLink(linkOf(k, s.noticeId), { statement: 'again' })).toEqual({ ok: false, refused: 'already_appealed' });
  });

  it('a bad statement writes nothing: empty, blank, 1001 characters, not a string', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = linkOf(k, s.noticeId);
    for (const statement of ['', '   ', 'y'.repeat(1001), 5, null, undefined, {}]) {
      expect(k.cw.appeals.fileByLink(token, { statement: statement as never }), String(statement)).toEqual({ ok: false, refused: 'statement_invalid' });
    }
    expect(k.cw.appeals.fileByLink(token, { statement: 'y'.repeat(1000) })).toMatchObject({ ok: true });
    expect(k.rows()).toHaveLength(1);
  });

  it('a body that is not an object is not_found, and writes nothing', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = linkOf(k, s.noticeId);
    for (const input of [null, undefined, 'x', 5]) expect(k.cw.appeals.fileByLink(token, input as never)).toEqual({ ok: false, refused: 'not_found' });
    expect(k.rows()).toHaveLength(0);
  });
});

describe('the checks run in file order', () => {
  it('off, then an invalid link (not_found), then a decided view (not_appealable), then the statement, then already_appealed', async () => {
    // off
    const off = await kit({ enabled: false });
    const o = await off.sanction();
    expect(off.cw.appeals.fileByLink(mintAppealToken('reporting-secret', o.noticeId, NOW + DAY), { statement: 'x' })).toEqual({ ok: false, refused: 'off' });
    expect(off.cw.appeals.fileByLink('garbage', { statement: '' })).toEqual({ ok: false, refused: 'off' });

    const k = await kit();
    const a = await k.sanction({ key: 'ka' });
    // an invalid link beats an invalid statement
    expect(k.cw.appeals.fileByLink('garbage', { statement: '' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.cw.appeals.fileByLink(mintAppealToken('reporting-secret', 'no-such-notice', NOW + DAY), { statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.cw.appeals.fileByLink(mintAppealToken('wrong-secret', a.noticeId, NOW + DAY), { statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    // the statement beats already_appealed
    const token = linkOf(k, a.noticeId);
    expect(k.cw.appeals.fileByLink(token, { statement: '' })).toEqual({ ok: false, refused: 'statement_invalid' });
    expect(k.cw.appeals.fileByLink(token, { statement: 'y'.repeat(1001) })).toEqual({ ok: false, refused: 'statement_invalid' });
    expect(k.rows()).toHaveLength(0);
    expect(k.cw.appeals.fileByLink(token, { statement: 'one' })).toMatchObject({ ok: true });
    expect(k.cw.appeals.fileByLink(token, { statement: '' })).toEqual({ ok: false, refused: 'statement_invalid' });
    expect(k.cw.appeals.fileByLink(token, { statement: 'two' })).toEqual({ ok: false, refused: 'already_appealed' });
    expect(k.rows()).toHaveLength(1);

    // a decided view: the link works to read, never to file (not_appealable, ahead of the statement)
    const b = await k.sanction({ key: 'kb' });
    const filed = k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'first' });
    expect(filed.ok).toBe(true);
    await k.cw.appeals.decide(decision((filed as { appeal: { id: string } }).appeal.id, { outcome: 'revoke' }));
    const decided = linkOf(k, b.noticeId);
    expect(k.cw.appeals.caseByLink(decided)).toMatchObject({ ok: true });
    expect(k.cw.appeals.fileByLink(decided, { statement: '' })).toEqual({ ok: false, refused: 'not_appealable' });
    expect(k.cw.appeals.fileByLink(decided, { statement: 'late' })).toEqual({ ok: false, refused: 'not_appealable' });
  });

  it('the weekly cap is per person: perPlayerPerWeek filings from other sanctions of the person, then rate with retryAfterMs', async () => {
    const k = await kit({ perPlayerPerWeek: 2 });
    const [a, b, c] = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
    expect(k.cw.appeals.fileByLink(linkOf(k, a.noticeId), { statement: '1' })).toMatchObject({ ok: true });
    k.clock.t += 2 * DAY;
    expect(k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: '2' })).toMatchObject({ ok: true });
    k.clock.t += DAY;
    expect(k.cw.appeals.fileByLink(linkOf(k, c.noticeId), { statement: '3' })).toEqual({ ok: false, refused: 'rate', retryAfterMs: 4 * DAY });
    expect(k.rows()).toHaveLength(2);
    // a different person is not held by it
    const other = await k.sanction({ key: 'kother' });
    expect(k.cw.appeals.fileByLink(linkOf(k, other.noticeId), { statement: 'x' })).toMatchObject({ ok: true });
  });

  it('the cap counts across two merged aliases', async () => {
    const k = await kit({ perPlayerPerWeek: 1 });
    const a = await k.sanction({ key: 'kA' });
    const b = await k.sanction({ key: 'kB' });
    k.cw.rooms.seat('room-x', 'p1', { clientKey: 'kA', accountId: 'acct-1' }, 'A');
    k.cw.rooms.seat('room-x', 'p2', { clientKey: 'kB', accountId: 'acct-1' }, 'B');
    expect(k.cw.appeals.fileByLink(linkOf(k, a.noticeId), { statement: '1' })).toMatchObject({ ok: true });
    expect(k.cw.appeals.fileByLink(linkOf(k, b.noticeId), { statement: '2' })).toMatchObject({ ok: false, refused: 'rate', retryAfterMs: 7 * DAY });
    expect(k.rows()).toHaveLength(1);
  });

  it('the cap is read live from the profile', async () => {
    const k = await kit({ perPlayerPerWeek: 1 });
    const [a, b] = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
    expect(k.cw.appeals.fileByLink(linkOf(k, a.noticeId), { statement: '1' })).toMatchObject({ ok: true });
    expect(k.cw.appeals.fileByLink(linkOf(k, b.noticeId), { statement: '2' })).toMatchObject({ refused: 'rate' });
    k.cw.policy.save({ appeals: { perPlayerPerWeek: 2 } }, { version: 0, actor: 'owner', reason: 'more' });
    expect(k.cw.appeals.fileByLink(linkOf(k, b.noticeId), { statement: '2' })).toMatchObject({ ok: true });
  });
});

describe('fileByLink and file are one path', () => {
  type Scenario = (k: AppealsKit, via: 'file' | 'link') => Promise<unknown[]>;
  const strip = (r: unknown): unknown => {
    const x = r as AppealFileResult & { appeal?: { id: string } };
    if (x.ok) return { ok: true, appeal: { ...x.appeal, id: '<id>', noticeId: '<notice>' } };
    return x;
  };
  const filer = (k: AppealsKit, via: 'file' | 'link') => (s: { who: RawWho; noticeId: string }, statement: unknown): unknown =>
    strip(via === 'file' ? k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: statement as string }) : k.cw.appeals.fileByLink(linkOf(k, s.noticeId), { statement: statement as string }));

  const scenarios: Record<string, Scenario> = {
    'statements, then a repeat': async (k, via) => {
      const s = await k.sanction();
      const f = filer(k, via);
      return [f(s, ''), f(s, '  '), f(s, 'z'.repeat(1001)), f(s, 5), f(s, 'a good one'), f(s, ''), f(s, 'again')];
    },
    'the cap and its retry time': async (k, via) => {
      const list = [await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' }), await k.sanction({ key: 'kr' })];
      const f = filer(k, via);
      const out: unknown[] = [];
      for (const s of list) {
        out.push(f(s, 'x'));
        k.clock.t += HOUR;
      }
      return out;
    },
    'a warning, an area and a ban': async (k, via) => {
      const f = filer(k, via);
      const out: unknown[] = [];
      for (const kind of ['warning', 'area', 'ban'] as const) out.push(f(await k.sanction({ kind, durationMs: kind === 'ban' ? null : HOUR }), 'x'));
      return out;
    },
    'the statement is cleaned the same': async (k, via) => {
      const s = await k.sanction();
      const f = filer(k, via);
      const out = [f(s, '\u{200b}\u{200b}'), f(s, '  hello\t\u{202e} world \n\n\n\n bye ')];
      out.push(k.rows().map((r) => r.statement));
      return out;
    },
  };

  it.each(Object.keys(scenarios))('%s: the two entrances give the same answers and write the same rows', async (name) => {
    const viaFile = await kit({ perPlayerPerWeek: 3 });
    const viaLink = await kit({ perPlayerPerWeek: 3 });
    const a = await (scenarios[name] as Scenario)(viaFile, 'file');
    const b = await (scenarios[name] as Scenario)(viaLink, 'link');
    expect(b).toEqual(a);
    const shape = (k: AppealsKit) => k.rows().map((r) => ({ kind: r.kind, rule: r.rule, statement: r.statement, status: r.status, createdAt: r.createdAt, decidedAt: r.decidedAt })).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    expect(shape(viaLink)).toEqual(shape(viaFile));
    expect(viaLink.events.map((e) => e.type)).toEqual(viaFile.events.map((e) => e.type));
  });

  it('a store failure reads as not_found on both, logged by class only', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = linkOf(k, s.noticeId);
    k.store.insertAppeal = () => {
      throw new RangeError('disk is full');
    };
    expect(k.cw.appeals.fileByLink(token, { statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.logged.filter(([ev]) => ev === 'chatwarden.appeal_failed')).toHaveLength(2);
    expect(JSON.stringify(k.logged)).not.toContain('disk is full');
  });
});

describe('parallel filings', () => {
  it('two parallel fileByLink for one notice: one ok, one already_appealed', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = linkOf(k, s.noticeId);
    const results = await Promise.all([Promise.resolve().then(() => k.cw.appeals.fileByLink(token, { statement: 'a' })), Promise.resolve().then(() => k.cw.appeals.fileByLink(token, { statement: 'b' }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, refused: 'already_appealed' }]);
    expect(k.rows()).toHaveLength(1);
  });

  it('a link and a direct file racing for one notice: still one row', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = linkOf(k, s.noticeId);
    const results = await Promise.all([Promise.resolve().then(() => k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'a' })), Promise.resolve().then(() => k.cw.appeals.fileByLink(token, { statement: 'b' }))]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(k.rows()).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import type { AppealDecision } from '../src/appeals.js';
import type { NoticeDelivery } from '../src/delivery.js';
import type { Matcher, RawWho } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// Every way a notice is made, counted: a moderator decision, an automatic restriction, an appeal outcome. Assertions are COUNTS per notice id.

const LANDING = 'https://game.example/appeal';
const MIN = 60_000;

const matcher: Matcher = {
  match: (t) => {
    const s = t.toLowerCase();
    if (s.includes('zorbak')) return { termId: 'syn:zorbak' };
    if (s.includes('vlemmo')) return { termId: 'syn:vlemmo' };
    if (s.includes('quissel')) return { termId: 'syn:quissel' };
    return null;
  },
};

async function kit(settings: Record<string, unknown> = { perPlayerPerWeek: 20 }, over: Record<string, unknown> = {}, landing = true) {
  const calls: NoticeDelivery[] = [];
  const hook: { onCall?: (d: NoticeDelivery) => void } = {};
  const k = await appealsKit(
    { matcher, ...(landing ? { appeals: { landingUrl: LANDING } } : {}), notices: { deliver: (d: NoticeDelivery) => (calls.push(d), hook.onCall?.(d)) }, ...over } as never,
    settings,
  );
  return { k, calls, hook };
}
const withAccount = (k: AppealsKit, key: string, accountId = `acct-${key}`): string => {
  k.cw.rooms.seat(`acct-room-${key}`, 'p1', { clientKey: key, accountId }, 'Acct');
  return accountId;
};
const count = (calls: NoticeDelivery[], noticeId: string): number => calls.filter((d) => d.noticeId === noticeId).length;
const tokenOf = (url: string | null): string => new URL(url as string).searchParams.get('t') as string;
const decision = (appealId: string, over: Partial<AppealDecision> = {}): AppealDecision => ({ appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'private second look', ...over });

async function filed(k: AppealsKit, key: string, o: Parameters<AppealsKit['sanction']>[0] = {}) {
  withAccount(k, key);
  const s = await k.sanction({ key, ...o });
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'It was not me.' });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return { ...s, appealId: r.appeal.id };
}
const pendingOf = (k: AppealsKit, who: RawWho, kind: string) => k.cw.notices.pending(who).find((n) => n.kind === kind);

describe('a decision made by a moderator', () => {
  it('one action: exactly one delivery, kind sanction, source moderator, automated false', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'p-one');
    const s = await k.sanction({ key: 'p-one' });
    expect(calls).toHaveLength(1);
    expect(count(calls, s.noticeId)).toBe(1);
    expect(calls[0]).toMatchObject({ kind: 'sanction', sanction: { source: 'moderator', automated: false, kind: 'chat' } });
    // the reporter's own thank-you notice is not delivered
    const thanks = pendingOf(k, { clientKey: 'key-reporter' }, 'report_outcome');
    expect(thanks).toBeDefined();
    expect(count(calls, (thanks as { id: string }).id)).toBe(0);
  });

  it('a decision naming two people: two deliveries, one each, to their own accounts', async () => {
    const { k, calls } = await kit();
    const a = withAccount(k, 'two-a');
    const b = withAccount(k, 'two-b');
    const t = k.table({ target: 'two-a', reporter: 'key-reporter' });
    k.cw.rooms.seat(t.room, 'p3', { clientKey: 'two-b' }, 'Other');
    k.cw.chat.accept(t.room, 'p3', 'hello there');
    k.cw.chat.accept(t.room, 'p2', 'hello back');
    const other = k.cw.rooms.subjectAt(t.room, 'p3') as string;
    const f = await k.submit(t.room);
    if (!f.ok) throw new Error('report refused');
    const res = await k.cw.decide({
      reportId: f.reportId,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'both',
      actions: [
        { subject: t.target, kind: 'warning', durationMs: null, rule: 2, lineIds: [] },
        { subject: other, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] },
      ],
    } as never);
    if (!res.ok) throw new Error(`refused ${res.error}`);
    expect(calls).toHaveLength(2);
    for (const g of res.groups) expect(count(calls, g.noticeId as string)).toBe(1);
    expect(calls.map((d) => d.to.accountId).sort()).toEqual([a, b].sort());
  });

  it('a warning delivers (no end); a note and a report outcome deliver nothing', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'p-warn');
    const w = await k.sanction({ key: 'p-warn', kind: 'warning' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ noticeId: w.noticeId, sanction: { kind: 'warning', until: null } });
    // a note: a decision with a note action writes no notice and delivers nothing
    withAccount(k, 'p-note');
    const f = await k.file({}, { target: 'p-note' });
    const res = await k.cw.decide({ reportId: f.id, verdict: 'noted', actor: 'mod_ann', reason: 'watch', actions: [{ subject: f.target, kind: 'note', durationMs: null, rule: 2, lineIds: [] }] } as never);
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // a dismissal that thanks nobody and sanctions nobody
    const g = await k.file({}, { target: 'p-none' });
    expect((await k.cw.decide({ reportId: g.id, verdict: 'no_action', actor: 'mod_ann', actions: [] } as never)).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('a source coop and a source api decision deliver once each, with that source', async () => {
    const { k, calls } = await kit();
    for (const source of ['coop', 'api'] as const) {
      const key = `p-${source}`;
      withAccount(k, key);
      const f = await k.file({}, { target: key });
      const res = await k.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', source, actions: [{ subject: f.target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] } as never);
      if (!res.ok) throw new Error(`refused ${res.error}`);
      expect(count(calls, res.groups[0]?.noticeId as string)).toBe(1);
    }
    expect(calls.map((d) => d.sanction.source)).toEqual(['coop', 'api']);
    expect(calls.every((d) => d.sanction.automated === false)).toBe(true);
  });

  it('a replayed decision (the same idempotency key) delivers nothing more', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'p-replay');
    const f = await k.file({}, { target: 'p-replay' });
    const input = { reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] } as never;
    const first = await k.cw.decide(input);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(calls).toHaveLength(1);
    const again = await k.cw.decide(input);
    expect(again).toMatchObject({ ok: true, replay: true });
    expect(calls).toHaveLength(1);
  });

  it('a decision refused as invalid, and one whose transaction fails, deliver nothing', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'p-bad');
    const f = await k.file({}, { target: 'p-bad' });
    const invalid = await k.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: -5, rule: 2, lineIds: [] }] } as never);
    expect(invalid).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toEqual([]);
    const real = k.store.closeReport.bind(k.store);
    k.store.closeReport = () => {
      throw new Error('disk full');
    };
    await expect(k.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] } as never)).rejects.toThrow('disk full');
    expect(calls).toEqual([]);
    expect(k.store.rawNotices().filter((n) => n.kind === 'chat')).toEqual([]);
    // the control: once the store works the same decision delivers once
    k.store.closeReport = real;
    const ok = await k.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'mod_ann', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: HOUR, rule: 2, lineIds: [] }] } as never);
    expect(ok).toMatchObject({ ok: true });
    expect(calls).toHaveLength(1);
  });
});

describe('an automatic restriction', () => {
  it('three blocked lines deliver exactly once: source auto_filter, automated true; the lines after it do not deliver again', async () => {
    const { k, calls } = await kit();
    const t = k.table({ target: 'key-auto' });
    const account = withAccount(k, 'key-auto');
    for (const word of ['zorbak', 'vlemmo']) k.cw.chat.accept(t.room, 'p2', word);
    expect(calls).toEqual([]);
    k.cw.chat.accept(t.room, 'p2', 'quissel');
    expect(calls).toHaveLength(1);
    const d = calls[0] as NoticeDelivery;
    expect(d).toMatchObject({ kind: 'sanction', to: { accountId: account }, sanction: { kind: 'chat', source: 'auto_filter', automated: true, until: NOW + 30 * MIN } });
    const notice = k.store.rawNotices().find((n) => n.id === d.noticeId);
    expect(notice?.kind).toBe('chat');
    // more blocked lines while restricted: refused, no new restriction, no new delivery
    for (const word of ['zorbak', 'vlemmo', 'quissel', 'zorbak']) k.cw.chat.accept(t.room, 'p2', word);
    expect(calls).toHaveLength(1);
    expect(count(calls, d.noticeId)).toBe(1);
  });

  it('the email never carries the blocked lines the notice keeps', async () => {
    const { k, calls } = await kit();
    const t = k.table({ target: 'key-auto2' });
    withAccount(k, 'key-auto2');
    for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
    const d = calls[0] as NoticeDelivery;
    for (const part of [d.text, d.html, d.subject]) for (const w of ['zorbak', 'vlemmo', 'quissel']) expect(part).not.toContain(w);
  });

  it('the person is unnamed: no account, no delivery, and the restriction still stands', async () => {
    const { k, calls } = await kit();
    const t = k.table({ target: 'key-auto3' });
    for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
    expect(calls).toEqual([]);
    expect(k.cw.chat.accept(t.room, 'p2', 'hello')).toHaveProperty('refuse');
  });
});

describe('an appeal outcome', () => {
  it('upheld: one appeal_outcome delivery with the stored reason and the original sanction; its text carries the link', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-up', { kind: 'chat', durationMs: 6 * HOUR });
    expect(calls).toHaveLength(1); // the sanction
    k.clock.t = NOW + HOUR;
    expect(await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }))).toEqual({ ok: true, status: 'upheld' });
    expect(calls).toHaveLength(2);
    const d = calls[1] as NoticeDelivery;
    const outcomeNotice = pendingOf(k, s.who, 'appeal_upheld') as { id: string };
    expect(d).toMatchObject({
      kind: 'appeal_outcome',
      noticeId: outcomeNotice.id,
      to: { accountId: 'acct-a-up' },
      outcome: { status: 'upheld', reason: 'rule_applies' },
      sanction: { kind: 'chat', until: NOW + 6 * HOUR, rule: 2, source: 'moderator', automated: false },
    });
    expect(d.subject).toBe('We reviewed your appeal: the decision stands');
    expect(d.text).toContain('Reason: The rule applies to what was said.');
    expect(d.appealUrl).toMatch(/^https:\/\/game\.example\/appeal\?t=/);
    expect(d.text).toContain(d.appealUrl as string);
    expect(d.text).toContain('You can see the decision here.');
    expect(d.text).not.toContain('If you think this was a mistake');
    expect(d.text).not.toContain('On your record now');
    expect(count(calls, outcomeNotice.id)).toBe(1);
  });

  it('reduced: exactly one delivery (not two), the replacement kind and end, and nothing for the replacement notice', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-red', { kind: 'ban', durationMs: null });
    expect(calls).toHaveLength(1);
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'lighter_fits', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced' });
    expect(calls).toHaveLength(2);
    const d = calls[1] as NoticeDelivery;
    expect(d).toMatchObject({
      kind: 'appeal_outcome',
      outcome: { status: 'reduced', reason: 'lighter_fits' },
      sanction: { kind: 'chat', until: NOW + 2 * HOUR, rule: 2, source: 'moderator', automated: false },
    });
    expect(d.text).toContain('On your record now: Your chat is turned off');
    const replacement = k.store.rawNotices().find((n) => n.kind === 'chat' && n.id !== s.noticeId);
    expect(replacement).toBeDefined();
    expect(count(calls, (replacement as { id: string }).id)).toBe(0);
    expect(calls.filter((x) => x.kind === 'appeal_outcome')).toHaveLength(1);
  });

  it('reduced to a warning: the standing line has no end', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-red2', { kind: 'chat', durationMs: 6 * HOUR });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'first_offence', to: { kind: 'warning', durationMs: null } }));
    const d = calls[1] as NoticeDelivery;
    expect(d.sanction).toMatchObject({ kind: 'warning', until: null });
    expect(d.text).toContain('On your record now: You have a warning');
  });

  it('revoked: one delivery, the original sanction, outcome revoked; no sanction link but the decided-view link when a landing page is set', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-rev', { kind: 'chat', durationMs: 6 * HOUR });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    expect(calls).toHaveLength(2);
    const d = calls[1] as NoticeDelivery;
    expect(d).toMatchObject({ kind: 'appeal_outcome', outcome: { status: 'revoked', reason: 'mistake' }, sanction: { kind: 'chat', until: NOW + 6 * HOUR, source: 'moderator' } });
    expect(d.text).toContain('Reason: This was our mistake. We are sorry.');
    expect(d.text).not.toContain('On your record now');
    expect(d.text).not.toContain('If you think this was a mistake');
    // the link is the decided view of the withdrawn notice
    expect(d.appealUrl).not.toBeNull();
    const shown = k.cw.appeals.caseByLink(tokenOf(d.appealUrl));
    expect(shown).toMatchObject({ ok: true, case: { canAppeal: false, standing: null, appeal: { status: 'revoked', reason: 'mistake' } } });
  });

  it('revoked with no landing page: the link is null and the text has no link', async () => {
    const { k, calls } = await kit({ perPlayerPerWeek: 20 }, {}, false);
    const s = await filed(k, 'a-rev2', { kind: 'chat', durationMs: 6 * HOUR });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }));
    const d = calls[1] as NoticeDelivery;
    expect(d.appealUrl).toBeNull();
    expect(d.text).not.toContain('http');
    expect(d.text).toContain('Reason: We looked at the whole conversation and lifted it.');
  });

  it('a decision without a code is delivered with the default reason', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-def');
    await k.cw.appeals.decide(decision(s.appealId));
    expect((calls[1] as NoticeDelivery).outcome).toEqual({ status: 'upheld', reason: 'context_considered' });
  });

  it('the private reason, the statement and the moderator are never in the delivery', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-priv', { actor: 'mod_ann' });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake', actor: 'senior_bea', reason: 'private second look' }));
    const json = JSON.stringify(calls[1]);
    for (const secret of ['private second look', 'senior_bea', 'mod_ann', 'It was not me.', s.subject, s.groupId, s.reportId]) expect(json, secret).not.toContain(secret);
  });

  it('a decision for a person with no account delivers nothing and logs the skip', async () => {
    const { k, calls } = await kit();
    const s = await k.sanction({ key: 'a-none' });
    const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'x' });
    await k.cw.appeals.decide(decision((r as { appeal: { id: string } }).appeal.id));
    expect(calls).toEqual([]);
    expect(k.logged.filter(([e]) => e === 'chatwarden.delivery_skipped_no_account').length).toBeGreaterThan(0);
  });

  it('a moot close (a moderator revokes the sanction first) delivers nothing; a failed decision delivers nothing', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-moot');
    expect(calls).toHaveLength(1);
    await k.cw.sanctions.revoke(s.groupId, 'mod_cy', 'lifted');
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('moot');
    expect(calls).toHaveLength(1);
    expect(await k.cw.appeals.decide(decision(s.appealId))).toEqual({ ok: false, error: 'gone' });
    expect(calls).toHaveLength(1);
    // already decided
    const t = await filed(k, 'a-twice');
    expect(calls).toHaveLength(2);
    await k.cw.appeals.decide(decision(t.appealId));
    expect(calls).toHaveLength(3);
    expect(await k.cw.appeals.decide(decision(t.appealId, { outcome: 'revoke' }))).toEqual({ ok: false, error: 'already_decided' });
    expect(await k.cw.appeals.decide(decision(t.appealId, { reasonCode: 'mistake' }))).toEqual({ ok: false, error: 'invalid_reason' });
    expect(await k.cw.appeals.decide({ appealId: 'nope' } as never)).toEqual({ ok: false, error: 'invalid' });
    expect(calls).toHaveLength(3);
  });

  it('a decision whose transaction fails delivers nothing', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'a-fail');
    const real = k.store.decideAppeal.bind(k.store);
    k.store.decideAppeal = () => {
      throw new Error('disk full');
    };
    await expect(k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }))).rejects.toThrow('disk full');
    expect(calls).toHaveLength(1);
    k.store.decideAppeal = real;
  });

  it('an automatic restriction that is appealed and revoked delivers its outcome to the account, with the automatic source on the sanction', async () => {
    const { k, calls } = await kit();
    const t = k.table({ target: 'key-auto-appeal' });
    withAccount(k, 'key-auto-appeal');
    for (const word of ['zorbak', 'vlemmo', 'quissel']) k.cw.chat.accept(t.room, 'p2', word);
    const first = calls[0] as NoticeDelivery;
    const r = k.cw.appeals.file({ clientKey: 'key-auto-appeal' }, { noticeId: first.noticeId, statement: 'a filter false alarm' });
    expect(r.ok).toBe(true);
    await k.cw.appeals.decide(decision((r as { appeal: { id: string } }).appeal.id, { outcome: 'revoke', reasonCode: 'not_a_violation' }));
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ kind: 'appeal_outcome', sanction: { kind: 'chat', source: 'auto_filter', automated: true } });
  });
});

describe('the links in a delivery work', () => {
  it('the sanction delivery appealUrl: openLink on its token returns the notice id', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'l-one');
    const s = await k.sanction({ key: 'l-one' });
    const d = calls[0] as NoticeDelivery;
    expect(k.cw.appeals.openLink(tokenOf(d.appealUrl))).toMatchObject({ ok: true, noticeId: s.noticeId });
    expect(k.cw.appeals.caseByLink(tokenOf(d.appealUrl))).toMatchObject({ ok: true, case: { canAppeal: true } });
  });

  it('the outcome delivery appealUrl: caseByLink shows the decided appeal', async () => {
    const { k, calls } = await kit();
    const s = await filed(k, 'l-two');
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'evidence_clear' }));
    const d = calls[1] as NoticeDelivery;
    expect(k.cw.appeals.caseByLink(tokenOf(d.appealUrl))).toMatchObject({ ok: true, case: { canAppeal: false, appeal: { status: 'upheld', reason: 'evidence_clear' } } });
  });
});

describe('when it happens', () => {
  it('after the commit: when the hook runs, the decision and its notice are already readable', async () => {
    const { k, calls, hook } = await kit();
    withAccount(k, 'w-one');
    const seen: Array<{ notice: boolean; groupRow: boolean }> = [];
    hook.onCall = (d) => {
      seen.push({ notice: k.store.loadNotice(d.noticeId) !== null, groupRow: k.store.loadSanctionSubjectRow((k.store.loadNotice(d.noticeId) as { groupId: string }).groupId) !== null });
    };
    await k.sanction({ key: 'w-one' });
    expect(seen).toEqual([{ notice: true, groupRow: true }]);
    expect(calls).toHaveLength(1);
  });

  it('after the commit of an appeal: the appeal is already decided, the outcome notice readable, the sanction withdrawn', async () => {
    const { k, calls, hook } = await kit();
    const s = await filed(k, 'w-two', { kind: 'chat', durationMs: 6 * HOUR });
    const snapshots: Array<{ status: string | undefined; outcome: boolean; withdrawn: boolean; link: boolean }> = [];
    hook.onCall = (d) => {
      if (d.kind !== 'appeal_outcome') return;
      snapshots.push({
        status: k.store.loadAppeal(s.appealId)?.status,
        outcome: k.store.loadNotice(d.noticeId) !== null,
        withdrawn: k.store.loadNotice(s.noticeId)?.withdrawnAt !== null,
        link: k.cw.appeals.link(s.noticeId) !== null,
      });
    };
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    expect(snapshots).toEqual([{ status: 'revoked', outcome: true, withdrawn: true, link: true }]);
    expect(calls).toHaveLength(2);
  });
});

describe('two accounts, one person', () => {
  it('the delivery goes to the account seen most recently', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'm-one', 'acct-old');
    k.clock.t += 3 * HOUR;
    withAccount(k, 'm-one', 'acct-new');
    k.clock.t += 3 * HOUR;
    await k.sanction({ key: 'm-one' });
    expect(calls[0]?.to).toEqual({ accountId: 'acct-new' });
  });

  it('merged people: the newest account on any of them', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'm-a', 'acct-a');
    k.clock.t += 3 * HOUR;
    withAccount(k, 'm-b', 'acct-b');
    k.clock.t += 3 * HOUR;
    // m-a signs in with acct-b: one person now, whose newest account is acct-b
    k.cw.rooms.seat('merge-room', 'p1', { clientKey: 'm-a', accountId: 'acct-b' }, 'A');
    k.clock.t += 3 * HOUR;
    await k.sanction({ key: 'm-a' });
    expect(calls[0]?.to).toEqual({ accountId: 'acct-b' });
    // seen again later on the old account: it is now the newest
    k.clock.t += 3 * HOUR;
    k.cw.rooms.seat('merge-room-2', 'p1', { clientKey: 'm-a', accountId: 'acct-a' }, 'A');
    k.clock.t += 3 * HOUR;
    await k.sanction({ key: 'm-b' });
    expect(calls[1]?.to).toEqual({ accountId: 'acct-a' });
  });
});

describe('time and days', () => {
  it('a restriction of three days reads in days in the subject', async () => {
    const { k, calls } = await kit();
    withAccount(k, 'd-one');
    await k.sanction({ key: 'd-one', kind: 'ban', durationMs: 7 * DAY });
    expect(calls[0]?.subject).toBe('You have been banned for 7 days');
  });
});

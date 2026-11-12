import { describe, expect, it } from 'vitest';
import type { AppealDecision } from '../src/appeals.js';
import type { RawWho } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// Deciding an appeal: uphold, reduce, revoke. One transaction, a second moderator, atomic, announced after the commit.

type Filed = Awaited<ReturnType<AppealsKit['sanction']>> & { appealId: string };

/** Sanction a player, file an appeal against it, and return both. */
async function filed(k: AppealsKit, o: Parameters<AppealsKit['sanction']>[0] = {}, statement = 'It was not me.'): Promise<Filed> {
  const s = await k.sanction(o);
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return { ...s, appealId: r.appeal.id };
}
const decision = (appealId: string, over: Partial<AppealDecision> = {}): AppealDecision => ({ appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'the rule applied', ...over });
const kinds = (k: AppealsKit, who: RawWho): string[] => k.cw.notices.pending(who).map((n) => n.kind);

describe('uphold', () => {
  it('status, an appeal_upheld notice, the sanction untouched', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const res = await k.cw.appeals.decide(decision(s.appealId));
    expect(res).toEqual({ ok: true, status: 'upheld' });
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'upheld', decidedBy: 'senior_bea', decidedAt: NOW, decisionReason: 'the rule applied', replacementGroupId: null });
    // the sanction stands: the group is live, nothing was written beside it
    expect(k.store.loadSanctions(NOW).filter((r) => r.groupId === s.groupId)).not.toHaveLength(0);
    expect(k.store.rawSanctions()).toHaveLength(1);
    const outcome = k.cw.notices.pending(s.who).find((n) => n.kind === 'appeal_upheld');
    expect(outcome).toMatchObject({ rule: 2, refCode: s.refCode, excerpt: [], mustAcknowledge: false, until: null });
    // the original notice is still there, not withdrawn
    expect(k.store.rawNotices().find((n) => n.id === s.noticeId)?.withdrawnAt).toBeNull();
    expect(k.cw.notices.record(s.who).map((n) => n.kind)).toEqual(['ban']);
  });
});

describe('revoke', () => {
  it('the group is revoked, the original notice withdrawn, an appeal_revoked notice made, and chat is accepted again at once', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    expect(k.cw.chat.accept(s.room, 'p2', 'hello')).toHaveProperty('refuse');
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }));
    expect(res).toEqual({ ok: true, status: 'revoked' });
    expect(k.store.rawSanctions().every((r) => r.revokedAt !== null)).toBe(true);
    expect(k.store.rawNotices().find((n) => n.id === s.noticeId)?.withdrawnAt).toBe(NOW);
    expect(kinds(k, s.who)).toEqual(['appeal_revoked']);
    expect(k.cw.notices.record(s.who)).toEqual([]);
    expect(k.cw.chat.accept(s.room, 'p2', 'hello again')).toHaveProperty('deliver');
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'revoked', replacementGroupId: null });
  });
});

describe('reduce', () => {
  it('the replacement has the original start, rule and room; a lighter kind is accepted', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null, rule: 3 });
    k.clock.t += 2 * DAY;
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: 12 * HOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced', replacementGroupId: expect.any(String) });
    const repl = k.store.rawSanctions().find((r) => r.groupId === (res as { replacementGroupId: string }).replacementGroupId && r.targetType === 'subject');
    expect(repl).toMatchObject({ kind: 'chat', startsAt: NOW, endsAt: NOW + 12 * HOUR, rule: '3', actor: 'senior_bea', source: 'moderator', automated: false, pending: false });
    const orig = k.store.rawSanctions().find((r) => r.groupId === s.groupId && r.targetType === 'subject');
    expect(orig?.revokedAt).toBe(NOW + 2 * DAY);
    expect(repl?.roomId).toBe(orig?.roomId);
    expect(repl?.roomId).not.toBeNull();
    expect(repl?.value).toBe(s.subject);
    expect(k.store.rawSanctions().filter((r) => r.groupId === repl?.groupId && r.targetType === 'ip')).toEqual([]);
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'reduced', replacementGroupId: repl?.groupId });
  });

  it('the same kind and shorter is accepted; equal, longer, heavier, note, ip, permanent-to-permanent and a warning source are refused invalid', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const reduce = (id: string, to: unknown) => k.cw.appeals.decide(decision(id, { outcome: 'reduce', to: to as never }));
    const a = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    for (const to of [
      { kind: 'chat', durationMs: 6 * HOUR },
      { kind: 'chat', durationMs: 7 * HOUR },
      { kind: 'chat', durationMs: null },
      { kind: 'area', durationMs: HOUR },
      { kind: 'ban', durationMs: HOUR },
      { kind: 'note', durationMs: null },
      { kind: 'ip', durationMs: HOUR },
      { kind: 'warning', durationMs: HOUR },
      { kind: 'chat', durationMs: 0 },
      { kind: 'chat', durationMs: -5 },
      { kind: 'chat', durationMs: Number.NaN },
      { kind: 'chat', durationMs: 0.5 },
      { kind: 'chat', durationMs: HOUR + 0.5 },
      { kind: 'chat', durationMs: Number.POSITIVE_INFINITY },
      { kind: 'chat', durationMs: Number.MAX_SAFE_INTEGER + 2 },
      { kind: 'ban', durationMs: 1.5 },
      { kind: 'chat', durationMs: 400 * DAY },
      { kind: 'chat' },
      null,
      5,
    ]) {
      expect(await reduce(a.appealId, to), JSON.stringify(to)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(k.store.loadAppeal(a.appealId)?.status).toBe('open');
    expect(await reduce(a.appealId, { kind: 'chat', durationMs: 5 * HOUR })).toMatchObject({ ok: true, status: 'reduced' });
    // permanent to permanent, and a permanent to 24 hours
    const p = await filed(k, { kind: 'ban', durationMs: null });
    expect(await reduce(p.appealId, { kind: 'ban', durationMs: null })).toEqual({ ok: false, error: 'invalid' });
    expect(await reduce(p.appealId, { kind: 'ban', durationMs: 24 * HOUR })).toMatchObject({ ok: true, status: 'reduced' });
    // a lower kind with any length, or permanent
    const q = await filed(k, { kind: 'ban', durationMs: 7 * DAY });
    expect(await reduce(q.appealId, { kind: 'chat', durationMs: null })).toMatchObject({ ok: true });
    // a warning cannot be reduced; a reduce to a warning needs no length
    const w = await filed(k, { kind: 'warning' });
    expect(await reduce(w.appealId, { kind: 'warning', durationMs: null })).toEqual({ ok: false, error: 'invalid' });
    const c = await filed(k, { kind: 'area', durationMs: DAY });
    expect(await reduce(c.appealId, { kind: 'warning', durationMs: null })).toMatchObject({ ok: true, status: 'reduced' });
  });

  it('reduce of a 7-day ban given 6 days ago to 24 hours writes a replacement ending at the original end or earlier, already ended when the new length has passed, never later than the original', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: 7 * DAY });
    k.clock.t += 6 * DAY;
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'ban', durationMs: DAY } }));
    expect(res).toMatchObject({ ok: true });
    const repl = k.store.rawSanctions().find((r) => r.groupId === (res as { replacementGroupId: string }).replacementGroupId);
    // the start is kept (so the ladder does not restart) and 24 hours from it is five days ago: written already ended, still a lighter ban
    expect(repl).toMatchObject({ kind: 'ban', startsAt: NOW, endsAt: NOW + DAY });
    expect(repl?.endsAt as number).toBeLessThan(k.clock.t);
    expect(repl?.endsAt as number).toBeLessThanOrEqual(NOW + 7 * DAY);
    expect(k.cw.chat.accept(s.room, 'p2', 'hi')).toHaveProperty('deliver');
    // a length longer than what is left is capped at the original end: 7 days given, reduced to a 6-day chat restriction (still a lower kind)
    const t = await filed(k, { kind: 'ban', durationMs: 7 * DAY });
    const r2 = await k.cw.appeals.decide(decision(t.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: 30 * DAY } }));
    const repl2 = k.store.rawSanctions().find((r) => r.groupId === (r2 as { replacementGroupId: string }).replacementGroupId);
    expect(repl2?.endsAt).toBe(k.store.rawSanctions().find((r) => r.groupId === t.groupId)?.endsAt);
    expect(repl2?.endsAt as number).toBeLessThanOrEqual((k.store.rawSanctions().find((r) => r.groupId === t.groupId)?.endsAt as number));
  });

  it('a reduction from a permanent ban to a lower kind is permanent; a warning replacement ends where it starts', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const a = await filed(k, { kind: 'ban', durationMs: null });
    const r1 = await k.cw.appeals.decide(decision(a.appealId, { outcome: 'reduce', to: { kind: 'area', durationMs: null } }));
    expect(k.store.rawSanctions().find((r) => r.groupId === (r1 as { replacementGroupId: string }).replacementGroupId)).toMatchObject({ kind: 'area', endsAt: null, startsAt: NOW });
    const b = await filed(k, { kind: 'chat', durationMs: DAY });
    const r2 = await k.cw.appeals.decide(decision(b.appealId, { outcome: 'reduce', to: { kind: 'warning', durationMs: null } }));
    expect(k.store.rawSanctions().find((r) => r.groupId === (r2 as { replacementGroupId: string }).replacementGroupId)).toMatchObject({ kind: 'warning', startsAt: NOW, endsAt: NOW });
  });

  it('the ladder step after a reduce-to-warning is computed from the original start', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: 7 * DAY });
    k.clock.t += 6 * DAY;
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'warning', durationMs: null } }));
    const group = (res as { replacementGroupId: string }).replacementGroupId;
    const row = k.store.loadSubjectActions(0).find((r) => r.groupId === group);
    expect(row?.startsAt).toBe(NOW);
    // a window that begins after the original start does not see it; one that reaches back does
    expect(k.store.loadSubjectActions(NOW + DAY).some((r) => r.groupId === group)).toBe(false);
    expect(k.store.loadSubjectActions(NOW - DAY).some((r) => r.groupId === group)).toBe(true);
  });

  it("the replacement's own notice and the outcome notice are both created and announced after the commit", async () => {
    const told: Array<{ count: number; status: string | undefined }> = [];
    const k = await appealsKit({
      platform: {
        identify: (ctx: unknown) => ctx as RawWho,
        notify: (_who: unknown, e: { count: number }) => {
          told.push({ count: e.count, status: undefined });
        },
      },
    } as never);
    const s = await filed(k, { kind: 'ban', durationMs: null });
    told.length = 0;
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: DAY } }));
    expect(kinds(k, s.who).sort()).toEqual(['appeal_reduced', 'chat']);
    // one announcement for the person, after everything was written: the original is withdrawn, so two are pending
    expect(told).toEqual([{ count: 2, status: undefined }]);
    const reduced = k.cw.notices.pending(s.who).find((n) => n.kind === 'appeal_reduced');
    const replacement = k.cw.notices.pending(s.who).find((n) => n.kind === 'chat');
    expect(reduced).toMatchObject({ rule: 2, refCode: s.refCode, excerpt: [], mustAcknowledge: false });
    expect(replacement).toMatchObject({ until: NOW + DAY, rule: 2 });
    expect(replacement?.refCode).not.toBe(s.refCode);
    // the replacement can be appealed once
    expect(k.cw.appeals.file(s.who, { noticeId: (replacement as { id: string }).id, statement: 'still unfair' })).toMatchObject({ ok: true });
  });
});

describe('atomicity and races', () => {
  it('a throwing store at each step leaves the appeal open, the sanction untouched and no notice', async () => {
    for (const step of ['revokeSanctionGroup', 'insertSanctionGroup', 'insertNotice', 'withdrawNoticeGroup', 'decideAppeal'] as const) {
      const k = await appealsKit();
      const s = await filed(k, { kind: 'ban', durationMs: null });
      const rawBefore = JSON.stringify([k.store.rawSanctions(), k.store.rawNotices(), k.store.loadAppeal(s.appealId)]);
      const real = (k.store as unknown as Record<string, (...a: unknown[]) => unknown>)[step] as (...a: unknown[]) => unknown;
      // fail the LAST call of the step (the replacement's notice is the second insertNotice, so the outcome notice is the third)
      let calls = 0;
      const target = step === 'insertNotice' ? 2 : 1;
      (k.store as unknown as Record<string, unknown>)[step] = (...a: unknown[]) => {
        calls += 1;
        if (calls === target) throw new Error(`boom at ${step}`);
        return real.apply(k.store, a);
      };
      await expect(k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: DAY } })), step).rejects.toThrow(`boom at ${step}`);
      expect(JSON.stringify([k.store.rawSanctions(), k.store.rawNotices(), k.store.loadAppeal(s.appealId)]), step).toBe(rawBefore);
      expect(k.store.countOpenAppeals()).toBe(1);
      // the in-memory index was not touched: still restricted
      expect(k.cw.chat.accept(s.room, 'p2', 'hi'), step).toHaveProperty('refuse');
      expect(k.events.filter((e) => e.type === 'appeal.decided'), step).toEqual([]);
      expect(JSON.stringify(k.logged)).not.toContain('boom');
    }
  });

  it('a second decide is already_decided; two concurrent decides leave one outcome', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const [a, b] = await Promise.all([k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' })), k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', actor: 'owner_cy' }))]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toEqual({ ok: false, error: 'already_decided' });
    expect(k.events.filter((e) => e.type === 'appeal.decided')).toHaveLength(1);
    expect(await k.cw.appeals.decide(decision(s.appealId, { actor: 'owner_cy' }))).toEqual({ ok: false, error: 'already_decided' });
    expect(kinds(k, s.who)).toHaveLength(1);
  });

  it('an unknown or malformed id is not_found; a decision that is not well formed is invalid', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    expect(await k.cw.appeals.decide(decision('no-such-appeal'))).toEqual({ ok: false, error: 'not_found' });
    for (const bad of [
      { outcome: 'dismiss' },
      { outcome: 'reduce' },
      { outcome: 'uphold', to: { kind: 'chat', durationMs: HOUR } },
      { outcome: 'revoke', to: { kind: 'chat', durationMs: HOUR } },
      { reason: '' },
      { reason: '   ' },
      { reason: 'x'.repeat(501) },
      { reason: 5 },
      { actor: '' },
      { actor: 'has space' },
      { actor: 5 },
      { appealId: 5 },
    ]) {
      expect(await k.cw.appeals.decide({ ...decision(s.appealId), ...bad } as never), JSON.stringify(bad)).toEqual({ ok: false, error: 'invalid' });
    }
    expect(await k.cw.appeals.decide(null as never)).toEqual({ ok: false, error: 'invalid' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('open');
    // a reason of exactly 500 characters is fine
    expect(await k.cw.appeals.decide(decision(s.appealId, { reason: 'x'.repeat(500) }))).toMatchObject({ ok: true });
  });

  it('with appeals off, decide answers not_found', async () => {
    const k = await appealsKit({}, { enabled: false });
    expect(await k.cw.appeals.decide(decision('x'))).toEqual({ ok: false, error: 'not_found' });
  });
});

describe('independence', () => {
  it('the original actor gets same_decider; another actor passes', async () => {
    const k = await appealsKit();
    const s = await filed(k, { actor: 'mod_ann' });
    expect(await k.cw.appeals.decide(decision(s.appealId, { actor: 'mod_ann', outcome: 'revoke' }))).toEqual({ ok: false, error: 'same_decider' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('open');
    expect(k.store.rawSanctions().every((r) => r.revokedAt === null)).toBe(true);
    expect(await k.cw.appeals.decide(decision(s.appealId, { actor: 'mod_bea', outcome: 'revoke' }))).toMatchObject({ ok: true });
  });

  it('an automated sanction has no decider: anyone passes, whatever the actor field says', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    const auto = await k.cw.sanctions.apply({ kind: 'chat', subject: s.subject, includeIp: false, durationMs: HOUR, reason: 'r', actor: 'chatwarden', source: 'auto_filter', automated: true, rule: 1 });
    k.store.insertAppeal({ id: 'ap-auto', subject: s.subject, groupId: auto.groupId, noticeId: 'n', reportId: null, rule: '1', kind: 'chat', statement: 'x', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    expect(await k.cw.appeals.decide(decision('ap-auto', { actor: 'chatwarden' }))).toMatchObject({ ok: true, status: 'upheld' });
  });

  it('allowSelfReview lifts it for the whole kit (and a layer can set it live)', async () => {
    const on = await appealsKit({}, { allowSelfReview: true });
    const s = await filed(on, { actor: 'mod_ann' });
    expect(await on.cw.appeals.decide(decision(s.appealId, { actor: 'mod_ann' }))).toMatchObject({ ok: true });
    const k = await appealsKit();
    const t = await filed(k, { actor: 'mod_ann' });
    expect(await k.cw.appeals.decide(decision(t.appealId, { actor: 'mod_ann' }))).toEqual({ ok: false, error: 'same_decider' });
    k.cw.policy.save({ appeals: { allowSelfReview: true } }, { version: 0, actor: 'owner', reason: 'team of one' });
    expect(await k.cw.appeals.decide(decision(t.appealId, { actor: 'mod_ann' }))).toMatchObject({ ok: true });
  });

  it('a webhook actor and a human differ: the rule compares staff refs', async () => {
    const k = await appealsKit();
    const s = await filed(k, { actor: 'webhook:discord', source: 'api' });
    expect(await k.cw.appeals.decide(decision(s.appealId, { actor: 'webhook:discord' }))).toEqual({ ok: false, error: 'same_decider' });
    expect(await k.cw.appeals.decide(decision(s.appealId, { actor: 'mod_bea' }))).toMatchObject({ ok: true });
  });
});

describe('gone and moot', () => {
  it('gone: deciding after the sanction was revoked outside the kit answers gone and the appeal becomes moot', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    // a revoke that did not go through the kit's revoke (and so never mooted the appeal)
    k.store.revokeSanctionGroup(s.groupId, 'someone', NOW, 'direct');
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('open');
    for (const outcome of ['uphold', 'revoke'] as const) {
      const again = await filed(k, { kind: 'ban', durationMs: null });
      k.store.revokeSanctionGroup(again.groupId, 'someone', NOW, 'direct');
      expect(await k.cw.appeals.decide(decision(again.appealId, { outcome }))).toEqual({ ok: false, error: 'gone' });
      expect(k.store.loadAppeal(again.appealId)).toMatchObject({ status: 'moot', decidedBy: 'senior_bea' });
    }
    expect(await k.cw.appeals.decide(decision(s.appealId))).toEqual({ ok: false, error: 'gone' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('moot');
    // a moot appeal is not decided again (its sanction was revoked first, so `gone` and not `already_decided`), and it has no outcome notice, no event
    expect(await k.cw.appeals.decide(decision(s.appealId))).toEqual({ ok: false, error: 'gone' });
    expect(k.events.filter((e) => e.type === 'appeal.decided')).toEqual([]);
    expect(kinds(k, s.who).filter((x) => x.startsWith('appeal_'))).toEqual([]);
  });

  it('an appeal open while retention removes its sanction can still be decided without throwing (gone)', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'chat', durationMs: HOUR });
    k.clock.t += 400 * DAY;
    expect(k.store.purgeSanctions(k.clock.t - 90 * DAY)).toBeGreaterThan(0);
    expect(k.store.loadSanctionSubjectRow(s.groupId)).toBeNull();
    expect(await k.cw.appeals.decide(decision(s.appealId))).toEqual({ ok: false, error: 'gone' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('moot');
    expect(k.store.countOpenAppeals()).toBe(0);
  });

  it('gone with appealStatementsMs 0 clears the statement as it moots', async () => {
    const k = await appealsKit({ retention: { appealStatementsMs: 0 } });
    const s = await filed(k, { kind: 'ban', durationMs: null });
    k.store.revokeSanctionGroup(s.groupId, 'someone', NOW, 'direct');
    expect(await k.cw.appeals.decide(decision(s.appealId))).toEqual({ ok: false, error: 'gone' });
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'moot', statement: null });
    await k.cw.close();
  });

  it('moot: revoking elsewhere closes the appeal with no outcome notice, no appeal.decided event and no granted count', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    expect(await k.cw.sanctions.revoke(s.groupId, 'mod_cy', 'lifted')).toBe(true);
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'moot', decidedBy: 'mod_cy' });
    expect(kinds(k, s.who)).toEqual([]);
    expect(k.events.filter((e) => e.type === 'appeal.decided')).toEqual([]);
    expect(k.store.appealCountsByRule(0)).toEqual([{ rule: '2', appealed: 1, granted: 0, lightened: 0 }]);
    // the card a moderator opens after the revoke is told the sanction is gone, not that somebody decided it
    for (const outcome of ['uphold', 'reduce', 'revoke'] as const) {
      const res = await k.cw.appeals.decide(decision(s.appealId, outcome === 'reduce' ? { outcome, to: { kind: 'warning', durationMs: null } } : { outcome }));
      expect(res, outcome).toEqual({ ok: false, error: 'gone' });
    }
    expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: 'moot', decidedBy: 'mod_cy' });
  });

  it('a decided appeal still answers already_decided (upheld, reduced and revoked), a moot one gone', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    for (const outcome of ['uphold', 'reduce', 'revoke'] as const) {
      const s = await filed(k, { kind: 'ban', durationMs: null });
      const to = outcome === 'reduce' ? { to: { kind: 'chat' as const, durationMs: HOUR } } : {};
      expect(await k.cw.appeals.decide(decision(s.appealId, { outcome, ...to }))).toMatchObject({ ok: true });
      expect(await k.cw.appeals.decide(decision(s.appealId, { outcome, actor: 'owner_cy', ...to })), outcome).toEqual({ ok: false, error: 'already_decided' });
    }
  });

  it('a race loser answers already_decided, never gone: another process decided first, so the revoke finds nothing left to revoke', async () => {
    for (const winner of ['revoke', 'reduce'] as const) {
      const k = await appealsKit();
      const s = await filed(k, { kind: 'ban', durationMs: null });
      // The other process commits its decision just before this one's transaction opens (this one already read the appeal as open).
      const real = k.store.transaction.bind(k.store);
      let raced = false;
      (k.store as unknown as { transaction: unknown }).transaction = <T>(fn: () => T): T => {
        if (!raced) {
          raced = true;
          k.store.revokeSanctionGroup(s.groupId, 'other_proc', NOW, 'won');
          k.store.decideAppeal(s.appealId, { status: winner === 'revoke' ? 'revoked' : 'reduced', at: NOW, by: 'other_proc', reason: 'won', replacementGroupId: null });
        }
        return real(fn);
      };
      const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', actor: 'owner_cy' }));
      expect(res, winner).toEqual({ ok: false, error: 'already_decided' });
      expect(k.store.loadAppeal(s.appealId)).toMatchObject({ status: winner === 'revoke' ? 'revoked' : 'reduced', decidedBy: 'other_proc' });
      expect(k.events.filter((e) => e.type === 'appeal.decided')).toEqual([]);
      await k.cw.close();
    }
  });

  it('control: the sanction revoked by a path that left the appeal open (no decision) is still gone and moots', async () => {
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const real = k.store.transaction.bind(k.store);
    let raced = false;
    (k.store as unknown as { transaction: unknown }).transaction = <T>(fn: () => T): T => {
      if (!raced) {
        raced = true;
        k.store.revokeSanctionGroup(s.groupId, 'other_proc', NOW, 'direct');
      }
      return real(fn);
    };
    expect(await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }))).toEqual({ ok: false, error: 'gone' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('moot');
  });
});

describe('events and the AI seam', () => {
  it('appeal.decided once, after the commit, never on a refusal; no statement, reason or handle in it', async () => {
    const SECRET = 'PRIVATE-REASON-zxq';
    const k = await appealsKit();
    const s = await filed(k, { actor: 'mod_ann' }, 'MY-STATEMENT-qrs');
    let status = '';
    k.cw.on('appeal.decided', () => {
      status = k.store.loadAppeal(s.appealId)?.status ?? '';
    });
    await k.cw.appeals.decide(decision(s.appealId, { actor: 'mod_ann', reason: SECRET }));
    await k.cw.appeals.decide(decision('nope', { reason: SECRET }));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'dismiss' as never, reason: SECRET }));
    expect(k.events.filter((e) => e.type === 'appeal.decided')).toEqual([]);
    await k.cw.appeals.decide(decision(s.appealId, { reason: SECRET }));
    const ev = k.events.filter((e) => e.type === 'appeal.decided');
    expect(ev).toEqual([{ type: 'appeal.decided', appealId: s.appealId, at: NOW, target: s.subject, outcome: 'uphold', rule: 2 }]);
    expect(status).toBe('upheld');
    expect(JSON.stringify(k.events)).not.toMatch(/PRIVATE-REASON|MY-STATEMENT/);
    expect(JSON.stringify(k.logged)).not.toMatch(/PRIVATE-REASON|MY-STATEMENT/);
  });

  it('a failing listener, a failing announce and a failing sanction index cannot fail the decision', async () => {
    const k = await appealsKit({
      platform: {
        identify: (ctx: unknown) => ctx as RawWho,
        notify: () => {
          throw new Error('push down');
        },
      },
    } as never);
    const s = await filed(k);
    k.cw.on('appeal.decided', () => {
      throw new Error('listener down');
    });
    expect(await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }))).toMatchObject({ ok: true, status: 'revoked' });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('revoked');
  });

  it('a reduce and a revoke both call the AI seam with the report id, an uphold does not, and a missing report id is skipped', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    const calls: string[] = [];
    k.cw.ai.markReversed = (id: string) => {
      calls.push(id);
      return true;
    };
    const up = await filed(k);
    const red = await filed(k, { kind: 'ban', durationMs: null });
    const rev = await filed(k);
    await k.cw.appeals.decide(decision(up.appealId));
    expect(calls).toEqual([]);
    await k.cw.appeals.decide(decision(red.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: HOUR } }));
    await k.cw.appeals.decide(decision(rev.appealId, { outcome: 'revoke' }));
    expect(calls).toEqual([red.reportId, rev.reportId]);
    // a sanction with no report (a direct apply) has nothing to mark
    const direct = await k.cw.sanctions.apply({ kind: 'chat', subject: up.subject, includeIp: false, durationMs: HOUR, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    k.store.insertAppeal({ id: 'ap-direct', subject: up.subject, groupId: direct.groupId, noticeId: 'n', reportId: null, rule: '1', kind: 'chat', statement: 'x', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    calls.length = 0;
    expect(await k.cw.appeals.decide(decision('ap-direct', { outcome: 'revoke' }))).toMatchObject({ ok: true });
    expect(calls).toEqual([]);
    // the counts: a reduce is lightened, never granted
    expect(k.store.appealCountsByRule(0)).toEqual(expect.arrayContaining([{ rule: '2', appealed: 3, granted: 1, lightened: 1 }]));
  });

  it('an AI seam that throws cannot fail the decision', async () => {
    const k = await appealsKit();
    k.cw.ai.markReversed = () => {
      throw new Error('ai down');
    };
    const s = await filed(k);
    expect(await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke' }))).toMatchObject({ ok: true });
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('revoked');
  });
});

describe('the statement and the reason', () => {
  it('appealStatementsMs 0 clears the statement in the decision; the default keeps it', async () => {
    const zero = await appealsKit({ retention: { appealStatementsMs: 0 } });
    const a = await filed(zero);
    await zero.cw.appeals.decide(decision(a.appealId));
    expect(zero.store.loadAppeal(a.appealId)).toMatchObject({ status: 'upheld', statement: null });
    await zero.cw.close();
    const k = await appealsKit();
    const b = await filed(k);
    await k.cw.appeals.decide(decision(b.appealId));
    expect(k.store.loadAppeal(b.appealId)?.statement).toBe('It was not me.');
  });

  it('reason is required and private: it never appears in a player-facing value', async () => {
    const REASON = 'PRIVATE-MOD-REASON-kkk';
    const k = await appealsKit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reason: REASON, to: { kind: 'chat', durationMs: HOUR } }));
    expect(JSON.stringify(k.cw.notices.pending(s.who))).not.toContain(REASON);
    expect(JSON.stringify(k.cw.notices.record(s.who))).not.toContain(REASON);
    expect(JSON.stringify(k.cw.appeals.mine(s.who))).not.toContain(REASON);
    expect(JSON.stringify(k.store.rawNotices())).not.toContain(REASON);
    expect(JSON.stringify(k.cw.audit.list({ limit: 50 }))).not.toContain(REASON);
    // it is on the appeal row, and on the replacement sanction row (staff-side)
    expect(k.store.loadAppeal(s.appealId)?.decisionReason).toBe(REASON);
  });

  it('nothing is audited by the service itself (the route audits)', async () => {
    const k = await appealsKit();
    const s = await filed(k);
    const before = k.cw.audit.list({ limit: 50 }).items.length;
    await k.cw.appeals.decide(decision(s.appealId));
    expect(k.cw.audit.list({ limit: 50 }).items).toHaveLength(before);
  });
});

describe('an uncovered or pre-rules sanction', () => {
  it('a reduce of a sanction under no rule writes a replacement under no rule (without asking for a gap note)', async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    const direct = await k.cw.sanctions.apply({ kind: 'ban', subject: s.subject, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, gapNote: 'a gap' });
    k.store.insertAppeal({ id: 'ap-unc', subject: s.subject, groupId: direct.groupId, noticeId: 'n', reportId: null, rule: 'uncovered', kind: 'ban', statement: 'x', status: 'open', createdAt: NOW, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null });
    const gapsBefore = k.cw.gaps.list().length;
    const res = await k.cw.appeals.decide(decision('ap-unc', { outcome: 'reduce', to: { kind: 'chat', durationMs: HOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced' });
    const repl = k.store.rawSanctions().find((r) => r.groupId === (res as { replacementGroupId: string }).replacementGroupId && r.targetType === 'subject');
    expect(repl).toMatchObject({ rule: 'uncovered', gapNote: null, gapStatus: null });
    expect(k.cw.gaps.list()).toHaveLength(gapsBefore);
    expect(kinds(k, s.who).filter((x) => x === 'appeal_reduced')).toHaveLength(1);
  });
});

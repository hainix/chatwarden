import { describe, expect, it } from 'vitest';
import type { AppealCase } from '../src/appeals.js';
import { mintAppealToken } from '../src/appealLink.js';
import { appealableUntil, NOTICE_RECORD_WINDOW_MS } from '../src/notices.js';
import type { AppealDecision } from '../src/appeals.js';
import type { NoticeRow } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// The link at kit level: which notices get one, how long it lives, what the case shows, and that every bad link answers alike.

const LANDING = 'https://game.example/appeal';
const WORLD_SECRET = 'reporting-secret';
const INVALID = { ok: false, reason: 'invalid' };
const NINETY = 90 * DAY;
const THIRTY = 30 * DAY;

/** A kit with the landing page set (the `appeals` option) and appeals on. `settings` are the profile's `appeals` fields. */
const kit = (settings: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => appealsKit({ appeals: { landingUrl: LANDING }, ...over } as never, settings);
const tokenOf = (url: string | null): string => new URL(url as string).searchParams.get('t') as string;
const expiryOf = (k: AppealsKit, url: string | null): number => {
  const r = k.cw.appeals.openLink(tokenOf(url));
  if (!r.ok) throw new Error('link did not open');
  return r.expiresAt;
};
const decision = (appealId: string, over: Partial<AppealDecision> = {}): AppealDecision => ({ appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'hidden-private-reason', ...over });
const notice = (o: Partial<NoticeRow> & { id: string; subject: string }): NoticeRow => ({ groupId: null, kind: 'chat', rule: '2', until: NOW + HOUR, refCode: 'M-XXXXX', excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null, ...o });

async function filed(k: AppealsKit, o: Parameters<AppealsKit['sanction']>[0] = {}, statement = 'secret-statement-xyz') {
  const s = await k.sanction(o);
  const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement });
  if (!r.ok) throw new Error(`filing refused: ${r.refused}`);
  return { ...s, appealId: r.appeal.id };
}

describe('appealableUntil', () => {
  const base = { createdAt: 1_000_000, until: null as number | null };
  it('a warning is appealable for 90 days from when it was made, whatever else', () => {
    expect(appealableUntil({ ...base, kind: 'warning' })).toBe(1_000_000 + NOTICE_RECORD_WINDOW_MS);
    expect(appealableUntil({ ...base, kind: 'warning', until: 5 })).toBe(1_000_000 + NOTICE_RECORD_WINDOW_MS);
  });
  it('a restriction with an end is appealable until the later of its end and 90 days; one with no end has no end', () => {
    expect(appealableUntil({ ...base, kind: 'chat', until: 1_000_000 + HOUR })).toBe(1_000_000 + NOTICE_RECORD_WINDOW_MS);
    expect(appealableUntil({ ...base, kind: 'ban', until: 1_000_000 + 200 * DAY })).toBe(1_000_000 + 200 * DAY);
    expect(appealableUntil({ ...base, kind: 'area', until: 1_000_000 + 90 * DAY })).toBe(1_000_000 + 90 * DAY);
    expect(appealableUntil({ ...base, kind: 'ban', until: null })).toBeNull();
    expect(appealableUntil({ ...base, kind: 'chat', until: null })).toBeNull();
  });
});

describe('link and openLink', () => {
  it('link() returns landingUrl?t=<token> for a live sanction notice and openLink round-trips it', async () => {
    const k = await kit();
    for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
      const s = await k.sanction({ kind, durationMs: kind === 'ban' ? null : 6 * HOUR });
      const url = k.cw.appeals.link(s.noticeId);
      expect(url, kind).toMatch(/^https:\/\/game\.example\/appeal\?t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
      expect(k.cw.appeals.openLink(tokenOf(url))).toEqual({ ok: true, noticeId: s.noticeId, expiresAt: expiryOf(k, url) });
    }
  });

  it('a landing url that already has a path with a slash keeps it and gets the token as its only query', async () => {
    const k = await appealsKit({ appeals: { landingUrl: 'http://localhost:3000/a/b/' } } as never);
    const s = await k.sanction();
    const url = new URL(k.cw.appeals.link(s.noticeId) as string);
    expect(url.origin + url.pathname).toBe('http://localhost:3000/a/b/');
    expect([...url.searchParams.keys()]).toEqual(['t']);
  });

  it('openLink answers invalid for anything that is not a good token, and never throws', async () => {
    const k = await kit();
    for (const t of ['', 'x', 'a.b', undefined, null, 5, {}, mintAppealToken('another-secret', 'n', NOW + DAY)]) {
      expect(k.cw.appeals.openLink(t as never), String(t)).toEqual(INVALID);
    }
  });

  it('link() is null: appeals off, landingUrl unset, an unknown id, empty and non-string ids', async () => {
    const off = await kit({ enabled: false });
    const a = await off.sanction();
    expect(off.cw.appeals.link(a.noticeId)).toBeNull();
    const unset = await appealsKit();
    const b = await unset.sanction();
    expect(unset.cw.appeals.link(b.noticeId)).toBeNull();
    const k = await kit();
    const s = await k.sanction();
    expect(k.cw.appeals.link(s.noticeId)).not.toBeNull(); // the control
    for (const id of ['no-such-notice', '', 5, null, undefined, {}, [], 'x'.repeat(65), s.noticeId.toUpperCase()]) {
      expect(() => k.cw.appeals.link(id as never)).not.toThrow();
      expect(k.cw.appeals.link(id as never), String(id)).toBeNull();
    }
  });

  it('link() is null for a report outcome, a rename, an appeal outcome, an ended notice and a withdrawn one with no decided appeal', async () => {
    const k = await kit();
    const s = await k.sanction({ key: 'kp' });
    // a report outcome
    const outcome = k.cw.notices.pending({ clientKey: 'key-reporter' }).find((n) => n.kind === 'report_outcome');
    expect(outcome).toBeDefined();
    expect(k.cw.appeals.link((outcome as { id: string }).id)).toBeNull();
    // a rename notice of the same person
    k.store.insertNotice(notice({ id: 'rn1', subject: s.subject, kind: 'rename_required', until: null, rule: null, refCode: null }));
    expect(k.cw.appeals.link('rn1')).toBeNull();
    // an appeal outcome notice
    const f = await filed(k, { key: 'kq' });
    await k.cw.appeals.decide(decision(f.appealId));
    const upheld = k.cw.notices.pending(f.who).find((n) => n.kind === 'appeal_upheld');
    expect(upheld).toBeDefined();
    expect(k.cw.appeals.link((upheld as { id: string }).id)).toBeNull();
    // a withdrawn notice whose sanction was revoked, with no appeal
    const r = await k.sanction({ key: 'kr' });
    expect(k.cw.appeals.link(r.noticeId)).not.toBeNull();
    await k.cw.sanctions.revoke(r.groupId, 'mod_cy', 'lifted');
    expect(k.cw.appeals.link(r.noticeId)).toBeNull();
    // a notice past its appealable end
    const old = await k.sanction({ key: 'ks', kind: 'chat', durationMs: 6 * HOUR });
    k.clock.t = NOW + NINETY + 1;
    expect(k.cw.appeals.link(old.noticeId)).toBeNull();
    // a warning too: a warning stays appealable for 90 days exactly
    k.clock.t = NOW;
    const w = await k.sanction({ key: 'kw', kind: 'warning' });
    k.clock.t = NOW + NINETY - 1;
    expect(k.cw.appeals.link(w.noticeId)).not.toBeNull();
    k.clock.t = NOW + NINETY + 1;
    expect(k.cw.appeals.link(w.noticeId)).toBeNull();
  });

  it('expiresAt is min(now + linkTtlMs, the appealable end): a 6 h chat made 89 days ago links until its 90-day end', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'chat', durationMs: 6 * HOUR });
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId))).toBe(NOW + THIRTY);
    k.clock.t = NOW + 89 * DAY;
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId))).toBe(NOW + NINETY);
    // the day it ends: nothing left to appeal, no link
    k.clock.t = NOW + NINETY;
    expect(k.cw.appeals.link(s.noticeId)).toBeNull();
  });

  it('a permanent ban gets the full ttl; a ban with a long end is bounded by its end', async () => {
    const k = await kit();
    const perm = await k.sanction({ kind: 'ban', durationMs: null });
    expect(expiryOf(k, k.cw.appeals.link(perm.noticeId))).toBe(NOW + THIRTY);
    const long = await k.sanction({ kind: 'ban', durationMs: 100 * DAY });
    k.clock.t = NOW + 80 * DAY;
    // 100 days is later than 90, so the end of the ban bounds the link; 30 days from now is NOW + 110 days
    expect(expiryOf(k, k.cw.appeals.link(long.noticeId))).toBe(NOW + 100 * DAY);
  });

  it('linkTtlMs from the profile sets the default, and opts.ttlMs overrides within the range', async () => {
    const k = await kit({ linkTtlMs: 2 * HOUR });
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId))).toBe(NOW + 2 * HOUR);
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId, { ttlMs: 5 * HOUR }))).toBe(NOW + 5 * HOUR);
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId, { ttlMs: 3_600_000 }))).toBe(NOW + HOUR);
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId, { ttlMs: 31_536_000_000 }))).toBe(NOW + 365 * DAY);
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId, {}))).toBe(NOW + 2 * HOUR);
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId, { ttlMs: undefined }))).toBe(NOW + 2 * HOUR);
  });

  it('opts.ttlMs outside the range, a fraction or a non-number is a RangeError', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    for (const ttlMs of [3_599_999, 31_536_000_001, 0, -1, 1.5, Number.NaN, Infinity, '3600000', null]) {
      expect(() => k.cw.appeals.link(s.noticeId, { ttlMs: ttlMs as never }), String(ttlMs)).toThrow(RangeError);
    }
  });

  it('a profile ttl change is read live', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    k.cw.policy.save({ appeals: { linkTtlMs: 3 * HOUR } }, { version: 0, actor: 'owner', reason: 'shorter' });
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId))).toBe(NOW + 3 * HOUR);
  });

  it('a link outlives nothing: after its time it is invalid, and a fresh link() works', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    const url = k.cw.appeals.link(s.noticeId);
    expect(k.cw.appeals.caseByLink(tokenOf(url))).toMatchObject({ ok: true });
    k.clock.t = NOW + THIRTY - 1;
    expect(k.cw.appeals.caseByLink(tokenOf(url))).toMatchObject({ ok: true });
    k.clock.t = NOW + THIRTY;
    expect(k.cw.appeals.openLink(tokenOf(url))).toEqual(INVALID);
    expect(k.cw.appeals.caseByLink(tokenOf(url))).toEqual(INVALID);
    const fresh = k.cw.appeals.link(s.noticeId);
    expect(fresh).not.toBeNull();
    expect(tokenOf(fresh)).not.toBe(tokenOf(url));
    expect(k.cw.appeals.caseByLink(tokenOf(fresh))).toMatchObject({ ok: true });
  });
});

describe('caseByLink for a live notice', () => {
  const NOTICE_KEYS = ['createdAt', 'excerpt', 'kind', 'refCode', 'rule', 'ruleLabel', 'until'];
  const CASE_KEYS = ['appeal', 'canAppeal', 'contact', 'emailsOutcome', 'expiresAt', 'notice', 'standing', 'statementMax'];

  it('canAppeal true, no appeal, no standing; the notice view equals notices.record() (excerpt included); only the allow-listed keys', async () => {
    const k = await kit({ contact: 'help@game.example', emailsOutcome: true });
    const s = await k.sanction({ kind: 'chat', durationMs: 6 * HOUR });
    // a second notice of the same group carrying lines, as a decision with lines makes
    k.store.insertNotice(notice({ id: 'nx', subject: s.subject, groupId: s.groupId, kind: 'chat', until: NOW + HOUR, refCode: s.refCode, excerpt: [{ text: 'you ****', day: '2027-01-14' }] }));
    const url = k.cw.appeals.link('nx');
    const res = k.cw.appeals.caseByLink(tokenOf(url));
    expect(res.ok).toBe(true);
    const c = (res as { ok: true; case: AppealCase }).case;
    expect(Object.keys(c).sort()).toEqual(CASE_KEYS);
    expect(Object.keys(c.notice).sort()).toEqual(NOTICE_KEYS);
    const record = k.cw.notices.record(s.who).find((n) => n.id === 'nx');
    expect(record).toBeDefined();
    const view: Record<string, unknown> = { ...record };
    for (const key of ['id', 'mustAcknowledge', 'appealUrl']) delete view[key];
    expect(c.notice).toEqual(view);
    expect(c.notice.excerpt).toEqual([{ text: 'you ****', day: '2027-01-14' }]);
    expect(c).toMatchObject({ canAppeal: true, appeal: null, standing: null, expiresAt: expiryOf(k, url), emailsOutcome: true, contact: 'help@game.example', statementMax: 1000 });
  });

  it('every kind shows its own kind, end and reference; a warning has no end', async () => {
    const k = await kit();
    for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
      const s = await k.sanction({ kind, durationMs: kind === 'ban' ? null : 6 * HOUR });
      const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
      expect(c.notice).toMatchObject({ kind, until: kind === 'warning' || kind === 'ban' ? null : NOW + 6 * HOUR, refCode: s.refCode, rule: 2, createdAt: NOW });
      expect(typeof c.notice.ruleLabel).toBe('string');
    }
  });

  it('the settings default to no contact and no email', async () => {
    const k = await kit();
    const s = await k.sanction();
    const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
    expect(c).toMatchObject({ contact: null, emailsOutcome: false });
  });

  it('caseByLink is the same answer however it is reached: the link of another kit with another secret is invalid', async () => {
    const a = await kit();
    const s = await a.sanction();
    const token = tokenOf(a.cw.appeals.link(s.noticeId));
    const b = await kit({}, {});
    // another kit has no such notice anyway; sign the same id under the other secret to prove the secret matters
    expect(b.cw.appeals.caseByLink(token)).toEqual(INVALID);
    expect(b.cw.appeals.caseByLink(mintAppealToken('not-the-secret', s.noticeId, NOW + DAY))).toEqual(INVALID);
  });

  it('a case is read-only: reading it twice changes nothing in the store', async () => {
    const k = await kit();
    const s = await k.sanction();
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    const before = JSON.stringify([k.store.rawNotices(), k.rows()]);
    k.cw.appeals.caseByLink(token);
    k.cw.appeals.caseByLink(token);
    expect(JSON.stringify([k.store.rawNotices(), k.rows()])).toBe(before);
  });
});

describe('caseByLink after an appeal', () => {
  it('after filing: the open appeal shows, canAppeal is false, standing is null', async () => {
    const k = await kit();
    const s = await filed(k);
    const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
    expect(c.canAppeal).toBe(false);
    expect(c.appeal).toEqual({ status: 'open', createdAt: NOW, decidedAt: null, reason: null });
    expect(c.standing).toBeNull();
  });

  it('after uphold: the standing is the original, with the stored reason', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    k.clock.t = NOW + HOUR;
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }));
    const c = (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;
    expect(c.canAppeal).toBe(false);
    expect(c.appeal).toEqual({ status: 'upheld', createdAt: NOW, decidedAt: NOW + HOUR, reason: 'rule_applies' });
    expect(c.standing).toEqual({ kind: 'chat', until: NOW + 6 * HOUR, state: 'active' });
  });

  it('after reduce: the standing is the replacement kind and end, and the link (its notice now withdrawn) still resolves, read-only', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const before = tokenOf(k.cw.appeals.link(s.noticeId));
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'lighter_fits', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    expect(res).toMatchObject({ ok: true, status: 'reduced' });
    expect(k.store.rawNotices().find((n) => n.id === s.noticeId)?.withdrawnAt).not.toBeNull();
    for (const token of [before, tokenOf(k.cw.appeals.link(s.noticeId))]) {
      const c = (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;
      expect(c.canAppeal).toBe(false);
      expect(c.appeal).toMatchObject({ status: 'reduced', reason: 'lighter_fits' });
      expect(c.standing).toEqual({ kind: 'chat', until: NOW + 2 * HOUR, state: 'active' });
      // the notice shown is the original one, as it was given
      expect(c.notice).toMatchObject({ kind: 'ban', until: null, refCode: s.refCode });
    }
  });

  it('after reduce to a warning: the standing is a warning with no end', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'first_offence', to: { kind: 'warning', durationMs: null } }));
    const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
    expect(c.standing).toEqual({ kind: 'warning', until: null, state: 'active' });
  });

  it('after reduce with the replacement rows gone (retention): the standing is null and the case still answers', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    const replacement = (res as { replacementGroupId: string }).replacementGroupId;
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    const real = k.store.loadSanctionSubjectRow.bind(k.store);
    k.store.loadSanctionSubjectRow = (id: string) => (id === replacement ? null : real(id));
    const c = (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;
    expect(c.standing).toBeNull();
    expect(c.appeal).toMatchObject({ status: 'reduced' });
  });

  it('after revoke: the standing is the original, lifted; the link still resolves, and the reason is the stored code', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    const before = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    for (const token of [before, tokenOf(k.cw.appeals.link(s.noticeId))]) {
      const c = (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;
      expect(c.canAppeal).toBe(false);
      // The group exists (revoked by the decision), so the standing says what it was and that it is lifted: never null.
      expect(c.standing).toEqual({ kind: 'chat', until: NOW + 6 * HOUR, state: 'lifted' });
      expect(c.appeal).toMatchObject({ status: 'revoked', reason: 'mistake' });
    }
  });

  it('a decided view link is bounded by 90 days from now and by the ttl', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    k.clock.t = NOW + 200 * DAY;
    expect(expiryOf(k, k.cw.appeals.link(s.noticeId))).toBe(NOW + 200 * DAY + THIRTY);
    const big = await kit({ linkTtlMs: 365 * DAY });
    const t = await filed(big, { kind: 'chat', durationMs: 6 * HOUR });
    await big.cw.appeals.decide(decision(t.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    expect(expiryOf(big, big.cw.appeals.link(t.noticeId))).toBe(NOW + NINETY);
  });

  it('the reason is null for an appeal decided with no stored code, and for a code the kit does not know', async () => {
    const k = await kit();
    const a = await filed(k, { key: 'ka' });
    k.store.decideAppeal(a.appealId, { status: 'upheld', at: NOW, by: 'bea', reason: 'r', replacementGroupId: null });
    const b = await filed(k, { key: 'kb' });
    k.store.decideAppeal(b.appealId, { status: 'upheld', at: NOW, by: 'bea', reason: 'r', reasonCode: 'made_up_code', replacementGroupId: null });
    for (const s of [a, b]) {
      const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
      expect(c.appeal).toMatchObject({ status: 'upheld', reason: null });
    }
  });
});

describe('the standing is the sanction as it stands now, in every decided case', () => {
  const caseOf = (k: AppealsKit, token: string) => (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;

  it('upheld, then a moderator revokes the original later: standing is the original, lifted (it was null)', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }));
    expect(caseOf(k, token).standing).toEqual({ kind: 'ban', until: null, state: 'active' });
    await k.cw.sanctions.revoke(s.groupId, 'mod_cy', 'lifted later');
    const c = caseOf(k, token);
    expect(c.standing).toEqual({ kind: 'ban', until: null, state: 'lifted' });
    expect(c.appeal).toMatchObject({ status: 'upheld' });
    expect(c.canAppeal).toBe(false);
  });

  it('upheld, then its end passes: standing is the original, ended', async () => {
    const k = await kit({ linkTtlMs: 365 * DAY });
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }));
    k.clock.t = NOW + 7 * HOUR;
    expect(caseOf(k, token).standing).toEqual({ kind: 'chat', until: NOW + 6 * HOUR, state: 'ended' });
    // the boundary: a millisecond before the end it is active, at the end instant it has ended
    k.clock.t = NOW + 6 * HOUR - 1;
    expect(caseOf(k, token).standing).toMatchObject({ state: 'active' });
    k.clock.t = NOW + 6 * HOUR;
    expect(caseOf(k, token).standing).toMatchObject({ state: 'ended' });
  });

  it('reduced, then the replacement runs out: its kind and end with state ended', async () => {
    const k = await kit({ linkTtlMs: 365 * DAY });
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'lighter_fits', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    expect(caseOf(k, token).standing).toEqual({ kind: 'chat', until: NOW + 2 * HOUR, state: 'active' });
    k.clock.t = NOW + 3 * HOUR;
    expect(caseOf(k, token).standing).toEqual({ kind: 'chat', until: NOW + 2 * HOUR, state: 'ended' });
  });

  it('reduced, then a moderator revokes the replacement: its kind and end with state lifted (it was null)', async () => {
    const k = await kit();
    const s = await filed(k, { kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    const res = await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'lighter_fits', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    await k.cw.sanctions.revoke((res as { replacementGroupId: string }).replacementGroupId, 'mod_cy', 'lifted later');
    expect(caseOf(k, token).standing).toEqual({ kind: 'chat', until: NOW + 2 * HOUR, state: 'lifted' });
  });

  it('reduced to a warning stays active however long ago (a warning has no end)', async () => {
    const k = await kit({ linkTtlMs: 365 * DAY });
    const s = await filed(k, { kind: 'chat', durationMs: 6 * HOUR });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', reasonCode: 'first_offence', to: { kind: 'warning', durationMs: null } }));
    k.clock.t = NOW + 10 * DAY;
    expect(caseOf(k, token).standing).toEqual({ kind: 'warning', until: null, state: 'active' });
  });

  it('no decision yet (none, or still open): standing is null; the group row gone: null (control)', async () => {
    const k = await kit();
    const a = await k.sanction({ key: 'k-none' });
    expect(caseOf(k, tokenOf(k.cw.appeals.link(a.noticeId))).standing).toBeNull();
    const b = await filed(k, { key: 'k-open' });
    expect(caseOf(k, tokenOf(k.cw.appeals.link(b.noticeId))).standing).toBeNull();
    const c = await filed(k, { key: 'k-gone' });
    await k.cw.appeals.decide(decision(c.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }));
    const token = tokenOf(k.cw.appeals.link(c.noticeId));
    const real = k.store.loadSanctionSubjectRow.bind(k.store);
    k.store.loadSanctionSubjectRow = (id: string) => (id === c.groupId ? null : real(id));
    expect(caseOf(k, token).standing).toBeNull();
  });
});

describe('the appeal of a notice is found directly, not among the newest 50 of the person', () => {
  /** An old appeal filed through the real path, then 55 newer ones of the same person written straight into the store. */
  async function crowded() {
    const k = await kit({}, {});
    const s = await filed(k, { key: 'k-crowd', kind: 'chat', durationMs: 6 * HOUR });
    const subject = k.store.loadAppeal(s.appealId)!.subject;
    for (let i = 0; i < 55; i++) {
      k.store.insertAppeal({
        id: `bulk-${i}`, subject, groupId: `bulk-g-${i}`, noticeId: `bulk-n-${i}`, reportId: null, rule: '2', kind: 'chat', statement: 'x',
        status: 'open', createdAt: NOW + 1000 + i, decidedAt: null, decidedBy: null, decisionReason: null, replacementGroupId: null,
      });
    }
    return { k, s, subject };
  }

  it('canAppeal is false and the open appeal shows, although 55 newer appeals of the person exist', async () => {
    const { k, s, subject } = await crowded();
    expect(k.store.listAppealsBy([subject], 50).some((r) => r.id === s.appealId)).toBe(false); // the premise
    const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
    expect(c.canAppeal).toBe(false);
    expect(c.appeal).toMatchObject({ status: 'open' });
  });

  it('a decided old appeal keeps its read-only view and its standing', async () => {
    const { k, s } = await crowded();
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'uphold', reasonCode: 'rule_applies' }));
    const c = (k.cw.appeals.caseByLink(token) as { ok: true; case: AppealCase }).case;
    expect(c.appeal).toMatchObject({ status: 'upheld', reason: 'rule_applies' });
    expect(c.standing).toEqual({ kind: 'chat', until: NOW + 6 * HOUR, state: 'active' });
  });

  it('the link of a revoked old appeal still resolves (decided view) after the notice was withdrawn', async () => {
    const { k, s } = await crowded();
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'revoke', reasonCode: 'mistake' }));
    expect(k.cw.appeals.caseByLink(token)).toMatchObject({ ok: true });
    expect(k.cw.appeals.link(s.noticeId)).not.toBeNull();
  });

  it('filing by the link of the crowded notice answers already_appealed, as the case said', async () => {
    const { k, s } = await crowded();
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    expect(k.cw.appeals.fileByLink(token, { statement: 'again' })).toEqual({ ok: false, refused: 'already_appealed' });
  });

  it('a moot appeal of a live notice is not a link: the moot row is seen through the direct lookup', async () => {
    const k = await kit();
    const s = await filed(k, { key: 'k-moot', kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    k.store.closeAppealsForGroup(s.groupId, 'x', NOW); // moot, while the notice itself is untouched and live
    expect(k.store.loadAppeal(s.appealId)?.status).toBe('moot');
    expect(k.cw.appeals.caseByLink(token)).toEqual(INVALID);
    expect(k.cw.appeals.link(s.noticeId)).toBeNull();
  });

  it('a store without loadAppealByGroup is read the old way (the newest appeals of the person) and still answers', async () => {
    const k = await kit();
    const s = await filed(k, { key: 'k-old' });
    (k.store as unknown as { loadAppealByGroup?: unknown }).loadAppealByGroup = undefined;
    const c = (k.cw.appeals.caseByLink(tokenOf(k.cw.appeals.link(s.noticeId))) as { ok: true; case: AppealCase }).case;
    expect(c).toMatchObject({ canAppeal: false, appeal: { status: 'open' } });
  });
});

describe('every bad link answers alike', () => {
  it('a forged, expired, erased, purged, moderator-revoked, switched-off or never-existing link is { ok: false, reason: invalid }, all deeply equal', async () => {
    const k = await kit();
    const answers: Record<string, unknown> = {};

    const f = await k.sanction({ key: 'kf', kind: 'ban', durationMs: null });
    const good = tokenOf(k.cw.appeals.link(f.noticeId));
    expect(k.cw.appeals.caseByLink(good)).toMatchObject({ ok: true }); // the control
    const [p, sig] = good.split('.') as [string, string];
    answers.forged = k.cw.appeals.caseByLink(`${p}.${sig.slice(0, 42)}${sig.endsWith('A') ? 'B' : 'A'}`);
    answers.payloadForged = k.cw.appeals.caseByLink(`${p.slice(0, 5)}${p[5] === 'A' ? 'B' : 'A'}${p.slice(6)}.${sig}`);
    answers.junk = k.cw.appeals.caseByLink('not a token');
    answers.nonString = k.cw.appeals.caseByLink(undefined as never);
    answers.otherSecret = k.cw.appeals.caseByLink(mintAppealToken('some-other-secret', f.noticeId, NOW + DAY));
    answers.neverExisting = k.cw.appeals.caseByLink(mintAppealToken(WORLD_SECRET, 'a-notice-that-never-was', NOW + DAY));

    const e = await k.sanction({ key: 'ke', kind: 'ban', durationMs: null });
    const erased = tokenOf(k.cw.appeals.link(e.noticeId));
    await k.cw.privacy.erase(e.subject, { keep: 'none', actor: 'owner_ann' });
    answers.erased = k.cw.appeals.caseByLink(erased);

    const pu = await k.sanction({ key: 'kpu', kind: 'chat', durationMs: 6 * HOUR });
    const purged = tokenOf(k.cw.appeals.link(pu.noticeId));
    expect(k.store.purgeNotices(NOW + 400 * DAY)).toBeGreaterThan(0);
    answers.purged = k.cw.appeals.caseByLink(purged);

    const m = await filed(k, { key: 'km', kind: 'ban', durationMs: null });
    const moot = tokenOf(k.cw.appeals.link(m.noticeId));
    await k.cw.sanctions.revoke(m.groupId, 'mod_cy', 'lifted');
    expect(k.store.loadAppeal(m.appealId)?.status).toBe('moot');
    answers.moot = k.cw.appeals.caseByLink(moot);

    const w = await k.sanction({ key: 'kw2', kind: 'ban', durationMs: null });
    const withdrawn = tokenOf(k.cw.appeals.link(w.noticeId));
    await k.cw.sanctions.revoke(w.groupId, 'mod_cy', 'lifted');
    answers.withdrawn = k.cw.appeals.caseByLink(withdrawn);

    const x = await k.sanction({ key: 'kx', kind: 'ban', durationMs: null });
    const expired = tokenOf(k.cw.appeals.link(x.noticeId, { ttlMs: HOUR }));
    const off = tokenOf(k.cw.appeals.link(x.noticeId));
    k.cw.policy.save({ appeals: { enabled: false } }, { version: 0, actor: 'owner', reason: 'off' });
    answers.off = k.cw.appeals.caseByLink(off);
    k.cw.policy.save({ appeals: { enabled: true } }, { version: 1, actor: 'owner', reason: 'on' });
    k.clock.t = NOW + HOUR;
    answers.expired = k.cw.appeals.caseByLink(expired);

    for (const [name, a] of Object.entries(answers)) expect(a, name).toEqual(INVALID);
    expect(new Set(Object.values(answers).map((a) => JSON.stringify(a)))).toEqual(new Set([JSON.stringify(INVALID)]));
  });

  it('openLink checks the signature and the time only: an erased notice still opens, a forged or expired one does not', async () => {
    const k = await kit();
    const e = await k.sanction({ key: 'ke', kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(e.noticeId));
    await k.cw.privacy.erase(e.subject, { keep: 'none', actor: 'owner_ann' });
    expect(k.cw.appeals.openLink(token)).toMatchObject({ ok: true, noticeId: e.noticeId });
    expect(k.cw.appeals.caseByLink(token)).toEqual(INVALID);
  });

  it('a store failure on the lookup answers invalid and logs the class only', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    k.store.loadNotice = () => {
      throw new TypeError('db is down for key-player-1');
    };
    expect(k.cw.appeals.caseByLink(token)).toEqual(INVALID);
    expect(k.cw.appeals.fileByLink(token, { statement: 'x' })).toEqual({ ok: false, refused: 'not_found' });
    expect(k.cw.appeals.link(s.noticeId)).toBeNull();
    const warned = k.logged.filter(([ev]) => ev === 'chatwarden.appeal_failed');
    expect(warned.length).toBeGreaterThan(0);
    expect(JSON.stringify(k.logged)).not.toContain('key-player-1');
    expect(JSON.stringify(k.logged)).not.toContain(token);
  });
});

describe('what the case never carries', () => {
  it('no notice id, group id, person, key, staff ref, private reason, report id or statement', async () => {
    const k = await kit({ contact: 'help@game.example' });
    const s = await filed(k, { kind: 'ban', durationMs: null, actor: 'mod_ann' }, 'secret-statement-xyz');
    await k.cw.appeals.decide(decision(s.appealId, { outcome: 'reduce', actor: 'senior_bea', reason: 'hidden-private-reason', reasonCode: 'lighter_fits', to: { kind: 'chat', durationMs: 2 * HOUR } }));
    const token = tokenOf(k.cw.appeals.link(s.noticeId));
    const json = JSON.stringify(k.cw.appeals.caseByLink(token));
    const replacement = k.store.loadAppeal(s.appealId)?.replacementGroupId as string;
    for (const secret of [s.noticeId, s.groupId, s.subject, s.key, s.reportId, replacement, 'mod_ann', 'senior_bea', 'hidden-private-reason', 'private reason', 'secret-statement-xyz', k.store.loadAppeal(s.appealId)?.id as string]) {
      expect(json, secret).not.toContain(secret);
    }
    // what it does carry
    expect(json).toContain(s.refCode);
    expect(json).toContain('help@game.example');
  });
});

describe('the link on door refusals and player notices', () => {
  it('a door refusal carries a real link; a new token each refusal (another expiry once the clock moved)', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    const first = k.cw.doors.check('join', s.who);
    expect(first).toMatchObject({ kind: 'ban', noticeId: s.noticeId });
    expect(first?.appealUrl).toMatch(/^https:\/\/game\.example\/appeal\?t=/);
    expect(k.cw.appeals.openLink(tokenOf(first?.appealUrl ?? null))).toMatchObject({ ok: true, noticeId: s.noticeId, expiresAt: NOW + THIRTY });
    expect(k.cw.doors.check('join', s.who)?.appealUrl).toBe(first?.appealUrl); // same instant, same token
    k.clock.t += HOUR;
    const later = k.cw.doors.check('join', s.who);
    expect(later?.appealUrl).not.toBe(first?.appealUrl);
    expect(k.cw.appeals.openLink(tokenOf(later?.appealUrl ?? null))).toMatchObject({ ok: true, expiresAt: NOW + HOUR + THIRTY });
  });

  it('an area refusal at a public door carries one too', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'area', durationMs: 6 * HOUR });
    expect(k.cw.doors.check('public', s.who)?.appealUrl).toMatch(/^https:\/\/game\.example\/appeal\?t=/);
  });

  it('none without landingUrl, with appeals off, and for someone who is not the person on the notice', async () => {
    const unset = await appealsKit();
    const a = await unset.sanction({ kind: 'ban', durationMs: null });
    expect(unset.cw.doors.check('join', a.who)).not.toHaveProperty('appealUrl');
    const off = await kit({ enabled: false });
    const b = await off.sanction({ kind: 'ban', durationMs: null });
    expect(off.cw.doors.check('join', b.who)).not.toHaveProperty('appealUrl');
  });

  it('a link function that throws leaves the refusal intact and logs the class only', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'ban', durationMs: null });
    k.store.loadNotice = () => {
      throw new TypeError('boom key-player-1');
    };
    const r = k.cw.doors.check('join', s.who);
    expect(r).toMatchObject({ kind: 'ban', refCode: s.refCode });
    expect(r).not.toHaveProperty('appealUrl');
    expect(JSON.stringify(k.logged)).not.toContain('key-player-1');
  });

  it('cw.notices.pending and record carry appealUrl on sanction notices only', async () => {
    const k = await kit();
    const s = await k.sanction({ key: 'kn', kind: 'chat', durationMs: 6 * HOUR });
    const w = await k.sanction({ key: 'kn', kind: 'warning' });
    const pending = k.cw.notices.pending(s.who);
    expect(pending.map((n) => n.kind)).toEqual(['chat', 'warning']);
    for (const n of pending) {
      expect(n.appealUrl, n.kind).toMatch(/^https:\/\/game\.example\/appeal\?t=/);
      expect(k.cw.appeals.openLink(tokenOf(n.appealUrl ?? null))).toMatchObject({ ok: true, noticeId: n.id });
    }
    const record = k.cw.notices.record(s.who);
    expect(record.map((n) => n.id).sort()).toEqual([s.noticeId, w.noticeId].sort());
    for (const n of record) expect(n.appealUrl).toBeDefined();
    // a report outcome and an appeal outcome carry none
    const reporter = k.cw.notices.pending({ clientKey: 'key-reporter' });
    expect(reporter.find((n) => n.kind === 'report_outcome')).toBeDefined();
    for (const n of reporter) expect(n).not.toHaveProperty('appealUrl');
    const f = await filed(k, { key: 'ko' });
    await k.cw.appeals.decide(decision(f.appealId, { outcome: 'uphold' }));
    const upheld = k.cw.notices.pending(f.who).find((n) => n.kind === 'appeal_upheld');
    expect(upheld).toBeDefined();
    expect(upheld).not.toHaveProperty('appealUrl');
  });

  it('without a landing url nothing changes in the notices: no appealUrl key at all', async () => {
    const k = await appealsKit();
    const s = await k.sanction({ kind: 'chat', durationMs: 6 * HOUR });
    for (const n of [...k.cw.notices.pending(s.who), ...k.cw.notices.record(s.who)]) expect(n).not.toHaveProperty('appealUrl');
  });

  it('the notices stay fresh copies: changing one answer does not change the next', async () => {
    const k = await kit();
    const s = await k.sanction({ kind: 'chat', durationMs: 6 * HOUR });
    const a = k.cw.notices.pending(s.who);
    (a[0] as { appealUrl?: string }).appealUrl = 'https://evil.example/';
    a[0]?.excerpt.push({ text: 'x', day: '2027-01-01' });
    const b = k.cw.notices.pending(s.who);
    expect(b[0]?.appealUrl).toMatch(/^https:\/\/game\.example\/appeal/);
    expect(b[0]?.excerpt).toEqual([]);
  });
});

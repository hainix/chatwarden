import { describe, expect, it } from 'vitest';
import type { Matcher } from '../src/types.js';
import { appealsKit, DAY, HOUR, NOW } from './appealsWorld.js';

// The staff reads of cw.appeals: list, get, openCount. Summaries never carry the statement; detail does, flagged when it trips the term filter.

const zorbak: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };

async function withAppeals(count: number, over: Parameters<typeof appealsKit>[0] = {}) {
  const k = await appealsKit(over, { perPlayerPerWeek: 20 });
  const items = [];
  for (let i = 0; i < count; i++) {
    const s = await k.sanction({ kind: i % 2 === 0 ? 'chat' : 'ban', durationMs: i % 2 === 0 ? 6 * HOUR : null, actor: i % 3 === 0 ? 'mod_ann' : 'mod_cy' });
    const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: `statement ${i}` });
    if (!r.ok) throw new Error('filing refused');
    items.push({ ...s, appealId: r.appeal.id });
    k.clock.t += 1000;
  }
  return { k, items };
}

describe('list', () => {
  it('open by default, oldest first; decided; all; summaries carry no statement', async () => {
    const { k, items } = await withAppeals(4);
    await k.cw.appeals.decide({ appealId: (items[1] as { appealId: string }).appealId, outcome: 'uphold', actor: 'senior_bea', reason: 'r' });
    await k.cw.appeals.decide({ appealId: (items[2] as { appealId: string }).appealId, outcome: 'revoke', actor: 'senior_bea', reason: 'r' });
    const ids = (p: { items: Array<{ id: string }> }) => p.items.map((i) => i.id);
    const a = items.map((i) => i.appealId);
    expect(ids(k.cw.appeals.list({}))).toEqual([a[0], a[3]]);
    expect(ids(k.cw.appeals.list({ status: 'open' }))).toEqual([a[0], a[3]]);
    expect(ids(k.cw.appeals.list({ status: 'decided' }))).toEqual([a[1], a[2]]);
    expect(ids(k.cw.appeals.list({ status: 'all' }))).toEqual(a);
    const page = k.cw.appeals.list({ status: 'all' });
    for (const item of page.items) expect(Object.keys(item)).not.toContain('statement');
    expect(JSON.stringify(page)).not.toContain('statement 0');
    expect(page.next).toBeNull();
  });

  it('the summary names the person by staff ref, the sanction and who decided it, never a handle', async () => {
    const { k, items } = await withAppeals(2);
    const first = items[0] as (typeof items)[number];
    const [summary] = k.cw.appeals.list({ status: 'all' }).items;
    expect(summary).toEqual({
      id: first.appealId,
      createdAt: NOW,
      status: 'open',
      person: first.subject,
      sanction: { groupId: first.groupId, refCode: first.refCode, kind: 'chat', rule: 2, startsAt: NOW, endsAt: NOW + 6 * HOUR, decidedBy: 'mod_ann', automated: false },
      statementFlagged: false,
    });
    expect(JSON.stringify(summary)).not.toMatch(/Tgt|Rep|handle/);
  });

  it('a cursor round trip pages without a gap or a repeat; limit bounds; a bad cursor throws RangeError', async () => {
    const { k, items } = await withAppeals(5);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: ReturnType<typeof k.cw.appeals.list> = k.cw.appeals.list({ status: 'all', limit: 2, cursor });
      seen.push(...page.items.map((x) => x.id));
      if (page.next === null) break;
      expect(page.items).toHaveLength(2);
      cursor = page.next;
    }
    expect(seen).toEqual(items.map((i) => i.appealId));
    expect(k.cw.appeals.list({ status: 'all', limit: 200 }).items).toHaveLength(5);
    expect(k.cw.appeals.list({ status: 'all', limit: 5 }).next).not.toBeNull();
    for (const limit of [0, -1, 201, 1.5, Number.NaN, '5']) expect(() => k.cw.appeals.list({ limit: limit as never }), String(limit)).toThrow(RangeError);
    for (const bad of ['x', '!!!', 'bm9jb2xvbg', 5, {}]) expect(() => k.cw.appeals.list({ cursor: bad as never }), String(bad)).toThrow(RangeError);
    expect(() => k.cw.appeals.list({ status: 'closed' as never })).toThrow(RangeError);
    expect(k.cw.appeals.list({ cursor: null }).items).toHaveLength(5);
  });

  it('flags a summary whose statement trips the matcher, without showing it', async () => {
    const k = await appealsKit({ matcher: zorbak }, { perPlayerPerWeek: 20 });
    const a = await k.sanction();
    const b = await k.sanction();
    k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'you zorbak' });
    k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'a fair statement' });
    const flags = k.cw.appeals.list({ status: 'all' }).items.map((i) => i.statementFlagged);
    expect(flags).toEqual([true, false]);
    expect(JSON.stringify(k.cw.appeals.list({}))).not.toContain('zorbak');
  });

  it('a moot appeal is not listed; with appeals off the list is empty and touches no store method', async () => {
    const { k, items } = await withAppeals(2);
    await k.cw.sanctions.revoke((items[0] as { groupId: string }).groupId, 'mod_cy', 'lifted');
    expect(k.cw.appeals.list({ status: 'all' }).items.map((i) => i.id)).toEqual([(items[1] as { appealId: string }).appealId]);
    const off = await appealsKit({}, { enabled: false });
    let touched = 0;
    for (const m of ['listAppeals', 'loadAppeal', 'countOpenAppeals', 'loadSanctionSubjectRow'] as const) {
      const real = (off.store as unknown as Record<string, (...a: unknown[]) => unknown>)[m] as (...a: unknown[]) => unknown;
      (off.store as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
        touched += 1;
        return real.apply(off.store, a);
      };
    }
    expect(off.cw.appeals.list({})).toEqual({ items: [], next: null });
    expect(off.cw.appeals.get('x')).toBeNull();
    expect(off.cw.appeals.openCount()).toBe(0);
    expect(touched).toBe(0);
  });

  it('a summary whose sanction rows are gone still lists, from the appeal row', async () => {
    const { k, items } = await withAppeals(1);
    k.clock.t += 400 * DAY;
    k.store.purgeSanctions(k.clock.t - 90 * DAY);
    const [summary] = k.cw.appeals.list({ status: 'all' }).items;
    expect(summary).toMatchObject({ id: (items[0] as { appealId: string }).appealId, sanction: { groupId: (items[0] as { groupId: string }).groupId, kind: 'chat', rule: 2, refCode: '' } });
  });
});

describe('get', () => {
  it('returns the statement, the report, what the player was shown and, once decided, by, at, reason and the replacement', async () => {
    const { k, items } = await withAppeals(2);
    const it0 = items[1] as (typeof items)[number];
    const open = k.cw.appeals.get(it0.appealId);
    expect(open).toMatchObject({ id: it0.appealId, statement: 'statement 1', statementFlagged: false, decided: null, reportId: it0.reportId, shown: [], person: it0.subject, status: 'open' });
    k.clock.t += 5000;
    const res = await k.cw.appeals.decide({ appealId: it0.appealId, outcome: 'reduce', actor: 'senior_bea', reason: 'a day is enough', to: { kind: 'chat', durationMs: DAY } });
    const detail = k.cw.appeals.get(it0.appealId);
    expect(detail).toMatchObject({ status: 'reduced', decided: { by: 'senior_bea', at: k.clock.t, reason: 'a day is enough', replacementGroupId: (res as { replacementGroupId: string }).replacementGroupId } });
    expect(k.cw.appeals.get('no-such-appeal')).toBeNull();
    expect(k.cw.appeals.get(5 as never)).toBeNull();
    expect(k.cw.appeals.get('')).toBeNull();
  });

  it("shows the notice's own lines as kept (already masked)", async () => {
    const k = await appealsKit();
    const s = await k.sanction();
    // put the player's own line on the notice the way a decision with a line does
    k.store.insertNotice({ id: 'nl', subject: s.subject, groupId: `${s.groupId}-other`, kind: 'chat', rule: '2', until: NOW + HOUR, refCode: 'M-LINES', excerpt: [{ text: 'you ****', day: '2027-01-14' }], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    k.store.insertSanctionGroup([{ id: 'srl', groupId: `${s.groupId}-other`, refCode: 'M-LINES', kind: 'chat', targetType: 'subject', value: s.subject, startsAt: NOW, endsAt: NOW + HOUR, reason: 'r', rule: '2', gapNote: null, gapStatus: null, roomId: null, actor: 'mod_x', source: 'moderator', automated: false, pending: false }]);
    const r = k.cw.appeals.file(s.who, { noticeId: 'nl', statement: 'x' });
    if (!r.ok) throw new Error('refused');
    expect(k.cw.appeals.get(r.appeal.id)?.shown).toEqual([{ text: 'you ****', day: '2027-01-14' }]);
  });

  it("statementFlagged reflects the matcher now (a term added tomorrow masks yesterday's text); a throwing matcher reads false and is logged by class; a purged statement is null", async () => {
    let hot = false;
    const matcher: Matcher = { match: (t) => (hot && /plain/.test(t) ? { termId: 't' } : null) };
    const k = await appealsKit({ matcher }, { perPlayerPerWeek: 20 });
    const s = await k.sanction();
    const r = k.cw.appeals.file(s.who, { noticeId: s.noticeId, statement: 'plain words' });
    if (!r.ok) throw new Error('refused');
    expect(k.cw.appeals.get(r.appeal.id)?.statementFlagged).toBe(false);
    hot = true;
    expect(k.cw.appeals.get(r.appeal.id)?.statementFlagged).toBe(true);
    expect(k.cw.appeals.list({}).items[0]?.statementFlagged).toBe(true);
    hot = false;
    const boom = await appealsKit({ matcher: { match: () => { throw new SyntaxError('secret term'); } } });
    const t = await boom.sanction();
    const r2 = boom.cw.appeals.file(t.who, { noticeId: t.noticeId, statement: 'anything' });
    if (!r2.ok) throw new Error('refused');
    expect(boom.cw.appeals.get(r2.appeal.id)?.statementFlagged).toBe(false);
    expect(boom.logged.some(([e, d]) => e === 'chatwarden.appeal_failed' && (d as { error: string }).error === 'SyntaxError')).toBe(true);
    expect(JSON.stringify(boom.logged)).not.toContain('secret term');
    // retention cleared the statement: null, and not flagged
    boom.store.decideAppeal(r2.appeal.id, { status: 'upheld', at: NOW, by: 'bea', reason: 'r', replacementGroupId: null, clearStatement: true });
    expect(boom.cw.appeals.get(r2.appeal.id)).toMatchObject({ statement: null, statementFlagged: false });
  });
});

describe('openCount', () => {
  it('tracks file, decide and moot', async () => {
    const k = await appealsKit({}, { perPlayerPerWeek: 20 });
    expect(k.cw.appeals.openCount()).toBe(0);
    const [a, b, c] = [await k.sanction(), await k.sanction(), await k.sanction()];
    const ra = k.cw.appeals.file(a.who, { noticeId: a.noticeId, statement: 'x' });
    k.cw.appeals.file(b.who, { noticeId: b.noticeId, statement: 'x' });
    k.cw.appeals.file(c.who, { noticeId: c.noticeId, statement: 'x' });
    expect(k.cw.appeals.openCount()).toBe(3);
    if (!ra.ok) throw new Error('refused');
    await k.cw.appeals.decide({ appealId: ra.appeal.id, outcome: 'uphold', actor: 'senior_bea', reason: 'r' });
    expect(k.cw.appeals.openCount()).toBe(2);
    await k.cw.sanctions.revoke(b.groupId, 'mod_cy', 'lifted');
    expect(k.cw.appeals.openCount()).toBe(1);
  });
});

// KitEngine (here with the staff calls the tests add) runs the REAL @chatwarden/core kit (with the matcher's synthetic pack and the in-memory store) behind the
// DemoEngine interface. Nothing here is faked: invented terms are refused by the matcher under Community Rule 1,
// reports carry the real evidence buffer, a decision makes the kit's own PlayerNotice with the chosen line masked, and so on.
// (Ported from the old FakeEngine suite; every assertion that changed because the real kit differs is listed in
// .superpowers/sdd/2026-11-10-k8b-landing-site/task-3-report.md.)
import { describe, expect, it } from 'vitest';
import { SYNTHETIC_TERMS } from '../../packages/matcher/src/fixtures/syntheticPack';
import { StaffEngine } from './helpers/staffEngine';
import type { DecisionInput as KitDecisionInput, ReportCategory } from '@chatwarden/core';

/** What the tests send: the engine adds the moderator's name and source. */
type DecisionInput = Omit<KitDecisionInput, 'actor' | 'source'>;

function make() {
  let t = Date.UTC(2026, 10, 10, 12, 0, 0);
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { engine: new StaffEngine({ clock }), clock };
}

async function say(e: StaffEngine, seat: string, text: string, clock?: { advance(ms: number): number }) {
  const r = await e.chat.accept(seat, text);
  clock?.advance(1500);
  return r;
}

/** Bo says a rude line (and a blocked one), You reports the rude line. */
async function filed(category: ReportCategory = 'harassment', line = "uninstall the game, you're hopeless") {
  const { engine, clock } = make();
  await say(engine, 'ada', 'gg, that last clutch was wild', clock);
  await say(engine, 'bo', 'you absolute zorbak', clock);
  const rude = await say(engine, 'bo', line, clock);
  if (!('deliver' in rude)) throw new Error('setup: line should be delivered');
  const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: rude.deliver.lineId, category });
  if (!res.ok) throw new Error('setup: report refused');
  return { engine, clock, lineId: rude.deliver.lineId, reportId: res.reportId };
}

describe('the invented terms', () => {
  it('every positive line of the fixtures pack is refused as blocked, each on a fresh kit (no strike carries over)', async () => {
    const missed: string[] = [];
    for (const term of SYNTHETIC_TERMS) {
      for (const line of term.positive) {
        const r = await make().engine.chat.accept('you', line);
        if (!('refuse' in r) || r.refuse.reason !== 'blocked') missed.push(line);
      }
    }
    expect(missed).toEqual([]);
  });
  it('the fixtures negatives are delivered (whole words only)', async () => {
    const { engine, clock } = make();
    const wrongly: string[] = [];
    for (const term of SYNTHETIC_TERMS) {
      for (const line of term.negative) {
        const r = await engine.chat.accept('you', line);
        clock.advance(2000);
        if (!('deliver' in r)) wrongly.push(line);
      }
    }
    expect(wrongly).toEqual([]);
  });
});

describe('chat.accept', () => {
  it('refuses an invented term under Community Rule 1, with reason blocked', async () => {
    const { engine } = make();
    const r = await engine.chat.accept('you', 'you absolute zorbak');
    expect(r).toEqual({ refuse: { reason: 'blocked', rule: 1 } });
    expect(engine.rules.label(1)).toMatch(/^Community Rule 1/);
  });
  it('catches case, accents, look-alikes and glued punctuation', async () => {
    const { engine, clock } = make();
    for (const line of ['ZORBAK', 'zórbák', 'z0rbak!', '(zorbak)', 'ｚｏｒｂａｋ', 'vlemmo', 'f3nr1sk']) {
      const r = await engine.chat.accept('you', line);
      clock.advance(2000);
      expect('refuse' in r, line).toBe(true);
    }
  });
  it('delivers trash talk, with the text unchanged', async () => {
    const { engine } = make();
    const r = await engine.chat.accept('bo', "ez, you're trash lol");
    expect('deliver' in r && r.deliver.text).toBe("ez, you're trash lol");
    expect('deliver' in r && r.deliver.lineId.length).toBeGreaterThan(0);
  });
  it('delivers an exception phrase and a whole-word near miss', async () => {
    const { engine, clock } = make();
    for (const line of ['tarvo lake is a map', 'zorbaking', 'szorbak', 'zorba']) {
      const r = await engine.chat.accept('you', line);
      clock.advance(2000);
      expect('deliver' in r, line).toBe(true);
    }
  });
  it('refuses empty and whitespace-only lines as empty (stay silent)', async () => {
    const { engine } = make();
    expect(await engine.chat.accept('you', '')).toEqual({ refuse: { reason: 'empty' } });
    expect(await engine.chat.accept('you', '   \n ')).toEqual({ refuse: { reason: 'empty' } });
  });
  it('refuses a line over 200 characters as length, and accepts one of exactly 200', async () => {
    const { engine, clock } = make();
    const ok = await engine.chat.accept('you', 'a'.repeat(200));
    clock.advance(2000);
    const long = await engine.chat.accept('you', 'a'.repeat(201));
    expect('deliver' in ok).toBe(true);
    expect(long).toEqual({ refuse: { reason: 'length' } });
  });
  it('rate-limits a seat that floods, and lets it chat again after a pause', async () => {
    const { engine, clock } = make();
    const results = [];
    for (let i = 0; i < 12; i++) results.push(await engine.chat.accept('you', `line ${i}`));
    expect(results.some((r) => 'refuse' in r && r.refuse.reason === 'rate')).toBe(true);
    clock.advance(10_000);
    expect('deliver' in (await engine.chat.accept('you', 'back again'))).toBe(true);
  });
  it('does not rate-limit two different seats against each other (the kit allows 3 lines per 5 s per seat)', async () => {
    const { engine } = make();
    for (let i = 0; i < 3; i++) {
      expect('deliver' in (await engine.chat.accept('ada', `a${i}`))).toBe(true);
      expect('deliver' in (await engine.chat.accept('bo', `b${i}`))).toBe(true);
    }
    // the fourth line inside the window is Ada's to be refused; You still has all of her own budget
    expect(await engine.chat.accept('ada', 'a3')).toEqual({ refuse: { reason: 'rate' } });
    expect('deliver' in (await engine.chat.accept('you', 'still free'))).toBe(true);
  });
  it('the rate limit is the real one: 3 lines in 5 seconds, the 4th is refused, and the window slides', async () => {
    const { engine, clock } = make();
    for (let i = 0; i < 3; i++) expect('deliver' in (await engine.chat.accept('you', `line ${i}`))).toBe(true);
    expect(await engine.chat.accept('you', 'line 3')).toEqual({ refuse: { reason: 'rate' } });
    clock.advance(4_999);
    expect(await engine.chat.accept('you', 'line 4')).toEqual({ refuse: { reason: 'rate' } });
    clock.advance(2);
    expect('deliver' in (await engine.chat.accept('you', 'line 5'))).toBe(true);
  });
  it('a seat nobody sits in gets the kit own answer (gate), rather than a throw', async () => {
    const { engine } = make();
    await expect(engine.chat.accept('nobody', 'hello')).resolves.toEqual({ refuse: { reason: 'gate' } });
  });
});

describe('the 200 cap counts UTF-16 units of the trimmed text, like the kit (chat.ts: trimmed.length)', () => {
  it('accepts 100 emoji (200 units) and refuses 101 (202 units)', async () => {
    const { engine, clock } = make();
    const ok = await engine.chat.accept('you', '\u{1F600}'.repeat(100));
    clock.advance(2000);
    const long = await engine.chat.accept('you', '\u{1F600}'.repeat(101));
    expect('deliver' in ok).toBe(true);
    expect(long).toEqual({ refuse: { reason: 'length' } });
  });
  it('a ZWJ family emoji costs 11 units: 18 fit (198), 19 do not (209)', async () => {
    const { engine, clock } = make();
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
    expect(family.length).toBe(11);
    expect('deliver' in (await engine.chat.accept('you', family.repeat(18)))).toBe(true);
    clock.advance(2000);
    expect(await engine.chat.accept('you', family.repeat(19))).toEqual({ refuse: { reason: 'length' } });
  });
  it('a lone surrogate is one unit: 200 pass, 201 do not', async () => {
    const { engine, clock } = make();
    expect('deliver' in (await engine.chat.accept('you', '\ud83d'.repeat(200)))).toBe(true);
    clock.advance(2000);
    expect(await engine.chat.accept('you', '\ud83d'.repeat(201))).toEqual({ refuse: { reason: 'length' } });
  });
  it('trims first: 200 units plus surrounding whitespace is fine, and whitespace alone is empty', async () => {
    const { engine, clock } = make();
    expect('deliver' in (await engine.chat.accept('you', `  ${'a'.repeat(200)}  `))).toBe(true);
    clock.advance(2000);
    expect(await engine.chat.accept('you', ' '.repeat(300))).toEqual({ refuse: { reason: 'empty' } });
  });
  it('a blocked word on a too-long line is refused for length first (the kit checks length before the matcher)', async () => {
    const { engine } = make();
    expect(await engine.chat.accept('you', `zorbak ${'\u{1F600}'.repeat(101)}`)).toEqual({ refuse: { reason: 'length' } });
  });
});

describe('reports', () => {
  it('files a report for a delivered line and counts down the daily allowance (the kit allows 10)', async () => {
    const { engine, clock } = make();
    const a = await say(engine, 'bo', 'ez', clock);
    const b = await say(engine, 'ada', 'rematch?', clock);
    if (!('deliver' in a) || !('deliver' in b)) throw new Error('setup');
    const one = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: a.deliver.lineId, category: 'harassment' });
    const two = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'ada', lineId: b.deliver.lineId, category: 'harassment' });
    expect(one).toMatchObject({ ok: true, remaining: 9 });
    expect(two).toMatchObject({ ok: true, remaining: 8 });
  });
  it('refuses a second report of the same person in the room, even for another line (duplicate)', async () => {
    const { engine, clock } = make();
    const a = await say(engine, 'bo', 'ez', clock);
    const b = await say(engine, 'bo', 'rematch?', clock);
    if (!('deliver' in a) || !('deliver' in b)) throw new Error('setup');
    expect(await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: a.deliver.lineId, category: 'harassment' })).toMatchObject({ ok: true });
    expect(await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: b.deliver.lineId, category: 'harassment' })).toEqual({
      ok: false,
      refused: 'duplicate',
    });
  });
  it('refuses reporting yourself', async () => {
    const { engine, clock } = make();
    const mine = await say(engine, 'you', 'hello', clock);
    if (!('deliver' in mine)) throw new Error('setup');
    const r = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'you', lineId: mine.deliver.lineId, category: 'spam' });
    expect(r).toEqual({ ok: false, refused: 'self' });
  });
  it('refuses the same report twice from the same reporter (duplicate)', async () => {
    const { engine, lineId } = await filed();
    const again = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId, category: 'harassment' });
    expect(again).toEqual({ ok: false, refused: 'duplicate' });
  });
  it('refuses an unknown target seat, and stores an unknown category as other (the kit coerces it)', async () => {
    const { engine } = make();
    expect(await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'nobody', category: 'spam' })).toEqual({ ok: false, refused: 'not_player' });
    expect(await engine.reports.submit({ reporterSeat: 'nobody', targetSeat: 'bo', category: 'spam' })).toEqual({ ok: false, refused: 'off' });
    const odd = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', category: 'nonsense' as ReportCategory });
    expect(odd.ok).toBe(true);
    if (odd.ok) expect((await engine.staff.get(odd.reportId))?.category).toBe('other');
  });
  it("cannot report a line only its sender saw (a refused line is not in anyone else's view)", async () => {
    const { engine } = make();
    const r = await engine.chat.accept('bo', 'you absolute zorbak');
    expect('refuse' in r).toBe(true);
    // there is no lineId to give for a refused line, so a report must name the seat; that works and carries the evidence
    const filedOk = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', category: 'harassment' });
    expect(filedOk.ok).toBe(true);
  });
  it('carries the last lines as evidence, the reported line included, blocked lines marked', async () => {
    const { engine, lineId, reportId } = await filed();
    const report = await engine.staff.get(reportId);
    expect(report).not.toBeNull();
    const r = report!;
    expect(r.category).toBe('harassment');
    expect(r.reporterHandle).toBe('You');
    expect(r.targetHandle).toBe('Bo');
    expect(r.lineId).toBe(lineId);
    expect(r.excerpt.map((l) => l.raw)).toContain("uninstall the game, you're hopeless");
    expect(r.excerpt.length).toBeLessThanOrEqual(6);
    const blocked = r.excerpt.filter((l) => l.blocked);
    expect(blocked).toHaveLength(1);
    expect(blocked[0]).toMatchObject({ handle: 'Bo', delivered: null, raw: 'you absolute zorbak' });
    expect(r.excerpt.filter((l) => !l.blocked).every((l) => l.delivered === l.raw)).toBe(true);
  });
  it('the evidence is the kit buffer: every recent line of the room, not a six-line window', async () => {
    const { engine, clock } = make();
    let last = '';
    for (let i = 0; i < 20; i++) {
      const r = await say(engine, i % 2 ? 'ada' : 'bo', `message ${i}`, clock);
      if ('deliver' in r) last = r.deliver.lineId;
    }
    const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: last, category: 'spam' });
    if (!res.ok) throw new Error('setup');
    const report = await engine.staff.get(res.reportId);
    expect(report!.excerpt).toHaveLength(20);
    expect(report!.excerpt.map((l) => l.lineId)).toContain(last);
  });
  it('the evidence buffer holds 100 lines at most and forgets lines older than 15 minutes', async () => {
    const { engine, clock } = make();
    const old = await engine.chat.accept('ada', 'an old line');
    if (!('deliver' in old)) throw new Error('setup');
    clock.advance(16 * 60_000);
    let last = '';
    for (let i = 0; i < 120; i++) {
      const r = await engine.chat.accept(i % 2 ? 'ada' : 'bo', `m${i}`);
      clock.advance(2_000);
      if ('deliver' in r) last = r.deliver.lineId;
    }
    const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: last, category: 'spam' });
    if (!res.ok) throw new Error('setup');
    const excerpt = (await engine.staff.get(res.reportId))!.excerpt;
    expect(excerpt).toHaveLength(100);
    expect(excerpt.map((l) => l.raw)).not.toContain('an old line');
    expect(excerpt.at(-1)?.raw).toBe('m119');
  });
  it("lists the target's own lines for the picker, and only theirs", async () => {
    const { engine, reportId } = await filed();
    const report = (await engine.staff.get(reportId))!;
    const own = report.ownLineIds[report.targetPerson] ?? [];
    expect(own.length).toBe(2);
    for (const id of own) expect(report.excerpt.find((l) => l.lineId === id)?.handle).toBe('Bo');
  });
  it('lists open reports, newest first, and get() of an unknown id is null', async () => {
    const { engine, clock } = make();
    const a = await say(engine, 'bo', 'one', clock);
    const b = await say(engine, 'ada', 'two', clock);
    if (!('deliver' in a) || !('deliver' in b)) throw new Error('setup');
    const r1 = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: a.deliver.lineId, category: 'spam' });
    clock.advance(1000);
    const r2 = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'ada', lineId: b.deliver.lineId, category: 'spam' });
    if (!r1.ok || !r2.ok) throw new Error('setup');
    const page = await engine.staff.list({ status: 'open' });
    expect(page.items.map((r) => r.id)).toEqual([r2.reportId, r1.reportId]);
    expect(page.next).toBeNull();
    await expect(engine.staff.get('nope')).resolves.toBeNull();
  });
  it('never puts a subject id in a place meant for players (staff report carries it, notices never do)', async () => {
    const { engine, reportId } = await filed();
    const report = (await engine.staff.get(reportId))!;
    const decision = await engine.staff.decide({
      reportId,
      verdict: 'upheld',
      reason: 'insults',
      actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect(decision.ok).toBe(true);
    const notices = await engine.notices.pending('bo');
    const blob = JSON.stringify(notices);
    expect(blob).not.toContain(report.targetPerson);
    expect(blob).not.toMatch(/You|insults/); // neither the reporter's handle nor the moderator's private reason
  });
});

describe('decide, notices and ack', () => {
  async function warn() {
    const ctx = await filed();
    const report = (await ctx.engine.staff.get(ctx.reportId))!;
    const result = await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'insults a teammate',
      actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 2, lineIds: [ctx.lineId] }],
    });
    return { ...ctx, report, result };
  }

  it('upheld + warning closes the report and makes one notice group', async () => {
    const { engine, reportId, result } = await warn();
    expect(result).toMatchObject({ ok: true, replay: false });
    if (!result.ok) return;
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({ kind: 'warning' });
    expect(result.groups[0]?.noticeId).toBeTruthy();
    expect((await engine.staff.get(reportId))!.status).toBe('actioned');
    expect((await engine.staff.list({ status: 'open' })).items).toHaveLength(0);
  });
  it('the player gets a warning notice: the rule, a ref code, their chosen line, and must acknowledge', async () => {
    const { engine } = await warn();
    const pending = await engine.notices.pending('bo');
    expect(pending).toHaveLength(1);
    const n = pending[0]!;
    expect(n.kind).toBe('warning');
    expect(n.mustAcknowledge).toBe(true);
    expect(n.until).toBeNull();
    expect(n.rule).toBe(2);
    expect(n.ruleLabel).toMatch(/^Community Rule 2: /);
    expect(n.refCode).toMatch(/^[A-Z0-9]+-[A-Z0-9]{4,}$/);
    expect(n.excerpt.map((e) => e.text)).toEqual(["uninstall the game, you're hopeless"]);
    expect(n.excerpt[0]?.day).toBe('2026-11-10');
  });
  it('masks a blocked word in the chosen line (the player sees stars, never the word)', async () => {
    const ctx = await filed();
    const report = (await ctx.engine.staff.get(ctx.reportId))!;
    const blockedId = report.excerpt.find((l) => l.blocked)!.lineId;
    await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 1, lineIds: [blockedId, ctx.lineId] }],
    });
    const n = (await ctx.engine.notices.pending('bo'))[0]!;
    expect(n.excerpt).toHaveLength(2);
    expect(n.excerpt[0]?.text).toBe('you absolute ******');
    expect(JSON.stringify(n)).not.toMatch(/zorbak/i);
    expect(report.excerpt.some((l) => l.raw.includes('zorbak'))).toBe(true); // staff still see it
  });
  it('masks look-alike and glued forms the same way, keeping the line length', async () => {
    const { engine, clock } = make();
    await say(engine, 'bo', 'you z0rbak!! lol', clock);
    const ok = await say(engine, 'bo', 'rematch?', clock);
    if (!('deliver' in ok)) throw new Error('setup');
    const res = await engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: ok.deliver.lineId, category: 'harassment' });
    if (!res.ok) throw new Error('setup');
    const report = (await engine.staff.get(res.reportId))!;
    const blocked = report.excerpt.find((l) => l.blocked)!;
    await engine.staff.decide({
      reportId: res.reportId,
      verdict: 'upheld',
      reason: 'r',
      actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule: 1, lineIds: [blocked.lineId] }],
    });
    const text = (await engine.notices.pending('bo'))[0]!.excerpt[0]!.text;
    expect(text).toHaveLength('you z0rbak!! lol'.length);
    expect(text).not.toMatch(/z0rbak/i);
    expect(text).toMatch(/^you \*+!! lol$/);
  });
  it('a notice with no chosen line has an empty excerpt', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'warning', durationMs: null, rule: 2 }],
    });
    expect((await ctx.engine.notices.pending('bo'))[0]?.excerpt).toEqual([]);
  });
  it('a timeout makes a chat notice with an end time and restricts the seat until then', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const res = await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'chat', durationMs: 600_000, rule: 2, lineIds: [ctx.lineId] }],
    });
    expect(res.ok).toBe(true);
    const n = (await ctx.engine.notices.pending('bo'))[0]!;
    expect(n.kind).toBe('chat');
    expect(n.until).toBe(ctx.clock.now() + 600_000);
    const state = (await ctx.engine.rooms.seats()).find((s) => s.id === 'bo')!;
    expect(state.restrictedUntil).toBe(n.until);
    expect(await ctx.engine.chat.accept('bo', 'hello?')).toEqual({
      refuse: { reason: 'restricted', until: n.until, byModerator: true, rule: 2, noticeId: n.id },
    });
    // the others chat on, and the timeout ends by itself
    expect('deliver' in (await ctx.engine.chat.accept('ada', 'hi'))).toBe(true);
    ctx.clock.advance(600_001);
    expect('deliver' in (await ctx.engine.chat.accept('bo', 'back'))).toBe(true);
    expect((await ctx.engine.rooms.seats()).find((s) => s.id === 'bo')!.restrictedUntil).toBeNull();
  });
  it('ack clears the pending notice, keeps it on the record, and is false for the wrong player or an unknown id', async () => {
    const { engine } = await warn();
    const n = (await engine.notices.pending('bo'))[0]!;
    expect(await engine.notices.ack('ada', n.id)).toBe(false);
    expect(await engine.notices.ack('bo', 'nope')).toBe(false);
    expect(await engine.notices.pending('bo')).toHaveLength(1);
    expect(await engine.notices.ack('bo', n.id)).toBe(true);
    expect(await engine.notices.pending('bo')).toHaveLength(0);
    expect(await engine.notices.ack('bo', n.id)).toBe(true); // acking twice is fine
    const record = await engine.notices.record('bo');
    expect(record.map((x) => x.id)).toEqual([n.id]);
  });
  it('other players get no notice, and an untouched player has an empty record', async () => {
    const { engine } = await warn();
    expect(await engine.notices.pending('ada')).toEqual([]);
    expect(await engine.notices.record('you')).toEqual([]);
  });
  it('a note keeps the record for staff and tells the player nothing', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const res = await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'noted',
      reason: 'watching',
      actions: [{ subject: r.targetPerson, kind: 'note', durationMs: null, rule: 2 }],
    });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) expect(res.groups[0]?.noticeId).toBeNull();
    expect(await ctx.engine.notices.pending('bo')).toEqual([]);
    expect(await ctx.engine.notices.record('bo')).toEqual([]);
    expect((await ctx.engine.staff.get(ctx.reportId))!.status).toBe('actioned');
  });
  it('no action dismisses the report and tells nobody', async () => {
    const ctx = await filed();
    const res = await ctx.engine.staff.decide({ reportId: ctx.reportId, verdict: 'no_action', reason: 'fine', actions: [] });
    expect(res).toEqual({ ok: true, groups: [], replay: false });
    expect((await ctx.engine.staff.get(ctx.reportId))!.status).toBe('dismissed');
    expect(await ctx.engine.notices.pending('bo')).toEqual([]);
  });
  it('the same decision sent twice is a replay and applies nothing twice; a different one is already_decided', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const input: DecisionInput = {
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'warning', durationMs: null, rule: 2 }],
    };
    const first = await ctx.engine.staff.decide(input);
    const second = await ctx.engine.staff.decide(input);
    expect(first).toMatchObject({ ok: true, replay: false });
    expect(second).toMatchObject({ ok: true, replay: true });
    expect(await ctx.engine.notices.pending('bo')).toHaveLength(1);
    expect(await ctx.engine.staff.decide({ ...input, verdict: 'no_action', actions: [] })).toEqual({ ok: false, error: 'already_decided' });
  });
  it('rejects malformed decisions as invalid and writes nothing', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const warning = { subject: r.targetPerson, kind: 'warning' as const, durationMs: null, rule: 2 };
    const bad: DecisionInput[] = [
      { reportId: ctx.reportId, verdict: 'upheld', reason: '', actions: [warning] }, // reason required
      { reportId: ctx.reportId, verdict: 'upheld', reason: '   ', actions: [warning] },
      { reportId: ctx.reportId, verdict: 'upheld', reason: 'x'.repeat(501), actions: [warning] },
      { reportId: ctx.reportId, verdict: 'noted', reason: 'x', actions: [warning] }, // noted needs notes only
      { reportId: ctx.reportId, verdict: 'no_action', reason: 'x', actions: [warning] }, // no action on the target
      { reportId: ctx.reportId, verdict: 'bad_faith', reason: 'x', actions: [] }, // needs evidence
      { reportId: ctx.reportId, verdict: 'upheld', reason: 'x', actions: [{ ...warning, durationMs: 5 }] }, // warning has no length
      { reportId: ctx.reportId, verdict: 'upheld', reason: 'x', actions: [{ ...warning, rule: 2, lineIds: ['not-a-line'] }] },
      { reportId: ctx.reportId, verdict: 'upheld', reason: 'x', actions: [{ ...warning, rule: 'uncovered' }] }, // needs a gap note
    ];
    for (const input of bad) expect(await ctx.engine.staff.decide(input), JSON.stringify(input)).toEqual({ ok: false, error: 'invalid' });
    expect((await ctx.engine.staff.get(ctx.reportId))!.status).toBe('open');
    expect(await ctx.engine.notices.pending('bo')).toEqual([]);
  });
  it("refuses to quote someone else's line in the notice (foreign line)", async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const adaLine = r.excerpt.find((l) => l.handle === 'Ada')!;
    const res = await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'warning', durationMs: null, rule: 2, lineIds: [adaLine.lineId] }],
    });
    expect(res).toEqual({ ok: false, error: 'invalid' });
  });
  it('unknown report is not_found; an uncovered rule needs and accepts a gap note', async () => {
    const ctx = await filed('other');
    expect(await ctx.engine.staff.decide({ reportId: 'nope', verdict: 'no_action', reason: 'x', actions: [] })).toEqual({ ok: false, error: 'not_found' });
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    const res = await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'warning', durationMs: null, rule: 'uncovered', gapNote: 'not covered yet' }],
    });
    expect(res.ok).toBe(true);
    expect((await ctx.engine.notices.pending('bo'))[0]?.ruleLabel).toBe('Not covered by a rule yet');
    expect(JSON.stringify(await ctx.engine.notices.pending('bo'))).not.toMatch(/not covered yet|gapNote/);
  });
});

describe('reset', () => {
  it('clears lines, reports, sanctions, notices and the rate counters', async () => {
    const ctx = await filed();
    const r = (await ctx.engine.staff.get(ctx.reportId))!;
    await ctx.engine.staff.decide({
      reportId: ctx.reportId,
      verdict: 'upheld',
      reason: 'x',
      actions: [{ subject: r.targetPerson, kind: 'chat', durationMs: 600_000, rule: 2 }],
    });
    await ctx.engine.reset();
    expect((await ctx.engine.staff.list()).items).toEqual([]);
    expect(await ctx.engine.staff.get(ctx.reportId)).toBeNull();
    expect(await ctx.engine.notices.pending('bo')).toEqual([]);
    expect(await ctx.engine.notices.record('bo')).toEqual([]);
    expect((await ctx.engine.rooms.seats()).every((s) => s.restrictedUntil === null)).toBe(true);
    expect('deliver' in (await ctx.engine.chat.accept('bo', 'fresh start'))).toBe(true);
    // a report after reset starts from a full allowance and has only the new line as evidence
    const line = await ctx.engine.chat.accept('bo', 'one more');
    if (!('deliver' in line)) throw new Error('setup');
    const filedAgain = await ctx.engine.reports.submit({ reporterSeat: 'you', targetSeat: 'bo', lineId: line.deliver.lineId, category: 'spam' });
    expect(filedAgain).toMatchObject({ ok: true, remaining: 9 });
    if (filedAgain.ok) expect((await ctx.engine.staff.get(filedAgain.reportId))!.excerpt.map((l) => l.raw)).toEqual(['fresh start', 'one more']);
  });
});

describe('seats', () => {
  it('has You plus two scripted players, and only You is marked', async () => {
    const { engine } = make();
    expect(engine.seats.map((s) => s.name)).toEqual(['You', 'Ada', 'Bo']);
    expect(engine.seats.filter((s) => s.you).map((s) => s.id)).toEqual(['you']);
    expect((await engine.rooms.seats()).map((s) => s.id)).toEqual(['you', 'ada', 'bo']);
  });
  it('says plainly what runs it', () => {
    expect(make().engine.note).toBe('The real packages, running in your browser. The blocked words are made up, like "zorbak".');
    expect(make().engine.noteDetails).toContain('You get no "action taken" notice for your own reports');
    expect(make().engine.note).not.toMatch(/stand-in/i);
  });
});

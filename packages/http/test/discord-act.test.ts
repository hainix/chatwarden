import { describe, expect, it } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { checkRows } from '@chatwarden/discord';
import { ROLE_SENIOR, USER_2, USER_ID, answerOf, botWorld, buttonsOf, contentOf, hubLink } from './discord-world.js';
import type { BotWorld, BotWorldOptions } from './discord-world.js';
import { DAY } from './world.js';

// Act from Discord: the buttons, the preview and the confirm (K5 D5, Review Focus 2, 3 and 4). Every decision goes through `decideAs`, so the
// permission, claim and duration rules are the hub's; the actor, role and source come from the signed payload and the options, never the custom_id.

type Outcome = 'none' | 'note' | 'warning' | { kind: 'chat' | 'area' | 'ban'; durationMs: number | null };
const ACTIONS = { dismiss: true, suggestion: true };
const DONE_REASON = 'Profile suggestion, accepted in Discord';
const STANDARD_DISMISSAL = 'No action needed';

/** A kit whose suggestion is fixed (the real ladder is tested in core); everything else is real. */
const fixedSuggest = (outcome: Outcome) => (cw: Chatwarden): Chatwarden =>
  new Proxy(cw, {
    get(target, prop, receiver) {
      if (prop === 'suggest') return () => ({ outcome, label: 'Fixed label', why: 'Because the fixture says so.' });
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

interface Rig extends BotWorld {
  closedEvents: KitEvent[];
  filed: (category?: Parameters<BotWorld['w']['file']>[0]) => Promise<{ id: string; target: string }>;
  rows: (action: string) => Array<Record<string, unknown>>;
  /** The confirm button's custom_id out of a preview answer. */
  confirmId: (res: { status: number; body: unknown }) => string;
  click: (customId: string, who?: Parameters<BotWorld['client']['click']>[1]) => ReturnType<BotWorld['send']>;
}

async function rig(over: BotWorldOptions & { outcome?: Outcome } = {}): Promise<Rig> {
  const { outcome, ...rest } = over;
  const b = await botWorld({
    ...rest,
    options: { actions: ACTIONS, ...rest.options },
    ...(outcome === undefined ? {} : { wrapKit: fixedSuggest(outcome) }),
  });
  const closedEvents: KitEvent[] = [];
  b.cw.on('report.closed', (e) => void closedEvents.push(e));
  return {
    ...b,
    closedEvents,
    filed: (category) => b.w.file(category),
    rows: (action) => b.w.audit().filter((r) => r.action === action) as unknown as Array<Record<string, unknown>>,
    confirmId: (res) => {
      const confirm = buttonsOf(res).find((x) => typeof x.custom_id === 'string' && String(x.custom_id).startsWith('cw1:ok:'));
      if (confirm === undefined) throw new Error('no confirm button');
      return confirm.custom_id as string;
    },
    click: (customId, who) => b.send(b.client.click(customId, who)),
  };
}

const dis = (id: string): string => `cw1:dis:${id}`;
const sug = (id: string): string => `cw1:sug:${id}`;

describe('components: the buttons on a report post', () => {
  it('off by default (undefined); with actions the row has the two buttons and the link', async () => {
    const plain = await botWorld();
    expect(plain.bot.components({ kind: 'report', reportId: 'abc' })).toBeUndefined();
    const b = await rig();
    const rows = b.bot.components({ kind: 'report', reportId: 'ReportIdOneTwoThreeFour' });
    expect(rows).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 2, label: 'Nothing wrong here', custom_id: 'cw1:dis:ReportIdOneTwoThreeFour' },
          { type: 2, style: 1, label: 'Apply suggestion', custom_id: 'cw1:sug:ReportIdOneTwoThreeFour' },
          { type: 2, style: 5, label: 'Open report', url: 'https://hub.example.test/reports/ReportIdOneTwoThreeFour' },
        ],
      },
    ]);
  });

  it('with suggestion false only dismiss and the link; with dismiss false only suggestion and the link; with both false nothing', async () => {
    const onlyDismiss = await rig({ options: { actions: { suggestion: false } } });
    expect(buttonsRow(onlyDismiss, 'r1').map((x) => x.label)).toEqual(['Nothing wrong here', 'Open report']);
    const onlySuggest = await rig({ options: { actions: { dismiss: false } } });
    expect(buttonsRow(onlySuggest, 'r1').map((x) => x.label)).toEqual(['Apply suggestion', 'Open report']);
    const none = await rig({ options: { actions: { dismiss: false, suggestion: false } } });
    expect(none.bot.components({ kind: 'report', reportId: 'r1' })).toBeUndefined();
  });

  it('the link is hubLink(report, id); a hubLink that throws or gives junk drops the link, not the row', async () => {
    const b = await rig({ options: { hubLink: () => { throw new Error('hub down'); } } });
    expect(buttonsRow(b, 'r1').map((x) => x.label)).toEqual(['Nothing wrong here', 'Apply suggestion']);
    const junk = await rig({ options: { hubLink: () => 'javascript:alert(1)' } });
    expect(buttonsRow(junk, 'r1').map((x) => x.label)).toEqual(['Nothing wrong here', 'Apply suggestion']);
    const long = await rig({ options: { hubLink: () => `https://hub.example.test/${'p'.repeat(600)}` } });
    expect(buttonsRow(long, 'r1').map((x) => x.label)).toEqual(['Nothing wrong here', 'Apply suggestion']);
    const seen: string[][] = [];
    const spy = await rig({ options: { hubLink: (k, id) => (seen.push([k, id]), hubLink(k, id)) } });
    spy.bot.components({ kind: 'report', reportId: 'r1' });
    expect(seen).toEqual([['report', 'r1']]);
  });

  it('what the bot makes passes the feed\'s own check, and a report id the grammar cannot hold gives no buttons', async () => {
    const b = await rig();
    const rows = b.bot.components({ kind: 'report', reportId: 'ReportIdOneTwoThreeFour' });
    expect(checkRows(rows)).not.toBeNull();
    for (const reportId of ['', 'has space', 'a:b', 'x'.repeat(33), 5 as never, undefined as never]) {
      expect(b.bot.components({ kind: 'report', reportId }), String(reportId)).toBeUndefined();
    }
    expect(b.bot.components({ kind: 'sanction', reportId: 'r1' } as never)).toBeUndefined();
    expect(b.bot.components(null as never)).toBeUndefined();
  });
});

function buttonsRow(b: Rig, reportId: string): Array<Record<string, unknown>> {
  const rows = b.bot.components({ kind: 'report', reportId });
  return (rows?.[0]?.components ?? []) as unknown as Array<Record<string, unknown>>;
}

describe('dismiss: preview, confirm, done', () => {
  it('the preview shows a confirm and writes nothing; the confirm closes the report no_action with the standard reason, actor discord:<id>, source moderator, one report.decide row, one report.closed, and an UPDATE_MESSAGE with no buttons', async () => {
    const b = await rig();
    const f = await b.filed();
    const preview = await b.click(dis(f.id));
    expect(answerOf(preview).type).toBe(4);
    expect(contentOf(preview)).toContain('Nothing wrong here?');
    expect(buttonsOf(preview).map((x) => x.label)).toEqual(['Confirm', 'Cancel']);
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.rows('report.decide')).toEqual([]);

    const done = await b.click(b.confirmId(preview));
    const a = answerOf(done);
    expect(a.type).toBe(7);
    expect(a.data?.flags).toBe(64);
    expect(a.data?.allowed_mentions).toEqual({ parse: [] });
    expect(a.data?.components ?? []).toEqual([]);
    expect(a.data?.content).toBe('Done \u00B7 No action');

    const report = b.cw.reports.get(f.id);
    expect(report).toMatchObject({ status: 'dismissed', badFaith: false, actionedBy: `discord:${USER_ID}` });
    expect(report?.modNote).toBe(STANDARD_DISMISSAL);
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.rows('report.decide')[0]).toMatchObject({ actor: `discord:${USER_ID}`, role: 'moderator', target: { type: 'report', ref: f.id } });
    expect(b.closedEvents).toHaveLength(1);
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
  });

  it('the cancel button answers Cancelled. with no buttons and writes nothing', async () => {
    const b = await rig();
    const f = await b.filed();
    const res = await b.click('cw1:x');
    expect(answerOf(res)).toMatchObject({ type: 7, data: { content: 'Cancelled.', components: [], flags: 64 } });
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.rows('report.decide')).toEqual([]);
  });

  it('a second confirm of the same dismissal (a double click) answers Already done and writes nothing more', async () => {
    const b = await rig();
    const f = await b.filed();
    const confirm = b.confirmId(await b.click(dis(f.id)));
    await b.click(confirm);
    const again = await b.click(confirm);
    expect(contentOf(again)).toBe('Already done \u00B7 No action');
    expect(answerOf(again).type).toBe(7);
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.closedEvents).toHaveLength(1);
  });

  it('a person with only the actorOf mapping is audited as the mapped login', async () => {
    const b = await rig({ options: { actorOf: (id) => (id === USER_ID ? 'ann@example.test' : undefined) } });
    const f = await b.filed();
    await b.click(b.confirmId(await b.click(dis(f.id))));
    expect(b.rows('report.decide')[0]).toMatchObject({ actor: 'ann@example.test' });
    expect(b.cw.reports.get(f.id)?.actionedBy).toBe('ann@example.test');
  });
});

describe('suggestion: every outcome', () => {
  const cases: Array<[string, Outcome, { status: 'actioned' | 'dismissed'; kind?: string; durationMs?: number | null; step: RegExp; word: string }]> = [
    ['none (a dismissal)', 'none', { status: 'dismissed', step: /Fixed label/, word: 'Done \u00B7 No action' }],
    ['note', 'note', { status: 'actioned', kind: 'note', durationMs: null, step: /Fixed label/, word: 'Done \u00B7 Note' }],
    ['warning', 'warning', { status: 'actioned', kind: 'warning', durationMs: null, step: /Fixed label/, word: 'Done \u00B7 Warning' }],
    ['a 24 hour chat restriction', { kind: 'chat', durationMs: DAY }, { status: 'actioned', kind: 'chat', durationMs: DAY, step: /Fixed label/, word: 'Done \u00B7 Chat restriction \u00B7 24 hours' }],
    ['an area ban of 7 days', { kind: 'area', durationMs: 7 * DAY }, { status: 'actioned', kind: 'area', durationMs: 7 * DAY, step: /Fixed label/, word: 'Done \u00B7 Area ban \u00B7 7 days' }],
    ['a ban of 30 days', { kind: 'ban', durationMs: 30 * DAY }, { status: 'actioned', kind: 'ban', durationMs: 30 * DAY, step: /Fixed label/, word: 'Done \u00B7 Ban \u00B7 30 days' }],
  ];

  it.each(cases)('%s: the preview names the step, the rule and the why; the confirm applies exactly that, as the clicker, source moderator', async (_name, outcome, expected) => {
    const b = await rig({ outcome });
    const f = await b.filed('harassment');
    const preview = await b.click(sug(f.id));
    const text = contentOf(preview);
    expect(text).toMatch(expected.step);
    expect(text).toContain('Rule 2 (');
    expect(text).toContain('Because the fixture says so.');
    expect(b.rows('suggest')).toHaveLength(1);
    expect(b.rows('suggest')[0]).toMatchObject({ actor: `discord:${USER_ID}`, role: 'moderator', target: { type: 'report', ref: f.id } });
    expect(b.cw.reports.get(f.id)?.status).toBe('open');

    const done = await b.click(b.confirmId(preview));
    expect(contentOf(done)).toMatch(new RegExp(`^${expected.word.replace(/[\u00B7]/g, '\\u00B7')}(?: \\u00B7 M-[A-Z0-9]{5})?$`));
    expect(b.cw.reports.get(f.id)?.status).toBe(expected.status);
    const rows = b.cw.sanctions.forPerson(f.target);
    if (expected.kind === undefined) expect(rows).toEqual([]);
    else {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: expected.kind, rule: 2, source: 'moderator', actor: `discord:${USER_ID}`, reason: DONE_REASON });
      if (expected.kind !== 'warning' && expected.kind !== 'note') {
        expect(rows[0]?.endsAt === null ? null : (rows[0]?.endsAt as number) - (rows[0]?.startsAt as number)).toBe(expected.durationMs);
      }
    }
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.closedEvents).toHaveLength(1);
  });

  it('a permanent ban from a moderator role is refused (the forbidden text, nothing written); from a senior it is applied', async () => {
    const b = await rig({ outcome: { kind: 'ban', durationMs: null } });
    const f = await b.filed('harassment');
    const preview = await b.click(sug(f.id));
    expect(contentOf(preview)).toContain('Fixed label');
    const refused = await b.click(b.confirmId(preview));
    expect(contentOf(refused)).toBe('You do not have permission to do this.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(b.rows('report.decide')).toEqual([]);

    const seniorPreview = await b.click(sug(f.id), { roles: [ROLE_SENIOR], user: USER_2 });
    const done = await b.click(b.confirmId(seniorPreview), { roles: [ROLE_SENIOR], user: USER_2 });
    expect(contentOf(done)).toMatch(/^Done \u00B7 Ban \u00B7 permanent \u00B7 M-/);
    expect(b.cw.sanctions.forPerson(f.target)[0]).toMatchObject({ kind: 'ban', endsAt: null, actor: `discord:${USER_2}`, source: 'moderator' });
    expect(b.rows('report.decide')[0]).toMatchObject({ role: 'senior' });
  });

  it('the real ladder end to end: a first report of harassment is a 24 hour chat restriction', async () => {
    const b = await rig();
    const f = await b.filed('harassment');
    const preview = await b.click(sug(f.id));
    expect(contentOf(preview)).toContain('Restrict chat 24 hours');
    expect(contentOf(preview)).toContain('Rule 2 (');
    await b.click(b.confirmId(preview));
    expect(b.cw.sanctions.forPerson(f.target)[0]).toMatchObject({ kind: 'chat', rule: 2, reason: DONE_REASON });
  });

  it('the preview escapes the profile text, and cuts it', async () => {
    const evil = (cw: Chatwarden): Chatwarden =>
      new Proxy(cw, {
        get(target, prop, receiver) {
          if (prop === 'suggest') return () => ({ outcome: 'note', label: '**@everyone** <@123>', why: `[x](https://evil.example) ${'w'.repeat(2000)}` });
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const e = await rig({ wrapKit: evil });
    const f = await e.filed('harassment');
    const text = contentOf(await e.click(sug(f.id)));
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('<@123>');
    expect(text).not.toContain('](https');
  });
});

describe('a report whose suggested rule is uncovered', () => {
  it('cannot be acted on from Discord (the fixed text and the report link, nothing written); a dismissal can', async () => {
    const b = await rig();
    const f = await b.filed('other');
    const res = await b.click(sug(f.id));
    expect(contentOf(res)).toBe('This report needs a Community Rule chosen. Open it in the hub.');
    expect(buttonsOf(res)).toEqual([{ type: 2, style: 5, label: 'Open report', url: `https://hub.example.test/reports/${encodeURIComponent(f.id)}` }]);
    expect(b.rows('suggest')).toEqual([]);
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    // a forged confirm for a step on an uncovered report is the same refusal
    const forged = await b.click(`cw1:ok:${f.id}:chat.86400000.2`);
    expect(contentOf(forged)).toBe('This report needs a Community Rule chosen. Open it in the hub.');
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
    // dismissal needs no rule
    const done = await b.click(b.confirmId(await b.click(dis(f.id))));
    expect(contentOf(done)).toBe('Done \u00B7 No action');
    expect(b.cw.reports.get(f.id)?.status).toBe('dismissed');
  });
});

describe('with actions.confirm false the first click decides directly', () => {
  it('a dismissal: no preview message, the same checks, the same answer as a confirm, one row', async () => {
    const b = await rig({ options: { actions: { ...ACTIONS, confirm: false } } });
    const f = await b.filed();
    const res = await b.click(dis(f.id));
    // The click is on the PUBLIC report post: a type 7 would overwrite it for everyone. The answer is a new ephemeral message (type 4, flags 64).
    expect(answerOf(res)).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
    expect(contentOf(res)).toBe('Done \u00B7 No action');
    expect(b.cw.reports.get(f.id)?.status).toBe('dismissed');
    expect(b.rows('report.decide')).toHaveLength(1);
  });

  it('a suggestion: the same role, claim, rule, offered-length and audit checks (a suggest row and a decide row)', async () => {
    const b = await rig({ options: { actions: { ...ACTIONS, confirm: false } }, outcome: { kind: 'chat', durationMs: DAY } });
    const f = await b.filed('harassment');
    const res = await b.click(sug(f.id));
    expect(contentOf(res)).toMatch(/^Done \u00B7 Chat restriction \u00B7 24 hours \u00B7 M-/);
    expect(b.rows('suggest')).toHaveLength(1);
    expect(b.rows('report.decide')).toHaveLength(1);

    const ban = await rig({ options: { actions: { ...ACTIONS, confirm: false } }, outcome: { kind: 'ban', durationMs: null } });
    const g = await ban.filed('harassment');
    expect(contentOf(await ban.click(sug(g.id)))).toBe('You do not have permission to do this.');
    expect(ban.cw.reports.get(g.id)?.status).toBe('open');

    const claimed = await rig({ options: { actions: { ...ACTIONS, confirm: false } } });
    const h = await claimed.filed();
    claimed.cw.cases.claim(h.target, 'someone-else');
    expect(contentOf(await claimed.click(dis(h.id)))).toBe('Another moderator has this case open.');
    expect(claimed.cw.reports.get(h.id)?.status).toBe('open');

    const uncovered = await rig({ options: { actions: { ...ACTIONS, confirm: false } } });
    const k = await uncovered.filed('other');
    expect(contentOf(await uncovered.click(sug(k.id)))).toBe('This report needs a Community Rule chosen. Open it in the hub.');
  });
});

describe('with actions.confirm false no answer to the public post is a type 7', () => {
  const direct = { actions: { ...ACTIONS, confirm: false } };
  const ephemeralFour = { type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } };

  it('every refusal is a type 4 ephemeral message: claimed, changed, needs a rule, no permission, already decided, off', async () => {
    const claimed = await rig({ options: direct });
    const a = await claimed.filed();
    claimed.cw.cases.claim(a.target, 'someone-else');
    for (const id of [dis(a.id), sug(a.id)]) expect(answerOf(await claimed.click(id))).toMatchObject(ephemeralFour);

    const uncovered = await rig({ options: direct });
    const u = await uncovered.filed('other');
    const needsRule = await uncovered.click(sug(u.id));
    expect(answerOf(needsRule)).toMatchObject(ephemeralFour);
    expect(contentOf(needsRule)).toBe('This report needs a Community Rule chosen. Open it in the hub.');

    const ban = await rig({ options: direct, outcome: { kind: 'ban', durationMs: null } });
    const b = await ban.filed('harassment');
    const noPermission = await ban.click(sug(b.id));
    expect(answerOf(noPermission)).toMatchObject(ephemeralFour);
    expect(contentOf(noPermission)).toBe('You do not have permission to do this.');

    const decided = await rig({ options: direct });
    const d = await decided.filed();
    await decided.click(dis(d.id));
    const again = await decided.click(dis(d.id));
    expect(answerOf(again)).toMatchObject(ephemeralFour);
    expect(contentOf(again)).toMatch(/^This report was already decided/);
    const gone = await decided.click(dis('NoSuchReportIdOneTwoThree'));
    expect(answerOf(gone)).toMatchObject(ephemeralFour);

    const off = await rig({ options: { actions: { dismiss: false, suggestion: true, confirm: false } } });
    const o = await off.filed();
    const refused = await off.click(dis(o.id));
    expect(answerOf(refused)).toMatchObject(ephemeralFour);
    expect(contentOf(refused)).toBe('Actions from Discord are turned off.');
  });

  it('a success on a suggestion is type 4 too', async () => {
    const b = await rig({ options: direct, outcome: { kind: 'chat', durationMs: DAY } });
    const f = await b.filed('harassment');
    expect(answerOf(await b.click(sug(f.id)))).toMatchObject(ephemeralFour);
  });

  it('the two-step flow is unchanged: a preview is type 4, the confirm and its refusals are type 7 on the ephemeral preview, a cancel is type 7', async () => {
    const b = await rig();
    const f = await b.filed();
    const preview = await b.click(dis(f.id));
    expect(answerOf(preview).type).toBe(4);
    const confirmId = b.confirmId(preview);
    b.cw.cases.claim(f.target, 'someone-else');
    expect(answerOf(await b.click(confirmId)).type).toBe(7);
  });
});

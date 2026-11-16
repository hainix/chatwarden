import { describe, expect, it } from 'vitest';
import type { Chatwarden, KitEvent } from '@chatwarden/core';
import { ROLE_MOD, ROLE_SENIOR, USER_2, USER_ID, answerOf, botWorld, buttonsOf, contentOf } from './discord-world.js';
import type { BotWorld, BotWorldOptions } from './discord-world.js';
import { DAY } from './world.js';

// The hostile and the contended cases of acting from Discord (K5 D5, Review Focus 1, 2, 3 and 4): a claim held by another moderator, a report decided
// in the hub meanwhile, two confirms at once, a redelivered interaction, a forged custom_id, the actions turned off, an audit that fails, and what
// never leaks.

const ACTIONS = { dismiss: true, suggestion: true };
const CHAT_CODE = 'chat.86400000.2';

async function rig(over: BotWorldOptions = {}) {
  const b = await botWorld({ ...over, options: { actions: ACTIONS, ...over.options } });
  const closed: KitEvent[] = [];
  b.cw.on('report.closed', (e) => void closed.push(e));
  const confirmId = (res: { status: number; body: unknown }): string => {
    const found = buttonsOf(res).find((x) => String(x.custom_id ?? '').startsWith('cw1:ok:'));
    if (found === undefined) throw new Error('no confirm button');
    return found.custom_id as string;
  };
  const click = (customId: string, who?: Parameters<BotWorld['client']['click']>[1]) => b.send(b.client.click(customId, who));
  const rows = (action: string) => b.w.audit().filter((r) => r.action === action);
  return { ...b, closed, confirmId, click, rows };
}

/** A kit whose named audit actions fail to record (the rest record). */
const failingAudit = (failing: readonly string[]) => (cw: Chatwarden): Chatwarden =>
  new Proxy(cw, {
    get(target, prop, receiver) {
      if (prop === 'audit') {
        return {
          ...target.audit,
          list: target.audit.list.bind(target.audit),
          record: (input: Parameters<Chatwarden['audit']['record']>[0]) => (failing.includes(input.action) ? false : target.audit.record(input)),
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

describe('claims: another moderator holds the case', () => {
  it('a claim held by another actor refuses with the fixed text and writes nothing, at the preview and at the confirm', async () => {
    const b = await rig();
    const f = await b.w.file();
    const preview = await b.click(`cw1:dis:${f.id}`);
    const confirm = b.confirmId(preview);
    b.cw.cases.claim(f.target, 'someone-else');
    for (const id of [`cw1:dis:${f.id}`, `cw1:sug:${f.id}`, confirm]) {
      const res = await b.click(id);
      expect(contentOf(res), id).toBe('Another moderator has this case open.');
    }
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.cw.cases.holder(f.target)?.by).toBe('someone-else');
    expect(b.rows('report.decide')).toEqual([]);
    expect(b.closed).toEqual([]);
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_denied').every(([, d]) => d?.reason === 'claimed')).toBe(true);
  });

  it("the actor's own claim passes (actorOf mapped), and a Discord click never takes a case over, creates a claim, or leaves one", async () => {
    const b = await rig({ options: { actorOf: (id) => (id === USER_ID ? 'ann@example.test' : undefined) } });
    const f = await b.w.file();
    b.cw.cases.claim(f.target, 'ann@example.test');
    const done = await b.click(b.confirmId(await b.click(`cw1:dis:${f.id}`)));
    expect(contentOf(done)).toBe('Done \u00B7 No action');
    // the actor's own claim ended with their last open report; nobody took over
    expect(b.cw.cases.holder(f.target)).toBeNull();

    const g = await b.w.file();
    expect(b.cw.cases.holder(g.target)).toBeNull();
    await b.click(b.confirmId(await b.click(`cw1:dis:${g.id}`, { user: USER_2 })), { user: USER_2 });
    expect(b.cw.cases.holder(g.target)).toBeNull();
  });

  it('a senior cannot take the case over from Discord either: it is refused, never a takeover', async () => {
    const b = await rig();
    const f = await b.w.file();
    b.cw.cases.claim(f.target, 'someone-else');
    const res = await b.click(`cw1:dis:${f.id}`, { roles: [ROLE_SENIOR] });
    expect(contentOf(res)).toBe('Another moderator has this case open.');
    expect(b.cw.cases.holder(f.target)?.by).toBe('someone-else');
    expect(b.rows('case.takeover')).toEqual([]);
  });

  it('a claim taken between the preview and the confirm refuses the confirm', async () => {
    const b = await rig();
    const f = await b.w.file();
    const confirm = b.confirmId(await b.click(`cw1:dis:${f.id}`));
    b.cw.cases.claim(f.target, 'someone-else');
    expect(contentOf(await b.click(confirm))).toBe('Another moderator has this case open.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
  });
});

describe('decided elsewhere', () => {
  it('decided in the hub between preview and confirm: the confirm answers already decided with the verdict word, no write, no second report.closed', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    const confirm = b.confirmId(await b.click(`cw1:sug:${f.id}`));
    const hub = await b.w.call('POST', `/reports/${f.id}/decide`, { role: 'moderator', actor: 'hub-ann', body: { verdict: 'no_action', actions: [] } });
    expect(hub.status).toBe(200);
    const res = await b.click(confirm);
    expect(contentOf(res)).toBe('This report was already decided (no action).');
    expect(answerOf(res).type).toBe(7);
    expect(buttonsOf(res)).toEqual([{ type: 2, style: 5, label: 'Open report', url: `https://hub.example.test/reports/${encodeURIComponent(f.id)}` }]);
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(b.closed).toHaveLength(1);
    expect(b.rows('report.decide').filter((r) => String(r.actor).startsWith('discord:'))).toEqual([]);
  });

  it('decided in the hub with action: the verdict word says action taken; bad faith says so', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    await b.w.call('POST', `/reports/${f.id}/decide`, { role: 'moderator', actor: 'hub-ann', body: { verdict: 'upheld', reason: 'r', actions: [{ subject: f.target, kind: 'chat', durationMs: DAY, rule: 2 }] } });
    expect(contentOf(await b.click(`cw1:dis:${f.id}`))).toBe('This report was already decided (action taken).');
    expect(contentOf(await b.click(`cw1:sug:${f.id}`))).toBe('This report was already decided (action taken).');
    const g = await b.w.file('harassment');
    await b.w.call('POST', `/reports/${g.id}/decide`, { role: 'moderator', actor: 'hub-ann', body: { verdict: 'bad_faith', reason: 'r', evidence: 'planted', actions: [] } });
    expect(contentOf(await b.click(`cw1:dis:${g.id}`))).toBe('This report was already decided (bad faith).');
  });

  it('a report that does not exist is the decided text without a verdict word, with no link and no write', async () => {
    const b = await rig();
    const res = await b.click('cw1:dis:NoSuchReportIdAtAllXyz12');
    expect(contentOf(res)).toBe('This report was already decided.');
    expect(b.rows('suggest')).toEqual([]);
  });

  it('two confirms racing with the same code: one applies, the other answers Already done; one sanction row, one decide row', async () => {
    const b = await rig({ options: {} });
    const f = await b.w.file('harassment');
    const confirm = `cw1:ok:${f.id}:${CHAT_CODE}`;
    const [x, y] = await Promise.all([b.click(confirm), b.click(confirm, { user: USER_2 })]);
    const texts = [contentOf(x), contentOf(y)].sort();
    expect(texts[0]).toMatch(/^Already done \u00B7 Chat restriction \u00B7 24 hours/);
    expect(texts[1]).toMatch(/^Done \u00B7 Chat restriction \u00B7 24 hours \u00B7 M-/);
    expect(b.cw.sanctions.forPerson(f.target)).toHaveLength(1);
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.closed).toHaveLength(1);
  });

  it('two confirms racing with different codes: one applies, the other is already decided; nothing is applied twice', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    const [x, y] = await Promise.all([b.click(`cw1:ok:${f.id}:${CHAT_CODE}`), b.click(`cw1:ok:${f.id}:n`, { user: USER_2 })]);
    const texts = [contentOf(x), contentOf(y)];
    expect(texts.filter((t) => t.startsWith('Done'))).toHaveLength(1);
    expect(texts.filter((t) => t.startsWith('This report was already decided ('))).toHaveLength(1);
    expect(b.closed).toHaveLength(1);
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.cw.sanctions.forPerson(f.target).length).toBeLessThanOrEqual(1);
  });

  it('a repeated delivery of the same interaction id is answered without a second write; a different interaction with the same code is a replay of the decision', async () => {
    const b = await rig();
    const f = await b.w.file();
    const confirm = b.confirmId(await b.click(`cw1:dis:${f.id}`));
    const interaction = b.client.interaction(3, { custom_id: confirm, component_type: 2 }, {});
    const first = await b.send(b.client.signed(interaction));
    b.w.clock.t += 2000;
    const second = await b.send(b.client.signed(interaction));
    expect(second.body).toEqual(first.body);
    expect(contentOf(second)).toBe('Done \u00B7 No action');
    expect(b.rows('report.decide')).toHaveLength(1);
    // another interaction, the same code: the decision is replayed, not applied again
    b.w.clock.t += 2000;
    const other = await b.click(confirm);
    expect(contentOf(other)).toBe('Already done \u00B7 No action');
    expect(b.rows('report.decide')).toHaveLength(1);
    expect(b.closed).toHaveLength(1);
  });

  it('the interaction memory forgets after 15 minutes, and is bounded', async () => {
    const b = await rig();
    const f = await b.w.file();
    const confirm = b.confirmId(await b.click(`cw1:dis:${f.id}`));
    const interaction = b.client.interaction(3, { custom_id: confirm, component_type: 2 }, {});
    await b.send(b.client.signed(interaction));
    b.w.clock.t += 15 * 60_000 + 1000;
    // after the window the same id is just another click: the decision is replayed ("Already done"), which differs from the stored first answer
    const later = await b.send(b.client.signed(interaction));
    expect(contentOf(later)).toBe('Already done \u00B7 No action');
  });
});

describe('the interaction memory', () => {
  it('a redelivery that arrives while the first is still being worked on gets the same answer, and writes once', async () => {
    const b = await rig();
    const f = await b.w.file();
    const confirm = b.confirmId(await b.click(`cw1:dis:${f.id}`));
    const interaction = b.client.interaction(3, { custom_id: confirm, component_type: 2 }, {});
    const one = b.client.signed(interaction);
    const two = b.client.signed(interaction, { timestamp: Math.floor(b.w.clock.t / 1000) + 1 });
    const [x, y] = await Promise.all([b.send(one), b.send(two)]);
    expect(x.body).toEqual(y.body);
    expect(contentOf(x)).toBe('Done \u00B7 No action');
    expect(b.rows('report.decide')).toHaveLength(1);
  });

  it('is bounded at 10000: the oldest is forgotten (its redelivery is worked again), the newest is still held', async () => {
    const b = await rig({ options: { rateLimit: { max: 1_000_000, windowMs: 60_000 } } });
    const subject = b.w.person();
    const g = await b.cw.sanctions.apply({ kind: 'warning', subject, includeIp: false, durationMs: null, reason: 'r', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
    const first = b.client.interaction(2, { name: 'chatwarden', options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: g.refCode }] }] }, {});
    const views = () => b.rows('history.view').length;
    await b.send(b.client.signed(first));
    expect(views()).toBe(1);
    for (let n = 0; n < 10_000; n++) await b.send(b.client.lookup('M-AAAAA'));
    const last = b.client.interaction(2, { name: 'chatwarden', options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: g.refCode }] }] }, {});
    await b.send(b.client.signed(last));
    expect(views()).toBe(2);
    // the newest is held: its redelivery writes nothing
    await b.send(b.client.signed(last, { timestamp: Math.floor(b.w.clock.t / 1000) + 1 }));
    expect(views()).toBe(2);
    // the oldest was pushed out by the bound: its redelivery is worked again
    await b.send(b.client.signed(first, { timestamp: Math.floor(b.w.clock.t / 1000) + 2 }));
    expect(views()).toBe(3);
  }, 120_000);

  it('dispose forgets it, and a disposed bot answers nothing (the same 401 as a bad signature)', async () => {
    const b = await rig();
    b.bot.dispose();
    const res = await b.click('cw1:x');
    expect(res.status).toBe(401);
  });
});

describe('a forged custom_id', () => {
  it('forged to another report id the clicker may decide works as that report (it is a report they may decide anyway), as the clicker, source moderator', async () => {
    const b = await rig();
    const a = await b.w.file();
    const other = await b.w.file();
    await b.click(b.confirmId(await b.click(`cw1:dis:${a.id}`)).replace(a.id, other.id));
    expect(b.cw.reports.get(other.id)?.status).toBe('dismissed');
    expect(b.cw.reports.get(other.id)?.actionedBy).toBe(`discord:${USER_ID}`);
    expect(b.cw.reports.get(a.id)?.status).toBe('open');
  });

  it('forged to a code that is not the current suggestion is refused (That changed), and nothing is written', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    for (const code of ['chat.604800000.2', 'chat.86400000.4', 'ban.p.1', 'ban.2592000000.2', 'warning.p.2', 'note.p.2', 'area.86400000.2', 'chat.p.2']) {
      const res = await b.click(`cw1:ok:${f.id}:${code}`);
      expect(contentOf(res), code).toBe('That changed. Open it in the hub.');
      expect(buttonsOf(res).map((x) => x.label)).toEqual(['Open report']);
    }
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(b.rows('report.decide')).toEqual([]);
    // the current suggestion itself is fine
    expect(contentOf(await b.click(`cw1:ok:${f.id}:${CHAT_CODE}`))).toMatch(/^Done \u00B7 Chat restriction \u00B7 24 hours/);
  });

  it('a forged dismissal code with dismiss turned off is refused unless the suggestion itself is none', async () => {
    const b = await rig({ options: { actions: { dismiss: false, suggestion: true } } });
    const f = await b.w.file('harassment');
    expect(contentOf(await b.click(`cw1:ok:${f.id}:n`))).toBe('That changed. Open it in the hub.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(contentOf(await b.click(`cw1:dis:${f.id}`))).toBe('Actions from Discord are turned off.');
  });

  it('forged to an unknown verb, or to garbage, is a fixed refusal that changes nothing', async () => {
    const b = await rig();
    const f = await b.w.file();
    for (const bad of [`cw1:ban:${f.id}`, `cw2:dis:${f.id}`, 'cw1:', 'hello', `cw1:ok:${f.id}`, `cw1:ok:${f.id}:mute.1.2`, `cw1:dis:${f.id}:extra`, 'x'.repeat(101), '']) {
      const res = await b.click(bad);
      expect(contentOf(res), bad).toBe('That is not available here.');
    }
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
  });

  it('a custom_id cannot choose a role, an actor or a source: a moderator forging a permanent ban is refused by the role, whatever the id says', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    const forged = await b.click(`cw1:ok:${f.id}:ban.p.1`, { roles: [ROLE_MOD] });
    expect(['That changed. Open it in the hub.', 'You do not have permission to do this.']).toContain(contentOf(forged));
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
  });

  it('a non-string custom_id is the fixed refusal', async () => {
    const b = await rig();
    for (const value of [5, null, undefined, { a: 1 }, ['cw1:x']]) {
      const res = await b.send(b.client.click(value));
      expect(contentOf(res)).toBe('That is not available here.');
    }
  });
});

describe('actions off', () => {
  it('a cw1 button while actions are not configured is answered "Actions from Discord are turned off" and writes nothing', async () => {
    const b = await botWorld();
    const f = await b.w.file();
    for (const id of [`cw1:dis:${f.id}`, `cw1:sug:${f.id}`, `cw1:ok:${f.id}:n`]) {
      const res = await b.send(b.client.click(id));
      expect(contentOf(res), id).toBe('Actions from Discord are turned off.');
    }
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.w.audit().filter((r) => r.action === 'report.decide' || r.action === 'suggest')).toEqual([]);
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_denied').map(([, d]) => d)).toEqual([{ reason: 'off' }, { reason: 'off' }, { reason: 'off' }]);
  });

  it('suggestion turned off: the suggestion button and a forged acting code are off, the dismissal still works', async () => {
    const b = await rig({ options: { actions: { suggestion: false } } });
    const f = await b.w.file('harassment');
    expect(contentOf(await b.click(`cw1:sug:${f.id}`))).toBe('Actions from Discord are turned off.');
    expect(contentOf(await b.click(`cw1:ok:${f.id}:${CHAT_CODE}`))).toBe('Actions from Discord are turned off.');
    expect(b.cw.sanctions.forPerson(f.target)).toEqual([]);
    expect(contentOf(await b.click(b.confirmId(await b.click(`cw1:dis:${f.id}`))))).toBe('Done \u00B7 No action');
  });

  it('the gate still applies to a button: a wrong guild, no role and the rate are refused before anything else', async () => {
    const b = await rig();
    const f = await b.w.file();
    expect(contentOf(await b.click(`cw1:dis:${f.id}`, { guild: '222222222222222299' }))).toBe('This bot is not set up for this server.');
    expect(contentOf(await b.click(`cw1:dis:${f.id}`, { roles: [] }))).toBe('You do not have a moderator role for this bot.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    const limited = await rig({ options: { rateLimit: { max: 1, windowMs: 60_000 } } });
    const g = await limited.w.file();
    await limited.click(`cw1:dis:${g.id}`);
    expect(contentOf(await limited.click(`cw1:dis:${g.id}`))).toBe('Slow down.');
  });

  it('the role must hold reports.read to preview and reports.decide to confirm (the permission table is the hub\'s)', async () => {
    const b = await rig({ options: { permissions: { 'reports.decide': 'senior' } } });
    const f = await b.w.file();
    const preview = await b.click(`cw1:dis:${f.id}`);
    expect(contentOf(preview)).toContain('Nothing wrong here?');
    expect(contentOf(await b.click(b.confirmId(preview)))).toBe('You do not have permission to do this.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(contentOf(await b.click(b.confirmId(preview), { roles: [ROLE_SENIOR] }))).toBe('Done \u00B7 No action');
  });
});

describe('what never leaves', () => {
  const SEEDED = ['a line from the target', 'TargetName', 'Tgt', 'raw-client-key', 'room-w', 'team-room'];

  it('no answer or log contains the chat text, handle, reason or evidence of the report; allowed_mentions parse is empty on every answer', async () => {
    const b = await rig();
    const f = await b.w.file('harassment');
    const answers = [];
    const preview = await b.click(`cw1:sug:${f.id}`);
    answers.push(preview, await b.click(`cw1:dis:${f.id}`), await b.click('cw1:x'));
    answers.push(await b.click(b.confirmId(preview)));
    answers.push(await b.click(`cw1:dis:${f.id}`), await b.click(`cw1:ok:${f.id}:n`), await b.click(`cw1:ok:${f.id}:${CHAT_CODE}`));
    answers.push(await b.click('cw1:dis:NoSuchReportIdAtAllXyz12'));
    for (const res of answers) {
      const a = answerOf(res);
      expect(a.data?.allowed_mentions).toEqual({ parse: [] });
      expect(a.data?.flags).toBe(64);
      const shown = [a.data?.content ?? '', ...buttonsOf(res).flatMap((x) => [String(x.label ?? ''), String(x.url ?? '')])].join('\n');
      const noLinks = shown.replace(/https:\/\/hub\.example\.test\/\S+/g, 'LINK');
      for (const secret of [...SEEDED, f.target, f.id, 'discord:', USER_ID]) expect(noLinks, secret).not.toContain(secret);
    }
    const log = JSON.stringify(b.logged);
    for (const secret of [...SEEDED, f.target, f.id, USER_ID, 'cw1:']) expect(log, secret).not.toContain(secret);
  });
});

describe('failures', () => {
  it('an audit failure on the preview shows nothing (no step, no confirm button) and logs the class', async () => {
    const b = await rig({ wrapKit: failingAudit(['suggest']) });
    const f = await b.w.file('harassment');
    const res = await b.click(`cw1:sug:${f.id}`);
    expect(contentOf(res)).toBe('Something went wrong. Try again in the hub.');
    expect(buttonsOf(res)).toEqual([]);
    expect(b.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'handle', error: 'AuditFailedError' }]);
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
  });

  it('an audit failure on the confirm: the decision stands, the answer is Done, and the failure is logged by class', async () => {
    const b = await rig({ wrapKit: failingAudit(['report.decide']) });
    const f = await b.w.file();
    const confirm = b.confirmId(await b.click(`cw1:dis:${f.id}`));
    const res = await b.click(confirm);
    expect(contentOf(res)).toBe('Done \u00B7 No action');
    expect(b.cw.reports.get(f.id)?.status).toBe('dismissed');
    expect(b.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'audit', error: 'AuditFailedError' }]);
    expect(b.rows('report.decide')).toEqual([]);
  });

  it('a store failure on the decision is the fixed text and a class; nothing is half applied, and the next click works', async () => {
    let boom = true;
    const wrap = (cw: Chatwarden): Chatwarden =>
      new Proxy(cw, {
        get(target, prop, receiver) {
          if (prop === 'decide') {
            return (...args: Parameters<Chatwarden['decide']>) => {
              if (boom) return Promise.reject(new RangeError('disk full vlemmo'));
              return target.decide(...args);
            };
          }
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const b = await rig({ wrapKit: wrap });
    const f = await b.w.file();
    const res = await b.click(`cw1:ok:${f.id}:n`);
    expect(contentOf(res)).toBe('Something went wrong. Try again in the hub.');
    expect(b.cw.reports.get(f.id)?.status).toBe('open');
    expect(b.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'handle', error: 'RangeError' }]);
    expect(JSON.stringify(b.logged)).not.toContain('vlemmo');
    boom = false;
    expect(contentOf(await b.click(`cw1:ok:${f.id}:n`))).toBe('Done \u00B7 No action');
  });

  it('a throwing profile read is the same fixed failure', async () => {
    const wrap = (cw: Chatwarden): Chatwarden =>
      new Proxy(cw, {
        get(target, prop, receiver) {
          if (prop === 'suggest') return () => { throw new TypeError('ladder down'); };
          return Reflect.get(target, prop, receiver) as unknown;
        },
      });
    const b = await rig({ wrapKit: wrap });
    const f = await b.w.file('harassment');
    expect(contentOf(await b.click(`cw1:sug:${f.id}`))).toBe('Something went wrong. Try again in the hub.');
  });
});

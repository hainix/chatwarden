import { describe, expect, it } from 'vitest';
import { botWorld, buttonsOf, contentOf, answerOf, ROLE_MOD, ROLE_SENIOR, USER_ID, USER_2 } from './discord-world.js';
import type { BotWorld } from './discord-world.js';
import { DAY, HOUR } from './world.js';
import { defineRules } from '@chatwarden/core';

// /chatwarden lookup <ref> (K5 D4, Review Focus 3): a sanction's code, kind, length, rule, status, time and source in words, an Open person link, and
// nothing a player or a bystander should not read. One history.view row per successful lookup.

const REASON = 'PRIVATE-MODERATOR-REASON-quissel';
const GAP_NOTE = 'PRIVATE-GAP-NOTE-drakkuun';

type Apply = { kind?: 'chat' | 'ban' | 'warning' | 'note' | 'area'; durationMs?: number | null; rule?: number | 'uncovered'; source?: 'moderator' | 'auto_filter' | 'coop' | 'api' | 'ai'; actor?: string };

let aiRows = 0;
async function give(b: BotWorld, over: Apply = {}) {
  const subject = b.w.person();
  const kind = over.kind ?? 'chat';
  const durationMs = over.durationMs === undefined ? (kind === 'warning' || kind === 'note' ? null : DAY) : over.durationMs;
  // The source `ai` is the kit's own actor's and every public writer refuses it, so the row goes into the store directly, the way the actor will write it.
  if (over.source === 'ai') {
    const groupId = `ai-group-${++aiRows}`;
    const refCode = `M-AAAA${'BCDEFGHJKM'[aiRows % 10]}`;
    const startsAt = b.w.clock.now();
    b.w.store.insertSanctionGroup([
      {
        id: `ai-row-${aiRows}`,
        groupId,
        refCode,
        kind,
        targetType: 'subject',
        value: subject,
        startsAt,
        endsAt: durationMs === null ? null : startsAt + durationMs,
        reason: REASON,
        rule: String(over.rule ?? 2),
        gapNote: null,
        gapStatus: null,
        roomId: null,
        actor: 'ai:fake',
        source: 'ai',
        automated: true,
        pending: false,
      },
    ]);
    return { subject, groupId, refCode };
  }
  const res = await b.cw.sanctions.apply({
    kind,
    subject,
    includeIp: false,
    durationMs,
    reason: REASON,
    actor: over.actor ?? 'ann-the-moderator',
    source: over.source ?? 'moderator',
    automated: false,
    rule: over.rule ?? 2,
    ...(over.rule === 'uncovered' ? { gapNote: GAP_NOTE } : {}),
  });
  return { subject, groupId: res.groupId, refCode: res.refCode };
}

const lookup = (b: BotWorld, ref: unknown, who: Parameters<BotWorld['client']['lookup']>[1] = {}) => b.send(b.client.lookup(ref, who));
const unix = (ms: number): number => Math.floor(ms / 1000);

describe('lookup: what is shown', () => {
  it('a live sanction shows the code, kind, length, rule and escaped title, status, a Discord timestamp, the source in words and an Open person link', async () => {
    const b = await botWorld();
    const g = await give(b);
    const res = await lookup(b, g.refCode);
    const text = contentOf(res);
    const lines = text.split('\n');
    expect(lines[0]).toBe(`**${g.refCode}** \u00B7 Chat restriction \u00B7 24 hours`);
    expect(lines[1]).toMatch(/^Rule 2 \(.+\) \u00B7 Active until <t:\d+:R>$/);
    expect(lines[1]).toContain(`<t:${unix(b.w.clock.t + DAY)}:R>`);
    expect(lines[2]).toBe(`Given <t:${unix(b.w.clock.t)}:f> \u00B7 By a moderator`);
    const [link] = buttonsOf(res);
    expect(link).toEqual({ type: 2, style: 5, label: 'Open person', url: `https://hub.example.test/people/${encodeURIComponent(g.subject)}` });
    expect(answerOf(res)).toMatchObject({ type: 4, data: { flags: 64, allowed_mentions: { parse: [] } } });
  });

  it('a permanent ban says permanent and Active; a lifted sanction says Lifted; an ended one says Ended; a warning has no length', async () => {
    const b = await botWorld();
    const ban = await give(b, { kind: 'ban', durationMs: null, rule: 1 });
    const lifted = await give(b, { kind: 'chat', durationMs: 7 * DAY });
    await b.cw.sanctions.revoke(lifted.groupId, 'ann', 'a mistake');
    const ended = await give(b, { kind: 'area', durationMs: HOUR });
    const warning = await give(b, { kind: 'warning', durationMs: null });
    b.w.clock.t += 2 * HOUR;

    const banText = contentOf(await lookup(b, ban.refCode));
    expect(banText.split('\n')[0]).toBe(`**${ban.refCode}** \u00B7 Ban \u00B7 permanent`);
    expect(banText.split('\n')[1]).toMatch(/ \u00B7 Active$/);

    const liftedText = contentOf(await lookup(b, lifted.refCode));
    expect(liftedText.split('\n')[0]).toBe(`**${lifted.refCode}** \u00B7 Chat restriction \u00B7 7 days`);
    expect(liftedText.split('\n')[1]).toMatch(/ \u00B7 Lifted$/);

    const endedText = contentOf(await lookup(b, ended.refCode));
    expect(endedText.split('\n')[0]).toBe(`**${ended.refCode}** \u00B7 Area ban \u00B7 1 hour`);
    expect(endedText.split('\n')[1]).toMatch(/ \u00B7 Ended$/);

    const warnText = contentOf(await lookup(b, warning.refCode));
    expect(warnText.split('\n')[0]).toBe(`**${warning.refCode}** \u00B7 Warning`);
  });

  it('every source reads in words: the chat filter, Coop, the AI read, the API, a moderator', async () => {
    const b = await botWorld();
    const seen: Record<string, string> = {};
    for (const source of ['moderator', 'auto_filter', 'coop', 'api', 'ai'] as const) {
      const g = await give(b, { source });
      b.w.clock.t += 1000;
      seen[source] = contentOf(await lookup(b, g.refCode)).split('\n')[2] as string;
    }
    expect(seen.moderator).toMatch(/By a moderator$/);
    expect(seen.auto_filter).toMatch(/By the chat filter$/);
    expect(seen.coop).toMatch(/By Coop$/);
    expect(seen.api).toMatch(/By the API$/);
    expect(seen.ai).toMatch(/By the AI read$/);
  });

  it('a code in lower case, with spaces, or as the bare five characters finds the same sanction', async () => {
    const b = await botWorld();
    const g = await give(b);
    const five = g.refCode.slice(2);
    for (const form of [g.refCode.toLowerCase(), `  ${g.refCode} `, five, five.toLowerCase()]) {
      expect(contentOf(await lookup(b, form)).startsWith(`**${g.refCode}**`), form).toBe(true);
    }
  });

  it('an uncovered rule reads as no Community Rule yet', async () => {
    const b = await botWorld();
    const g = await give(b, { kind: 'warning', rule: 'uncovered' });
    expect(contentOf(await lookup(b, g.refCode))).toContain('No Community Rule yet');
  });
});

describe('lookup: what is never shown', () => {
  it('never shows the reason, actor, handle, subject id (outside the link), room id or any note', async () => {
    const b = await botWorld();
    const g = await give(b, { rule: 'uncovered', kind: 'warning' });
    const lifted = await give(b);
    await b.cw.sanctions.revoke(lifted.groupId, 'bea-the-lifter', 'PRIVATE-REVOKE-REASON-snerp');
    for (const code of [g.refCode, lifted.refCode]) {
      const res = await lookup(b, code);
      const text = JSON.stringify(res.body);
      const withoutLink = text.replace(/https:\/\/hub\.example\.test\/people\/[^"]*/g, 'LINK');
      for (const secret of [REASON, GAP_NOTE, 'ann-the-moderator', 'bea-the-lifter', 'PRIVATE-REVOKE-REASON-snerp', 'room-w-', 'TargetName', 'Tgt', 'raw-client-key']) {
        expect(withoutLink, secret).not.toContain(secret);
      }
      expect(withoutLink).not.toMatch(/\bs_[A-Za-z0-9_-]{6,}/);
      expect(withoutLink).not.toContain(g.subject);
    }
    // nothing of the lookup in the log either
    expect(JSON.stringify(b.logged)).not.toContain(g.refCode);
  });

  it('a rule title with markdown, an @everyone and a 2000 character title is escaped and cut', async () => {
    const evil = `**bold** @everyone <@123> [x](https://evil.example/) ${'z'.repeat(2000)}`;
    const rules = defineRules([
      { number: 1, title: 'First', text: 'one' },
      { number: 2, title: evil, text: 'two' },
    ]);
    const b = await botWorld({ world: { rules } });
    const subject = b.w.person();
    const res = await b.cw.sanctions.apply({ kind: 'chat', subject, includeIp: false, durationMs: DAY, reason: 'r', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
    const text = contentOf(await lookup(b, res.refCode));
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).not.toContain('@everyone');
    expect(text).not.toContain('<@123>');
    expect(text).not.toContain('**bold**');
    expect(text).not.toContain('](https');
    expect(text).toContain('\\*\\*bold\\*\\*');
    expect(text).toContain('@\u200Beveryone');
  });
});

describe('lookup: unknown and malformed codes', () => {
  it('an unknown code and garbage give the same text, with no link and no audit row', async () => {
    const b = await botWorld();
    const answers = [];
    for (const ref of ['M-AAAAA', 'AAAAA', 'M-A', 'M-ILOO0', '12345678901234567890', '<@123>', '../etc', 'M-AAAAA\n', '', '\u0000\u0000\u0000\u0000\u0000']) answers.push(await lookup(b, ref));
    for (const res of answers) {
      expect(contentOf(res)).toBe('No sanction found for that code.');
      expect(buttonsOf(res)).toEqual([]);
    }
    expect(b.w.audit().filter((r) => r.action === 'history.view')).toEqual([]);
  });

  it('a 3 character and a 12 character option are handled (the handler checks the length again), a non-string option is the same text', async () => {
    const b = await botWorld();
    for (const ref of ['abc', 'M-AAAAA-BBBB', 'a'.repeat(5000), 5, null, undefined, { x: 1 }, ['M-AAAAA']]) {
      expect(contentOf(await lookup(b, ref)), String(ref).slice(0, 10)).toBe('No sanction found for that code.');
    }
  });

  it('a lookup command with no ref, an unknown subcommand and an unknown command are a fixed refusal, never a throw', async () => {
    const b = await botWorld();
    const none = await b.send(b.client.command({ name: 'chatwarden', options: [{ type: 1, name: 'lookup', options: [] }] }));
    expect(contentOf(none)).toBe('No sanction found for that code.');
    const unknownSub = await b.send(b.client.command({ name: 'chatwarden', options: [{ type: 1, name: 'ban', options: [] }] }));
    const unknownCmd = await b.send(b.client.command({ name: 'other', options: [] }));
    const noData = await b.send(b.client.command(undefined));
    for (const res of [unknownSub, unknownCmd, noData]) expect(contentOf(res)).toBe('That is not available here.');
    expect(b.logged.filter(([e]) => e === 'chatwarden.discord_bot_failed')).toEqual([]);
  });
});

describe('lookup: the audit row', () => {
  it('writes one history.view row with the actor discord:<id>, the mapped role and the sanction target', async () => {
    const b = await botWorld();
    const g = await give(b);
    await lookup(b, g.refCode, { roles: [ROLE_MOD, ROLE_SENIOR], user: USER_2 });
    const rows = b.w.audit().filter((r) => r.action === 'history.view');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actor: `discord:${USER_2}`, role: 'senior', action: 'history.view', target: { type: 'sanction', ref: g.groupId } });
  });

  it('a repeated lookup writes a row each time (each is a view), and a failed lookup writes none', async () => {
    const b = await botWorld();
    const g = await give(b);
    await lookup(b, g.refCode);
    await lookup(b, g.refCode);
    await lookup(b, 'M-AAAAA');
    await lookup(b, g.refCode, { roles: [] });
    await lookup(b, g.refCode, { guild: null });
    expect(b.w.audit().filter((r) => r.action === 'history.view')).toHaveLength(2);
  });

  it('an audit failure shows nothing (required mode) and logs the class; the answer is the fixed failure text', async () => {
    const b = await botWorld({
      wrapKit: (cw) =>
          new Proxy(cw, {
            get(target, prop, receiver) {
              if (prop === 'audit') return { ...target.audit, record: () => false, list: target.audit.list.bind(target.audit) };
              return Reflect.get(target, prop, receiver) as unknown;
            },
          }),
    });
    const g = await give(b);
    const res = await lookup(b, g.refCode);
    expect(contentOf(res)).toBe('Something went wrong. Try again in the hub.');
    expect(JSON.stringify(res.body)).not.toContain(g.refCode);
    expect(buttonsOf(res)).toEqual([]);
    expect(b.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'handle', error: 'AuditFailedError' }]);
  });

  it('a throwing kit read is the same fixed failure, by class, and the next lookup works', async () => {
    let boom = true;
    const b = await botWorld({
      wrapKit: (cw) =>
          new Proxy(cw, {
            get(target, prop, receiver) {
              if (prop === 'sanctions') {
                return new Proxy(target.sanctions, {
                  get(t, p, r) {
                    if (p === 'byRef' && boom) return () => { throw new RangeError('store down zorbak'); };
                    return Reflect.get(t, p, r) as unknown;
                  },
                });
              }
              return Reflect.get(target, prop, receiver) as unknown;
            },
          }),
    });
    const res = await lookup(b, 'M-AAAAA');
    expect(contentOf(res)).toBe('Something went wrong. Try again in the hub.');
    expect(b.logged).toContainEqual(['chatwarden.discord_bot_failed', { op: 'handle', error: 'RangeError' }]);
    expect(JSON.stringify(b.logged)).not.toContain('zorbak');
    boom = false;
    expect(contentOf(await lookup(b, 'M-AAAAA'))).toBe('No sanction found for that code.');
  });
});

describe('lookup: the actor', () => {
  it('actorOf maps the audit actor', async () => {
    const b = await botWorld({ options: { actorOf: (id) => (id === USER_ID ? 'ann@example.test' : undefined) } });
    const g = await give(b);
    await lookup(b, g.refCode);
    await lookup(b, g.refCode, { user: USER_2 });
    const actors = b.w.audit().filter((r) => r.action === 'history.view').map((r) => r.actor).sort();
    expect(actors).toEqual(['ann@example.test', `discord:${USER_2}`]);
  });

  it('an actorOf that returns an invalid actor or throws falls back to discord:<id>', async () => {
    for (const actorOf of [() => 'has a space', () => '', () => 'x'.repeat(200), () => 5 as never, () => { throw new Error('mapping down'); }, () => undefined]) {
      const b = await botWorld({ options: { actorOf } });
      const g = await give(b);
      expect(contentOf(await lookup(b, g.refCode)).startsWith('**')).toBe(true);
      expect(b.w.audit().find((r) => r.action === 'history.view')?.actor).toBe(`discord:${USER_ID}`);
    }
  });
});

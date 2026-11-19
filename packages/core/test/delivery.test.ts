import { describe, expect, it } from 'vitest';
import { DeliveryService } from '../src/delivery.js';
import type { NoticeDelivery } from '../src/delivery.js';
import { world } from './reportingWorld.js';
import { appealsKit, HOUR, NOW } from './appealsWorld.js';
import type { AppealsKit } from './appealsWorld.js';

// The delivery hook (`notices.deliver`) at the level of one delivery: its fields, the people it skips, the language, and that a hook can never hurt a sanction.

const LANDING = 'https://game.example/appeal';
const SKIPPED = 'chatwarden.delivery_skipped_no_account';
const FAILED = 'chatwarden.delivery_failed';

function recorder() {
  const calls: NoticeDelivery[] = [];
  return { calls, deliver: (d: NoticeDelivery): void => void calls.push(d) };
}
type Options = { deliver?: unknown; localeOf?: unknown };
const kit = (notices: Options, settings: Record<string, unknown> = {}, landing = true) => appealsKit({ ...(landing ? { appeals: { landingUrl: LANDING } } : {}), notices } as never, settings);
/** Link a game account to a player's key (so the kit knows where to write to them). */
const withAccount = (k: AppealsKit, key: string, accountId: string): void => {
  k.cw.rooms.seat(`acct-${key}-${accountId}`, 'p1', { clientKey: key, accountId }, 'Acct');
};
const logs = (k: AppealsKit, event: string) => k.logged.filter(([e]) => e === event);

describe('what is delivered', () => {
  it('every field: kind, noticeId, to.accountId, locale, subject, text, html, appealUrl and the sanction', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    withAccount(k, 'key-a', 'acct-42');
    const s = await k.sanction({ key: 'key-a', kind: 'chat', durationMs: 6 * HOUR });
    expect(r.calls).toHaveLength(1);
    const d = r.calls[0] as NoticeDelivery;
    expect(d).toEqual({
      kind: 'sanction',
      noticeId: s.noticeId,
      to: { accountId: 'acct-42' },
      locale: 'en',
      subject: 'Your chat has been restricted for 6 hours',
      text: expect.stringContaining('Your chat is turned off'),
      html: expect.stringContaining('<!doctype html>'),
      appealUrl: expect.stringMatching(/^https:\/\/game\.example\/appeal\?t=/),
      sanction: { kind: 'chat', until: NOW + 6 * HOUR, rule: 2, source: 'moderator', automated: false },
    });
    expect(Object.keys(d).sort()).toEqual(['appealUrl', 'html', 'kind', 'locale', 'noticeId', 'sanction', 'subject', 'text', 'to']);
    expect(Object.keys(d.sanction).sort()).toEqual(['automated', 'kind', 'rule', 'source', 'until']);
    expect(d.text).toContain(d.appealUrl as string);
    expect(d.text).toContain(`Reference: ${s.refCode}`);
    expect(d.html).toContain('Appeal this decision');
    expect(d).not.toHaveProperty('outcome');
  });

  it('`to` holds the account id and nothing else: no key, no address, no subject, no group', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    withAccount(k, 'key-b', 'acct-77');
    const s = await k.sanction({ key: 'key-b', kind: 'ban', durationMs: null });
    const d = r.calls[0] as NoticeDelivery;
    expect(Object.keys(d.to)).toEqual(['accountId']);
    const json = JSON.stringify(d);
    for (const secret of ['key-b', s.subject, s.groupId, s.reportId, 'mod_ann', 'private reason']) expect(json, secret).not.toContain(secret);
  });

  it('the account is the one the game gave, raw (not a hash)', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    withAccount(k, 'key-c', 'Player@Example-ID');
    await k.sanction({ key: 'key-c' });
    expect(r.calls[0]?.to).toEqual({ accountId: 'Player@Example-ID' });
  });

  it('every kind reports its own sanction: a warning has no end, a ban none either, an area and a chat have one', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    for (const kind of ['warning', 'chat', 'area', 'ban'] as const) {
      withAccount(k, `key-${kind}`, `acct-${kind}`);
      await k.sanction({ key: `key-${kind}`, kind, durationMs: kind === 'ban' ? null : HOUR });
    }
    expect(r.calls.map((d) => [d.sanction.kind, d.sanction.until])).toEqual([
      ['warning', null],
      ['chat', NOW + HOUR],
      ['area', NOW + HOUR],
      ['ban', null],
    ]);
  });

  it('without a landing page the appeal link is null and the text has no link; the delivery still goes', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver }, {}, false);
    withAccount(k, 'key-d', 'acct-d');
    await k.sanction({ key: 'key-d' });
    const d = r.calls[0] as NoticeDelivery;
    expect(d.appealUrl).toBeNull();
    expect(d.text).not.toContain('http');
    expect(d.html).not.toContain('<a ');
  });

  it("a game's own words (appeals.words) are used and escaped in the html", async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver }, { words: { en: { 'delivery.footer': 'Sent by <b>Studio</b>' } } });
    withAccount(k, 'key-w', 'acct-w');
    await k.sanction({ key: 'key-w' });
    const d = r.calls[0] as NoticeDelivery;
    expect(d.text.endsWith('Sent by <b>Studio</b>')).toBe(true);
    expect(d.html).toContain('Sent by &lt;b&gt;Studio&lt;/b&gt;');
    expect(d.html).not.toContain('<b>');
  });
});

describe('a person with no account', () => {
  it('through the kit: the hook is not called and the skip is logged once with count 1, holding no id', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    await k.sanction({ key: 'kn-0' });
    expect(r.calls).toEqual([]);
    expect(logs(k, SKIPPED)).toEqual([[SKIPPED, { count: 1 }]]);
  });

  it('the skip log: the first at once with count 1; 59 more inside a minute log nothing; the next after the minute logs the count; then it starts again', () => {
    const calls: unknown[] = [];
    const logged: Array<[string, unknown]> = [];
    const clock = { t: NOW, now: () => clock.t };
    const row = { id: 'n1', subject: 's_x', groupId: 'g1', kind: 'chat', rule: '2', until: NOW + HOUR, refCode: 'M-AAAAA', excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null };
    const service = new DeliveryService({
      store: { loadNotice: () => row, loadSanctionSubjectRow: () => ({ source: 'moderator', automated: false }) } as never,
      subjects: { canonical: (s: string) => s, latestAccount: () => null } as never,
      notices: { viewOf: () => row } as never,
      rules: { label: () => 'Rule' } as never,
      clock,
      logger: { warn: (event, detail) => void logged.push([event, detail]) },
      options: { deliver: (d) => void calls.push(d) },
      link: () => null,
      words: () => ({}),
    });
    service.sanctionNoticed('n1');
    expect(logged).toEqual([[SKIPPED, { count: 1 }]]);
    for (let i = 0; i < 59; i++) {
      clock.t += 500;
      service.sanctionNoticed('n1');
    }
    expect(logged).toHaveLength(1);
    // the minute is counted from the first log, by the injected clock: 59.5 seconds is still inside it
    clock.t = NOW + 59_999;
    service.sanctionNoticed('n1');
    expect(logged).toHaveLength(1);
    clock.t = NOW + 60_000;
    service.sanctionNoticed('n1');
    expect(logged).toEqual([
      [SKIPPED, { count: 1 }],
      [SKIPPED, { count: 61 }],
    ]);
    expect(calls).toEqual([]);
    expect(Object.keys((logged[1] as [string, object])[1])).toEqual(['count']);
    clock.t += 60_000;
    service.sanctionNoticed('n1');
    expect(logged[2]).toEqual([SKIPPED, { count: 1 }]);
  });

  it('a person with an account is not counted as a skip', async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver });
    withAccount(k, 'key-e', 'acct-e');
    await k.sanction({ key: 'key-e' });
    expect(r.calls).toHaveLength(1);
    expect(logs(k, SKIPPED)).toEqual([]);
  });

  it('localeOf is not asked for a person with no account', async () => {
    let asked = 0;
    const k = await kit({ deliver: () => undefined, localeOf: () => ((asked += 1), 'es') });
    await k.sanction({ key: 'key-f' });
    expect(asked).toBe(0);
  });
});

describe('the language', () => {
  const setup = async (localeOf: unknown) => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver, localeOf });
    withAccount(k, 'key-l', 'acct-l');
    await k.sanction({ key: 'key-l', kind: 'chat', durationMs: 24 * HOUR });
    return { d: r.calls[0] as NoticeDelivery, k };
  };

  it('localeOf is passed { accountId } only; es-MX gives Spanish text', async () => {
    const seen: unknown[][] = [];
    const { d } = await setup((...args: unknown[]) => (seen.push(args), 'es-MX'));
    expect(seen).toEqual([[{ accountId: 'acct-l' }]]);
    expect(d.locale).toBe('es');
    expect(d.subject).toBe('Tu chat fue restringido por 24 horas');
    expect(d.html).toContain('<html lang="es">');
  });

  it('pt-BR gives Portuguese', async () => {
    const { d } = await setup(() => 'pt-BR');
    expect(d.locale).toBe('pt');
    expect(d.subject).toContain('24 horas');
  });

  it('a throwing localeOf, an unknown tag, undefined, a non-string and a hostile tag give English', async () => {
    for (const localeOf of [
      () => {
        throw new Error('boom');
      },
      () => 'xx-YY',
      () => undefined,
      () => 5,
      () => '__proto__',
      () => 'a'.repeat(200),
    ]) {
      const { d } = await setup(localeOf);
      expect(d.locale).toBe('en');
      expect(d.subject).toBe('Your chat has been restricted for 24 hours');
    }
  });

  it("a game's own language works when appeals.words has it", async () => {
    const r = recorder();
    const k = await kit({ deliver: r.deliver, localeOf: () => 'de-AT' }, { words: { de: { 'delivery.subject.chat.timed': 'Dein Chat ist {length} gesperrt' } } });
    withAccount(k, 'key-g', 'acct-g');
    await k.sanction({ key: 'key-g', kind: 'chat', durationMs: 24 * HOUR });
    expect(r.calls[0]).toMatchObject({ locale: 'de', subject: 'Dein Chat ist 24 Stunden gesperrt' });
  });
});

describe('a hook that misbehaves never hurts the sanction', () => {
  const run = async (deliver: (d: NoticeDelivery) => unknown) => {
    const k = await kit({ deliver });
    withAccount(k, 'key-h', 'acct-hook-secret');
    const s = await k.sanction({ key: 'key-h' });
    // let any rejection settle
    for (let i = 0; i < 5; i++) await Promise.resolve();
    return { k, s };
  };

  it('a throw: the decision is ok, the notice is there, and the class alone is logged', async () => {
    const { k, s } = await run(() => {
      throw new RangeError('smtp password hunter2 for acct-hook-secret');
    });
    expect(k.cw.notices.pending(s.who).map((n) => n.id)).toContain(s.noticeId);
    expect(logs(k, FAILED)).toEqual([[FAILED, { error: 'RangeError' }]]);
    const json = JSON.stringify(k.logged);
    for (const secret of ['hunter2', 'acct-hook-secret', 'smtp', 'Your chat', 'http']) expect(json, secret).not.toContain(secret);
  });

  it('a rejection: the same', async () => {
    const { k, s } = await run(() => Promise.reject(new TypeError('boom acct-hook-secret')));
    expect(k.cw.notices.pending(s.who).map((n) => n.id)).toContain(s.noticeId);
    expect(logs(k, FAILED)).toEqual([[FAILED, { error: 'TypeError' }]]);
    expect(JSON.stringify(k.logged)).not.toContain('acct-hook-secret');
  });

  it('a throw that is not an Error is logged by its type', async () => {
    const { k } = await run(() => {
      throw 'a plain string with acct-hook-secret';
    });
    expect(logs(k, FAILED)).toEqual([[FAILED, { error: 'string' }]]);
    expect(JSON.stringify(k.logged)).not.toContain('acct-hook-secret');
  });

  it('a promise that never settles holds nothing: the decision is already done and the next sanction is not held up', async () => {
    const { k, s } = await run(() => new Promise<void>(() => undefined));
    expect(k.cw.notices.pending(s.who).map((n) => n.id)).toContain(s.noticeId);
    const again = await k.sanction({ key: 'key-h' });
    expect(again.noticeId).not.toBe(s.noticeId);
    expect(logs(k, FAILED)).toEqual([]);
  });

  it('a hook that is slow and asynchronous is not awaited', async () => {
    let finished = false;
    const k = await kit({
      deliver: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            finished = true;
            resolve();
          }, 50);
        }),
    });
    withAccount(k, 'key-i', 'acct-i');
    await k.sanction({ key: 'key-i' });
    expect(finished).toBe(false);
  });

  it('a hook that returns something odd (a number, null, a thenable that throws on then) is fine', async () => {
    for (const result of [5, null, undefined, { then: 7 }]) {
      const { k } = await run(() => result);
      expect(logs(k, FAILED)).toEqual([]);
    }
    const hostile = {
      get then(): never {
        throw new Error('boom');
      },
    };
    const { k } = await run(() => hostile);
    expect(logs(k, FAILED).length).toBeLessThanOrEqual(1);
    expect(JSON.stringify(k.logged)).not.toContain('acct-hook-secret');
  });
});

describe('without notices.deliver nothing is read', () => {
  it('no notice is loaded for a delivery: loadNotice is never called by a sanction', async () => {
    const k = await appealsKit({ appeals: { landingUrl: LANDING } } as never);
    let loads = 0;
    const real = k.store.loadNotice.bind(k.store);
    k.store.loadNotice = (id: string) => ((loads += 1), real(id));
    withAccount(k, 'key-j', 'acct-j');
    await k.sanction({ key: 'key-j' });
    expect(loads).toBe(0);
    expect(logs(k, SKIPPED)).toEqual([]);
  });

  it('notices given without a deliver function also reads nothing and delivers nothing', async () => {
    const k = await kit({ localeOf: () => 'es' });
    let loads = 0;
    const real = k.store.loadNotice.bind(k.store);
    k.store.loadNotice = (id: string) => ((loads += 1), real(id));
    await k.sanction({ key: 'key-k' });
    expect(loads).toBe(0);
  });
});

describe('notices options are checked at creation', () => {
  const message = async (notices: unknown): Promise<string> => {
    try {
      await world({ notices } as never);
    } catch (e) {
      expect(e).toBeInstanceOf(TypeError);
      return (e as Error).message;
    }
    throw new Error('expected a TypeError');
  };

  it('a deliver that is not a function is a TypeError naming notices.deliver', async () => {
    for (const deliver of [5, 'x', {}, null, true]) expect(await message({ deliver }), String(deliver)).toContain('notices.deliver');
  });

  it('a localeOf that is not a function is a TypeError naming notices.localeOf', async () => {
    for (const localeOf of [5, 'x', {}, null]) expect(await message({ deliver: () => undefined, localeOf }), String(localeOf)).toContain('notices.localeOf');
  });

  it('notices that is not an object is a TypeError naming notices', async () => {
    for (const notices of ['x', 5, true, null, []]) expect(await message(notices), String(notices)).toContain('notices');
  });

  it('an empty object, undefined and a good pair are accepted', async () => {
    expect(await world({ notices: {} } as never)).toBeDefined();
    expect(await world({ notices: undefined } as never)).toBeDefined();
    expect(await world({ notices: { deliver: () => undefined, localeOf: () => 'es' } } as never)).toBeDefined();
    expect(await world({ notices: { deliver: async () => undefined } } as never)).toBeDefined();
  });

  it('a deliverAutomatic that is not a boolean is a TypeError naming notices.deliverAutomatic, with or without a deliver', async () => {
    for (const deliverAutomatic of [0, 1, 'false', 'true', '', {}, [], null, () => true]) {
      expect(await message({ deliver: () => undefined, deliverAutomatic }), String(deliverAutomatic)).toContain('notices.deliverAutomatic');
      expect(await message({ deliverAutomatic }), String(deliverAutomatic)).toContain('notices.deliverAutomatic');
    }
  });

  it('a boolean deliverAutomatic, or none, is accepted', async () => {
    for (const deliverAutomatic of [true, false, undefined]) expect(await world({ notices: { deliver: () => undefined, deliverAutomatic } } as never), String(deliverAutomatic)).toBeDefined();
    expect(await world({ notices: { deliverAutomatic: false } } as never)).toBeDefined();
  });

  it('the deliverAutomatic message never echoes a value', async () => {
    expect(await message({ deliver: () => undefined, deliverAutomatic: 'zorbak-secret-value' })).not.toContain('zorbak-secret-value');
  });

  it('the message never echoes a value', async () => {
    expect(await message({ deliver: 'zorbak-secret-value' })).not.toContain('zorbak-secret-value');
  });
});

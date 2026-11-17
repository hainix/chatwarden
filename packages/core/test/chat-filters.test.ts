import { describe, expect, it } from 'vitest';
import type { RefuseReason } from '../src/chat.js';
import type { ResolvedPace } from '../src/pace.js';
import type { SubjectId } from '../src/types.js';
import { delivered, F, NOW, refusal, ROOM, setup, who } from './filtersChatWorld.js';
import type { ResolvedFilters } from '../src/filters.js';
import { ProfileError } from '../src/profile.js';
import { OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

describe('order', () => {
  it('a matcher hit returns blocked first and the filters never run', () => {
    const t = setup({ filters: { links: { action: 'refuse' }, phrases: [{ id: 'a', action: 'refuse', phrases: ['zorbak vlemmo'] }] } });
    t.sit('p1', who('k1'));
    const r = t.say('p1', 'zorbak at vlemmo.com');
    expect(refusal(r).reason).toBe('blocked');
    expect(t.calls.settings).toEqual([]);
    expect(t.calls.counted).toEqual([]);
  });

  it('filters run before profanity, and profanity sees the masked text', () => {
    const t = setup({ filters: { links: { action: 'mask' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'snerp at vlemmo.com'))).toBe('***** at **********');
    expect(t.calls.profanityInputs).toEqual(['snerp at **********']);
  });

  it('a refusing filter stops the line before profanity runs', () => {
    const t = setup({ filters: { links: { action: 'refuse' } } });
    t.sit('p1', who('k1'));
    t.say('p1', 'snerp at vlemmo.com');
    expect(t.calls.profanityInputs).toEqual([]);
  });

  it('a refused line spends rate budget like a profane one: the fourth line in 5 seconds is rate', () => {
    const t = setup({ filters: { links: { action: 'refuse' } } });
    t.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) expect(refusal(t.say('p1', `see vlemmo${i}.com`)).reason).toBe('link');
    expect(refusal(t.say('p1', 'hello')).reason).toBe('rate');
    const profane = setup({ profanityMode: 'refuse' });
    profane.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) expect(refusal(profane.say('p1', 'snerp')).reason).toBe('profanity');
    expect(refusal(profane.say('p1', 'hello')).reason).toBe('rate');
  });

  it('a refused line spends pacing budget too: the next line inside the slow-mode gap is refused', () => {
    const pace: ResolvedPace = { slowModeMs: 5000, burst: null, duplicateWindowMs: null };
    const t = setup({ filters: { links: { action: 'refuse' } }, pace });
    t.sit('p1', who('k1'));
    expect(refusal(t.say('p1', 'see vlemmo.com')).reason).toBe('link');
    t.clock.t += 1000;
    expect(refusal(t.say('p1', 'hello')).reason).toBe('slow_mode');
    t.clock.t += 5000;
    expect(delivered(t.say('p1', 'hello'))).toBe('hello');
  });
});

describe('refuse', () => {
  it('link, personal_info and filter reasons, with the rule of the hit and nothing else', () => {
    const t = setup({
      filters: {
        links: { action: 'refuse', rule: 4 },
        personalInfo: { action: 'refuse', rule: 2 },
        phrases: [{ id: 'ads', action: 'refuse', rule: 6, phrases: ['buy gold'] }],
        ratio: { action: 'refuse', rule: 7 },
      },
    });
    t.sit('p1', who('k1'));
    t.clock.t += 0;
    const lines: Array<[string, RefuseReason, number]> = [
      ['see vlemmo.com', 'link', 4],
      ['mail a@b.com', 'personal_info', 2],
      ['buy gold now', 'filter', 6],
      ['AAAAAAAAAAAAAAAA', 'filter', 7],
    ];
    for (const [i, [text, reason, rule]] of lines.entries()) {
      t.clock.t = NOW + (i + 1) * 10_000;
      const r = refusal(t.say('p1', text));
      expect(r).toEqual({ reason, rule });
      expect(Object.keys(r).sort()).toEqual(['reason', 'rule']);
      expect(JSON.stringify(r)).not.toMatch(/vlemmo|a@b|gold|AAAA/);
    }
  });

  it('the line is not in the buffer and makes no strike, sanction, notice or other write', () => {
    const t = setup({ filters: { links: { action: 'refuse' } } });
    t.sit('p1', who('k1'));
    for (let i = 0; i < 3; i++) t.say('p1', `see vlemmo${i}.com`);
    expect(t.buffer.snapshot(ROOM)).toEqual([]);
    expect(t.writes.strikes).not.toHaveBeenCalled();
    expect(t.writes.notices).not.toHaveBeenCalled();
    expect(t.writes.sanctions).not.toHaveBeenCalled();
    expect(t.logs).toEqual([]);
  });

  it('an ordinary line after a refusal is delivered and buffered', () => {
    const t = setup({ filters: { links: { action: 'refuse' } } });
    t.sit('p1', who('k1'));
    t.say('p1', 'see vlemmo.com');
    t.clock.t += 10_000;
    expect(delivered(t.say('p1', 'good game'))).toBe('good game');
    expect(t.buffer.snapshot(ROOM).map((l) => l.raw)).toEqual(['good game']);
  });

  it('a guest is refused too, and counted', () => {
    const t = setup({ filters: { links: { action: 'refuse' } } });
    t.sit('p3', null);
    expect(refusal(t.say('p3', 'see vlemmo.com')).reason).toBe('link');
    expect(t.calls.counted.map((h) => h.key)).toEqual(['link.unlisted']);
  });
});

describe('precedence', () => {
  it('refuse beats mask beats flag beats count; every hit is counted', () => {
    const t = setup({
      filters: { links: { action: 'mask' }, personalInfo: { action: 'flag' }, phrases: [{ id: 'a', action: 'count', phrases: ['buy gold'] }, { id: 'b', action: 'refuse', phrases: ['free gold'] }] },
    });
    t.sit('p1', who('k1'));
    expect(refusal(t.say('p1', 'vlemmo.com a@b.com buy gold free gold')).reason).toBe('filter');
    expect(t.calls.counted.map((h) => h.key)).toEqual(['link.unlisted', 'personal_info.email', 'phrase.a', 'phrase.b']);
    expect(t.calls.counted.map((h) => h.action)).toEqual(['mask', 'flag', 'count', 'refuse']);
    expect(t.calls.flags).toEqual([]);
  });

  it('two refusing rules cite the first in links, personal info, phrase list, ratio order', () => {
    const t = setup({ filters: { ratio: { action: 'refuse', rule: 2 }, phrases: [{ id: 'a', action: 'refuse', rule: 3, phrases: ['buy gold'] }], personalInfo: { action: 'refuse', rule: 5 } } });
    t.sit('p1', who('k1'));
    expect(refusal(t.say('p1', 'buy gold a@b.com AAAAAAAAAAAAAAAA'))).toEqual({ reason: 'personal_info', rule: 5 });
  });
});

describe('mask', () => {
  it('link and personal info spans become * on the delivered text; raw stays in the buffer', () => {
    const t = setup({ filters: { links: { action: 'mask' }, personalInfo: { action: 'mask' } } });
    t.sit('p1', who('k1'));
    const r = t.say('p1', 'see vlemmo.com or mail a@b.com now');
    expect(delivered(r)).toBe('see ********** or mail ******* now');
    const line = t.buffer.snapshot(ROOM)[0]!;
    expect(line.raw).toBe('see vlemmo.com or mail a@b.com now');
    expect(line.delivered).toBe('see ********** or mail ******* now');
    expect(line.blocked).toBe(false);
  });

  it('a ratio mask softens the delivered text', () => {
    const t = setup({ filters: { ratio: { action: 'mask' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'THIS IS ALL SHOUTING NOW. AND MORE!'))).toBe('This is all shouting now. And more!');
    expect(t.buffer.snapshot(ROOM)[0]!.raw).toBe('THIS IS ALL SHOUTING NOW. AND MORE!');
  });

  it('a line that is all mask still delivers', () => {
    const t = setup({ filters: { links: { action: 'mask' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'vlemmo.com'))).toBe('**********');
  });

  it('with profanity set to refuse, a masked line that is still profane is refused as profanity', () => {
    const t = setup({ filters: { links: { action: 'mask' } }, profanityMode: 'refuse' });
    t.sit('p1', who('k1'));
    expect(refusal(t.say('p1', 'snerp vlemmo.com')).reason).toBe('profanity');
  });

  it('a masked phrase covers the matched words only', () => {
    const t = setup({ filters: { phrases: [{ id: 'a', action: 'mask', phrases: ['buy ~ gold'] }] } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'hey buy cheap gold please'))).toBe('hey ************** please');
  });
});

describe('count and flag', () => {
  it('count: the line is untouched and counted', () => {
    const t = setup({ filters: { links: { action: 'count' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(t.calls.counted).toHaveLength(1);
    expect(t.calls.counted[0]).toMatchObject({ key: 'link.unlisted', kind: 'link', action: 'count', rule: 4 });
    expect(t.calls.flags).toEqual([]);
  });

  it('flag: the line delivers and onFilterFlag is told once, after the buffer append, with its lineId', () => {
    const t = setup({ filters: { links: { action: 'flag' }, personalInfo: { action: 'flag' } } });
    const subject = t.sit('p1', who('k1'));
    const r = t.say('p1', 'see vlemmo.com or a@b.com');
    expect(delivered(r)).toBe('see vlemmo.com or a@b.com');
    expect(t.calls.flags).toHaveLength(1);
    const call = t.calls.flags[0]!;
    expect(call.lineId).toBe((r as { deliver: { lineId: string } }).deliver.lineId);
    expect(call.inBuffer).toBe(true);
    expect(call.hit.key).toBe('link.unlisted');
    expect(t.calls.counted.map((h) => h.key)).toEqual(['link.unlisted', 'personal_info.email']);
    void subject;
  });

  it('flag: the call carries the room, the seat and the canonical subject', () => {
    const seen: Array<{ roomId: string; seatId: string; subject: SubjectId }> = [];
    const t = setup({ filters: { links: { action: 'flag' } }, onFlag: (i) => void seen.push({ roomId: i.roomId, seatId: i.seatId, subject: i.subject }) });
    const subject = t.sit('p1', who('k1'));
    t.say('p1', 'see vlemmo.com');
    expect(seen).toEqual([{ roomId: ROOM, seatId: 'p1', subject }]);
  });

  it('a guest speaker counts only: no flag call', () => {
    const t = setup({ filters: { links: { action: 'flag' } } });
    t.sit('p3', null);
    expect(delivered(t.say('p3', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(t.calls.counted).toHaveLength(1);
    expect(t.calls.flags).toEqual([]);
  });

  it('a flag on a masked line delivers the masked text and still calls once', () => {
    const t = setup({ filters: { links: { action: 'mask' }, personalInfo: { action: 'flag' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'vlemmo.com a@b.com'))).toBe('********** a@b.com');
    expect(t.calls.flags).toHaveLength(1);
  });

  it('a line with no hit calls nothing', () => {
    const t = setup({ filters: { links: { action: 'flag' }, personalInfo: { action: 'flag' }, ratio: { action: 'flag' }, phrases: [{ id: 'a', action: 'flag', phrases: ['buy gold'] }] } });
    t.sit('p1', who('k1'));
    t.say('p1', 'good game everyone');
    expect(t.calls.counted).toEqual([]);
    expect(t.calls.flags).toEqual([]);
  });
});

describe('per-room settings and account age', () => {
  it('the getter is called with the room id and a different result changes the next line', () => {
    const rooms: Record<string, ResolvedFilters> = { R1: F({ links: { action: 'refuse' } }), R2: F({}) };
    const t = setup({ settings: (roomId) => rooms[roomId]! });
    t.sit('p1', who('k1'), 'R1');
    t.sit('p1', who('k1'), 'R2');
    expect(refusal(t.say('p1', 'see vlemmo.com', 'R1')).reason).toBe('link');
    t.clock.t += 10_000;
    expect(delivered(t.say('p1', 'see vlemmo.com', 'R2'))).toBe('see vlemmo.com');
    rooms['R2'] = F({ links: { action: 'refuse' } });
    t.clock.t += 10_000;
    expect(refusal(t.say('p1', 'see vlemmo.com', 'R2')).reason).toBe('link');
    expect(t.calls.settings).toEqual(['R1', 'R2', 'R2']);
  });

  it('the account-age hook is called with the speaker and the days, only for an unlisted link with newAccountDays set', () => {
    const asked: Array<[SubjectId | null, number]> = [];
    const t = setup({
      filters: { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3, allow: ['example.com'] } },
      accountIsNew: (s, d) => {
        asked.push([s, d]);
        return true;
      },
    });
    const subject = t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'hello'))).toBe('hello');
    expect(delivered(t.say('p1', 'see example.com'))).toBe('see example.com');
    expect(asked).toEqual([]);
    t.clock.t += 10_000;
    expect(refusal(t.say('p1', 'see vlemmo.com')).reason).toBe('link');
    expect(asked).toEqual([[subject, 3]]);
    expect(t.calls.counted.map((h) => h.key)).toEqual(['link.new_account']);
  });

  it('null, false and a throw from the hook read as not new', () => {
    for (const answer of [() => false, () => null as never, () => undefined as never]) {
      const t = setup({ filters: { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3 } }, accountIsNew: answer });
      t.sit('p1', who('k1'));
      expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    }
    const throwing = setup({
      filters: { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3 } },
      accountIsNew: () => {
        throw new TypeError('x');
      },
    });
    throwing.sit('p1', who('k1'));
    expect(delivered(throwing.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
  });

  it('a new account is acted on despite unlisted allow, and an allow-listed link still passes', () => {
    const t = setup({ filters: { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3, allow: ['example.com'] } }, accountIsNew: () => true });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see example.com'))).toBe('see example.com');
    t.clock.t += 10_000;
    expect(refusal(t.say('p1', 'see vlemmo.com')).reason).toBe('link');
  });
});

describe('the hooks and the facade of the chat service', () => {
  it('without the filters dependency nothing is filtered and onFilterFlag is never called', () => {
    const t = setup({ noFiltersDep: true, filters: { links: { action: 'refuse' } } });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com'))).toBe('see vlemmo.com');
    expect(t.calls.settings).toEqual([]);
  });

  it('with filters off the getter is asked, nothing is counted and the result is the plain line', () => {
    const t = setup({ filters: {} });
    t.sit('p1', who('k1'));
    expect(delivered(t.say('p1', 'see vlemmo.com or a@b.com'))).toBe('see vlemmo.com or a@b.com');
    expect(t.calls.counted).toEqual([]);
  });

  it('a masked line shows the author the masked text (the result is the delivered line)', () => {
    const t = setup({ filters: { personalInfo: { action: 'mask' } } });
    t.sit('p1', who('k1'));
    const r = t.say('p1', 'my number is 555-010-9999');
    expect(delivered(r)).toBe('my number is ************');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Through the facade: cw.filters.test, check and stats, and the settings in force

describe('cw.filters (the facade)', () => {
  const sit = (cw: World['cw']): void => {
    cw.rooms.seat(ROOM, 'p1', { clientKey: 'key-one' }, 'One');
    cw.rooms.seat(ROOM, 'p2', { clientKey: 'key-two' }, 'Two');
  };

  it('a code profile with filters refuses a line with the reason and the rule, and a saved layer applies at once', async () => {
    const { cw, clock } = await world({ overrides: { filters: { links: { action: 'refuse', rule: 4 } } } });
    sit(cw);
    expect(cw.chat.accept(ROOM, 'p1', 'see vlemmo.com')).toEqual({ refuse: { reason: 'link', rule: 4 } });
    clock.t += 10_000;
    expect(cw.policy.save({ filters: { links: null } }, { version: 0, ...OWNER })).toMatchObject({ ok: true });
    expect(cw.chat.accept(ROOM, 'p1', 'see vlemmo.com')).toMatchObject({ deliver: { text: 'see vlemmo.com' } });
    await cw.close();
  });

  it('test: the verdict with spans for the live settings, and the line as it would be delivered', async () => {
    const { cw } = await world({ overrides: { filters: { links: { action: 'mask' } } } });
    const r = cw.filters.test('  see vlemmo.com now ');
    expect(r.delivered).toBe('see ********** now');
    expect(r.verdict.hits.map((h) => h.key)).toEqual(['link.unlisted']);
    expect(r.verdict.spans).toEqual([{ start: 4, end: 14 }]);
    expect(cw.filters.test('good game').delivered).toBe('good game');
    expect(cw.filters.test('good game').verdict.hits).toEqual([]);
    await cw.close();
  });

  it('test: a candidate that is not saved, a refused line (delivered null), and an invalid candidate', async () => {
    const { cw } = await world();
    expect(cw.filters.test('see vlemmo.com').verdict.hits).toEqual([]);
    const r = cw.filters.test('see vlemmo.com', { links: { action: 'refuse', rule: 5 } });
    expect(r.delivered).toBeNull();
    expect(r.verdict.refuse).toEqual({ reason: 'link', rule: 5 });
    expect(cw.profile.filters.links).toBeNull();
    expect(() => cw.filters.test('x', { links: { action: 'nope' as never } })).toThrow(ProfileError);
    try {
      cw.filters.test('x', { links: { action: 'nope' as never } });
    } catch (e) {
      expect((e as ProfileError).path).toBe('candidate.links.action');
    }
    expect(() => cw.filters.test(5 as never)).toThrow(TypeError);
    await cw.close();
  });

  it('check: counts per rule over lines, at most 20 samples per rule, and how many lines would be refused or masked', async () => {
    const { cw } = await world();
    const lines = [
      ...Array.from({ length: 50 }, (_, i) => `see vlemmo${i}.com`),
      ...Array.from({ length: 10 }, (_, i) => `mail a${i}@b.com`),
      'good game',
      '',
      '   ',
    ];
    const r = cw.filters.check({ links: { action: 'refuse' }, personalInfo: { action: 'mask' } }, lines);
    expect(r.lines).toBe(61);
    expect(r.refused).toBe(50);
    expect(r.masked).toBe(10);
    expect(r.rules.map((x) => [x.key, x.hits, x.action, x.rule])).toEqual([
      ['link.unlisted', 50, 'refuse', 4],
      ['personal_info.email', 10, 'mask', 2],
    ]);
    expect(r.rules[0]!.samples).toHaveLength(20);
    expect(r.rules[1]!.samples).toHaveLength(10);
    expect(r.rules[0]!.samples[0]).toEqual({ text: 'see vlemmo0.com', spans: [{ start: 4, end: 15 }] });
    expect(() => cw.filters.check({ links: { action: 'nope' as never } }, [])).toThrow(ProfileError);
    expect(cw.filters.check({}, lines)).toEqual({ lines: 61, refused: 0, masked: 0, rules: [] });
    await cw.close();
  });

  it('check reads at most 5 000 lines and skips what is not text', async () => {
    const { cw } = await world();
    const r = cw.filters.check({ links: { action: 'count' } }, [...Array.from({ length: 6000 }, () => 'see vlemmo.com'), 5 as never]);
    expect(r.lines).toBe(5000);
    expect(cw.filters.check({ links: { action: 'count' } }, 'x' as never).lines).toBe(0);
    await cw.close();
  });

  it('neither test nor check writes anything or counts anything', async () => {
    const { cw } = await world({ overrides: { filters: { links: { action: 'count' } } } });
    cw.filters.test('see vlemmo.com');
    cw.filters.test('see vlemmo.com', { links: { action: 'refuse' } });
    cw.filters.check({ links: { action: 'refuse' } }, ['see vlemmo.com']);
    expect(await cw.filters.stats({ days: 7 })).toEqual({ days: 7, keys: {} });
    await cw.close();
  });

  it('stats: this process is flushed first, and the counts are by key and applied action', async () => {
    const { cw, clock } = await world({
      overrides: { filters: { links: { action: 'mask' }, personalInfo: { action: 'refuse' }, phrases: [{ id: 'ads', action: 'count', phrases: ['buy gold'] }] } },
    });
    sit(cw);
    cw.chat.accept(ROOM, 'p1', 'see vlemmo.com');
    clock.t += 10_000;
    cw.chat.accept(ROOM, 'p1', 'see zorbakk.com and buy gold');
    clock.t += 10_000;
    cw.chat.accept(ROOM, 'p1', 'mail a@b.com');
    expect(await cw.filters.stats({ days: 7 })).toEqual({
      days: 7,
      keys: {
        'link.unlisted': { count: 0, flag: 0, mask: 2, refuse: 0, flag_capped: 0 },
        'personal_info.email': { count: 0, flag: 0, mask: 0, refuse: 1, flag_capped: 0 },
        'phrase.ads': { count: 1, flag: 0, mask: 0, refuse: 0, flag_capped: 0 },
      },
    });
    expect((await cw.filters.stats({ days: 30 })).keys['link.unlisted']!.mask).toBe(2);
    await cw.close();
  });

  it('stats: a count leaves the 7 day window after 7 days and stays in the 30 day one', async () => {
    const { cw, clock } = await world({ overrides: { filters: { links: { action: 'count' } } } });
    sit(cw);
    cw.chat.accept(ROOM, 'p1', 'see vlemmo.com');
    clock.t += 6 * 86_400_000;
    expect((await cw.filters.stats({ days: 7 })).keys['link.unlisted']!.count).toBe(1);
    clock.t += 86_400_000;
    expect((await cw.filters.stats({ days: 7 })).keys).toEqual({});
    expect((await cw.filters.stats({ days: 30 })).keys['link.unlisted']!.count).toBe(1);
    await cw.close();
  });

  it('stats refuses any number of days but 7 and 30', async () => {
    const { cw } = await world();
    for (const days of [0, 1, 14, 31, '7', null, undefined]) await expect(cw.filters.stats({ days } as never)).rejects.toBeInstanceOf(RangeError);
    await expect(cw.filters.stats(null as never)).rejects.toBeInstanceOf(RangeError);
    await cw.close();
  });

  it('close writes what is held and never throws', async () => {
    const { cw } = await world({ overrides: { filters: { links: { action: 'count' } } } });
    sit(cw);
    cw.chat.accept(ROOM, 'p1', 'see vlemmo.com');
    await expect(cw.close()).resolves.toBeUndefined();
  });

  it('the account age comes from signals.accountAgeDays through the account ids of the person', async () => {
    const asked: string[][] = [];
    const { cw, clock } = await world({
      overrides: { filters: { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3 } } },
      signals: {
        accountAgeDays: (ids) => {
          asked.push([...ids]);
          return ids.includes('acct-new') ? 1 : 100;
        },
      },
    });
    cw.rooms.seat(ROOM, 'p1', { clientKey: 'k-new', accountId: 'acct-new' }, 'New');
    cw.rooms.seat(ROOM, 'p2', { clientKey: 'k-old', accountId: 'acct-old' }, 'Old');
    expect(cw.chat.accept(ROOM, 'p1', 'see vlemmo.com')).toEqual({ refuse: { reason: 'link', rule: 4 } });
    clock.t += 10_000;
    expect(cw.chat.accept(ROOM, 'p2', 'see vlemmo.com')).toMatchObject({ deliver: {} });
    expect(asked).toEqual([['acct-new'], ['acct-old']]);
    await cw.close();
  });
});

import { describe, expect, it } from 'vitest';
import { resolveFilters, type FilterSettings, type ResolvedFilters } from '../src/filters.js';
import { createFilterEngine, evaluateFilters, FILTER_LINE_CAP, type FilterVerdict } from '../src/filters/engine.js';
import { __scanSteps } from '../src/filters/links.js';
import { __personalSteps } from '../src/filters/personal.js';
import { __phraseSteps } from '../src/filters/phrases.js';
import { __ratioSteps } from '../src/filters/ratio.js';
import type { Logger, SubjectId } from '../src/types.js';

const S = (f: FilterSettings): ResolvedFilters => resolveFilters(f);
const ev = (f: FilterSettings, text: string, isNew: (days: number) => boolean = () => false): FilterVerdict => evaluateFilters(S(f), text, { accountIsNew: isNew });
const keys = (v: FilterVerdict): string[] => v.hits.map((h) => h.key);
const EMPTY = { hits: [], refuse: null, spans: [], softened: null, flags: [] };

describe('off', () => {
  it('with every block off the verdict is empty and no scanner runs', () => {
    const before = [__scanSteps.n, __personalSteps.n, __phraseSteps.n, __ratioSteps.n];
    for (const f of [{}, { links: null, personalInfo: null, ratio: null, phrases: [] }]) {
      expect(ev(f, 'visit zorbak.com or call 555-010-9999 BUY GOLD NOW AAAAAAAAAAAAAAA')).toEqual(EMPTY);
    }
    expect([__scanSteps.n, __personalSteps.n, __phraseSteps.n, __ratioSteps.n]).toEqual(before);
  });

  it('a block that is off does not run while the others do', () => {
    __personalSteps.n = 0;
    __ratioSteps.n = 0;
    ev({ links: { action: 'count' } }, 'visit zorbak.com 555-010-9999 AAAAAAAAAAAAAAA');
    expect(__personalSteps.n).toBe(0);
    expect(__ratioSteps.n).toBe(0);
  });

  it('the empty verdict is a fresh object each time, so a caller cannot change the next one', () => {
    const a = ev({}, 'hello');
    a.hits.push({ key: 'x', kind: 'link', detail: 'x', action: 'count', rule: 1, spans: [] });
    expect(ev({}, 'hello').hits).toEqual([]);
  });
});

describe('hits', () => {
  it('a link hit: key, kind, detail, action, rule and the range of the link', () => {
    const v = ev({ links: { action: 'flag', rule: 5 } }, 'visit zorbak.com now');
    expect(v.hits).toEqual([{ key: 'link.unlisted', kind: 'link', detail: 'unlisted', action: 'flag', rule: 5, spans: [{ start: 6, end: 16 }] }]);
  });

  it('link details: deny, invite, shortener, unlisted and new_account each have their own key', () => {
    const f: FilterSettings = { links: { action: 'count', deny: ['bad.com'], allow: ['ok.com'], unlisted: 'allow', newAccountDays: 3 } };
    expect(keys(ev(f, 'bad.com'))).toEqual(['link.deny']);
    expect(keys(ev(f, 'discord.gg/x'))).toEqual(['link.invite']);
    expect(keys(ev(f, 'bit.ly/x'))).toEqual(['link.shortener']);
    expect(keys(ev(f, 'ok.com'))).toEqual([]);
    expect(keys(ev(f, 'zorbak.com'))).toEqual([]);
    expect(keys(ev(f, 'zorbak.com', () => true))).toEqual(['link.new_account']);
    expect(keys(ev({ links: { action: 'count' } }, 'zorbak.com'))).toEqual(['link.unlisted']);
  });

  it('several links of one kind are one hit with every range, in text order', () => {
    const v = ev({ links: { action: 'mask' } }, 'a zorbak.com b vlemmo.net c');
    expect(v.hits).toHaveLength(1);
    expect(v.hits[0]!.spans).toEqual([{ start: 2, end: 12 }, { start: 15, end: 25 }]);
  });

  it('different kinds in one line are different hits, in order of first appearance', () => {
    expect(keys(ev({ links: { action: 'count' } }, 'x discord.gg/a y zorbak.com z bit.ly/q'))).toEqual(['link.invite', 'link.unlisted', 'link.shortener']);
  });

  it('personal info hits: key per detail, the address takes the address action, every other detail the block action', () => {
    const v = ev({ personalInfo: { action: 'mask', rule: 3, address: 'flag' } }, 'mail a@b.com at 221 Baker Street or 555-010-9999');
    expect(v.hits.map((h) => [h.key, h.kind, h.action, h.rule])).toEqual([
      ['personal_info.email', 'personal_info', 'mask', 3],
      ['personal_info.address', 'personal_info', 'flag', 3],
      ['personal_info.phone', 'personal_info', 'mask', 3],
    ]);
    expect(v.spans).toHaveLength(2);
  });

  it('phrase hits: one per rule that matched, in list order, with the rule number, label-free detail', () => {
    const v = ev(
      {
        phrases: [
          { id: 'ads', action: 'flag', phrases: ['buy gold'] },
          { id: 'none', action: 'count', phrases: ['zorbak vlemmo'] },
          { id: 'scam', action: 'refuse', rule: 6, phrases: ['free * gold'] },
        ],
      },
      'buy gold and free big gold',
    );
    expect(v.hits.map((h) => [h.key, h.detail, h.kind, h.action, h.rule])).toEqual([
      ['phrase.ads', 'ads', 'phrase', 'flag', 4],
      ['phrase.scam', 'scam', 'phrase', 'refuse', 6],
    ]);
  });

  it('ratio hits: one per check that tripped, with no ranges', () => {
    const v = ev({ ratio: { action: 'count', rule: 7 } }, `${'AB'.repeat(15)} nooooooooo`);
    expect(v.hits.map((h) => [h.key, h.kind, h.detail, h.rule, h.spans])).toEqual([
      ['ratio.caps', 'ratio', 'caps', 7, []],
      ['ratio.repeats', 'ratio', 'repeats', 7, []],
    ]);
  });

  it('the fixed order is links, personal info, phrases in list order, ratio', () => {
    const v = ev(
      {
        ratio: { action: 'count' },
        phrases: [{ id: 'p1', action: 'count', phrases: ['buy gold'] }],
        personalInfo: { action: 'count' },
        links: { action: 'count' },
      },
      `BUY GOLD ${'A'.repeat(30)} a@b.com zorbak.com`,
    );
    expect(keys(v)).toEqual(['link.unlisted', 'personal_info.email', 'phrase.p1', 'ratio.caps', 'ratio.repeats']);
  });

  it('the verdict holds no copy of the line', () => {
    const text = 'secret zorbak.com line with a@b.com';
    const json = JSON.stringify(ev({ links: { action: 'mask' }, personalInfo: { action: 'mask' } }, text));
    expect(json).not.toContain('secret');
    expect(json).not.toContain('zorbak');
    expect(json).not.toContain('a@b');
  });
});

describe('precedence', () => {
  const all = (action: 'count' | 'flag' | 'mask' | 'refuse'): FilterSettings => ({ links: { action } });

  it('refuse beats mask beats flag beats count', () => {
    const f: FilterSettings = {
      links: { action: 'mask' },
      personalInfo: { action: 'flag' },
      phrases: [{ id: 'a', action: 'count', phrases: ['buy gold'] }, { id: 'b', action: 'refuse', phrases: ['free gold'] }],
    };
    const v = ev(f, 'zorbak.com a@b.com buy gold free gold');
    expect(v.refuse).toEqual({ reason: 'filter', rule: 4 });
    expect(v.spans).toHaveLength(1);
    expect(v.flags.map((h) => h.key)).toEqual(['personal_info.email']);
    expect(v.hits).toHaveLength(4);
    expect(ev(all('mask'), 'zorbak.com').refuse).toBeNull();
    expect(ev(all('flag'), 'zorbak.com').refuse).toBeNull();
    expect(ev(all('count'), 'zorbak.com').spans).toEqual([]);
  });

  it('the refusal reason follows the kind: link, personal_info, and filter for phrases and ratio', () => {
    expect(ev({ links: { action: 'refuse', rule: 8 } }, 'zorbak.com').refuse).toEqual({ reason: 'link', rule: 8 });
    expect(ev({ personalInfo: { action: 'refuse', rule: 9 } }, 'a@b.com').refuse).toEqual({ reason: 'personal_info', rule: 9 });
    expect(ev({ phrases: [{ id: 'a', action: 'refuse', rule: 3, phrases: ['buy gold'] }] }, 'buy gold').refuse).toEqual({ reason: 'filter', rule: 3 });
    expect(ev({ ratio: { action: 'refuse', rule: 2 } }, 'AAAAAAAAAAAAAAAA').refuse).toEqual({ reason: 'filter', rule: 2 });
  });

  it('two refusing rules cite the first in links, personal info, phrase list, ratio order; every hit still counts', () => {
    const f: FilterSettings = {
      ratio: { action: 'refuse', rule: 2 },
      phrases: [{ id: 'a', action: 'refuse', rule: 3, phrases: ['buy gold'] }, { id: 'b', action: 'refuse', rule: 4, phrases: ['buy gold'] }],
      personalInfo: { action: 'refuse', rule: 5 },
      links: { action: 'refuse', rule: 6 },
    };
    const text = `buy gold a@b.com zorbak.com ${'A'.repeat(80)}`;
    const v = ev(f, text);
    expect(v.refuse).toEqual({ reason: 'link', rule: 6 });
    expect(keys(v)).toEqual(['link.unlisted', 'personal_info.email', 'phrase.a', 'phrase.b', 'ratio.caps', 'ratio.repeats']);
    expect(ev({ ...f, links: null }, text).refuse).toEqual({ reason: 'personal_info', rule: 5 });
    expect(ev({ ...f, links: null, personalInfo: null }, text).refuse).toEqual({ reason: 'filter', rule: 3 });
    expect(ev({ ...f, links: null, personalInfo: null, phrases: [] }, text).refuse).toEqual({ reason: 'filter', rule: 2 });
  });

  it('flags come in the fixed order, and a refusing line may carry flags too', () => {
    const v = ev(
      { links: { action: 'flag' }, personalInfo: { action: 'refuse' }, phrases: [{ id: 'a', action: 'flag', phrases: ['buy gold'] }] },
      'zorbak.com a@b.com buy gold',
    );
    expect(v.flags.map((h) => h.key)).toEqual(['link.unlisted', 'phrase.a']);
    expect(v.refuse?.reason).toBe('personal_info');
  });
});

describe('mask and soften', () => {
  it('link and personal info spans are returned for the caller to cover; the text is untouched', () => {
    const text = 'x zorbak.com y a@b.com z';
    const v = ev({ links: { action: 'mask' }, personalInfo: { action: 'mask' } }, text);
    expect(v.spans.map((s) => text.slice(s.start, s.end))).toEqual(['zorbak.com', 'a@b.com']);
    expect(v.softened).toBeNull();
  });

  it('a phrase mask covers the matched words', () => {
    const text = 'please buy cheap gold now';
    const v = ev({ phrases: [{ id: 'a', action: 'mask', phrases: ['buy ~ gold'] }] }, text);
    expect(v.spans.map((s) => text.slice(s.start, s.end))).toEqual(['buy cheap gold']);
  });

  it('a ratio mask softens the line: the other masks are applied first, then caps are lowercased', () => {
    const text = 'LOOK AT THIS GREAT OFFER zorbak.com NOW';
    const v = ev({ links: { action: 'mask' }, ratio: { action: 'mask' } }, text);
    expect(v.softened).toBe('Look at this great offer ********** now');
    expect(v.spans).toHaveLength(1);
  });

  it('a ratio mask cuts a run and keeps the masked stars as they are', () => {
    const v = ev({ links: { action: 'mask' }, ratio: { action: 'mask' } }, 'zorbak.com nooooooooo');
    expect(v.softened).toBe('********** noooooo');
  });

  it('a ratio rule that only flags or counts leaves softened null', () => {
    expect(ev({ ratio: { action: 'flag' } }, 'AAAAAAAAAAAAAAAA').softened).toBeNull();
    expect(ev({ ratio: { action: 'count' } }, 'AAAAAAAAAAAAAAAA').softened).toBeNull();
    expect(ev({ ratio: { action: 'refuse' } }, 'AAAAAAAAAAAAAAAA').softened).toBeNull();
  });

  it('a ratio mask on a line that trips nothing leaves softened null', () => {
    expect(ev({ ratio: { action: 'mask' } }, 'a perfectly calm line').softened).toBeNull();
  });

  it('only mask hits contribute spans: a flagged link next to a masked email covers only the email', () => {
    const text = 'zorbak.com a@b.com';
    const v = ev({ links: { action: 'flag' }, personalInfo: { action: 'mask' } }, text);
    expect(v.spans.map((s) => text.slice(s.start, s.end))).toEqual(['a@b.com']);
  });
});

describe('ignore', () => {
  it('ignore phrases are blanked before any block reads, offsets kept', () => {
    const f: FilterSettings = { personalInfo: { action: 'count', phone: 'any' }, ignore: ['1 2 3 4 5 6 7 8 9', 'e.g.'] };
    expect(keys(ev(f, 'the code 1 2 3 4 5 6 7 8 9 is public'))).toEqual([]);
    expect(keys(ev({ personalInfo: { action: 'count', phone: 'any' } }, 'the code 1 2 3 4 5 6 7 8 9 is public'))).toEqual(['personal_info.phone']);
    expect(keys(ev({ links: { action: 'count' }, ignore: ['e.g.'] }, 'see e.g.com or zorbak.com'))).toEqual(['link.unlisted']);
  });

  it('is case-insensitive, and ranges still index the original line', () => {
    const text = 'Hello E.G. zorbak.com';
    const v = ev({ links: { action: 'mask' }, ignore: ['e.g.'] }, text);
    expect(v.spans.map((s) => text.slice(s.start, s.end))).toEqual(['zorbak.com']);
  });

  it('an ignored phrase inside a link leaves the rest readable', () => {
    const text = 'go zorbak.com/e.g.-guide now';
    const v = ev({ links: { action: 'mask' }, ignore: ['e.g.'] }, text);
    expect(v.hits).toHaveLength(1);
    expect(text.slice(v.spans[0]!.start, v.spans[0]!.end)).toBe('zorbak.com/');
  });

  it('every occurrence is blanked', () => {
    expect(keys(ev({ links: { action: 'count' }, ignore: ['zorbak.com'] }, 'zorbak.com and zorbak.com and ZORBAK.COM'))).toEqual([]);
  });
});

describe('limits', () => {
  it('only the first 2 000 characters are read', () => {
    expect(FILTER_LINE_CAP).toBe(2000);
    const pad = 'x '.repeat(1100);
    expect(keys(ev({ links: { action: 'count' } }, `${pad}zorbak.com`))).toEqual([]);
    expect(keys(ev({ links: { action: 'count' } }, `zorbak.com ${pad}`))).toEqual(['link.unlisted']);
  });

  it('the rest of a long line is delivered as it was when softened', () => {
    const text = `${'a'.repeat(10)} ${'y '.repeat(1500)}`;
    const v = ev({ ratio: { action: 'mask' } }, text);
    expect(v.softened!.length).toBeLessThanOrEqual(text.length);
    expect(v.softened!.startsWith('aaaaaa y')).toBe(true);
    expect(v.softened!.endsWith(text.slice(2000))).toBe(true);
  });

  it('empty and non-string input give the empty verdict', () => {
    expect(ev({ links: { action: 'refuse' } }, '')).toEqual(EMPTY);
    expect(evaluateFilters(S({ links: { action: 'refuse' } }), undefined as never, { accountIsNew: () => false })).toEqual(EMPTY);
  });
});

describe('account age', () => {
  const f: FilterSettings = { links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3, allow: ['example.com'] } };

  it('is asked for only when an unlisted link is present and newAccountDays is set, once per line, with the days', () => {
    const calls: number[] = [];
    const ask = (days: number): boolean => {
      calls.push(days);
      return true;
    };
    expect(ev(f, 'hello', ask).refuse).toBeNull();
    expect(ev(f, 'example.com', ask).refuse).toBeNull();
    expect(ev(f, 'discord.gg/x', ask).hits[0]!.key).toBe('link.invite');
    expect(ev({ links: { action: 'refuse', unlisted: 'allow' } }, 'zorbak.com', ask).refuse).toBeNull();
    expect(ev({ links: { action: 'refuse', unlisted: 'act', newAccountDays: 3 } }, 'zorbak.com', ask).hits[0]!.key).toBe('link.unlisted');
    expect(calls).toEqual([]);
    expect(ev(f, 'zorbak.com vlemmo.net quissel.org', ask).refuse).toEqual({ reason: 'link', rule: 4 });
    expect(calls).toEqual([3]);
  });

  it('a new account is acted on despite unlisted allow and still passes the allow list', () => {
    expect(ev(f, 'zorbak.com', () => true).hits.map((h) => h.key)).toEqual(['link.new_account']);
    expect(ev(f, 'zorbak.com', () => false).hits).toEqual([]);
    expect(ev(f, 'example.com cdn.example.com', () => true).hits).toEqual([]);
  });

  it('a throwing hook reads as not new', () => {
    expect(
      ev(f, 'zorbak.com', () => {
        throw new TypeError('x');
      }).hits,
    ).toEqual([]);
  });
});

describe('createFilterEngine', () => {
  const clock = { now: () => 1_800_000_000_000 };
  const quiet: Logger = { warn() {} };
  const make = (over: Partial<Parameters<typeof createFilterEngine>[0]> = {}) => {
    const asked: string[][] = [];
    const engine = createFilterEngine({
      settings: () => S({ links: { action: 'refuse', unlisted: 'allow', newAccountDays: 3 } }),
      accountAgeDays: (ids) => {
        asked.push([...ids]);
        return 1;
      },
      accountIds: (s) => [`acct-of-${s}`],
      canonical: (s) => `canon-${s}`,
      clock,
      logger: quiet,
      ...over,
    });
    return { engine, asked };
  };

  it('per-room settings: the getter is called with the room id and a different result changes the next line', () => {
    const seen: string[] = [];
    const rooms: Record<string, ResolvedFilters> = { A: S({ links: { action: 'refuse' } }), B: S({}) };
    const { engine } = make({
      settings: (roomId) => {
        seen.push(roomId);
        return rooms[roomId]!;
      },
    });
    expect(engine.evaluate('A', 'zorbak.com', { subject: null }).refuse?.reason).toBe('link');
    expect(engine.evaluate('B', 'zorbak.com', { subject: null }).refuse).toBeNull();
    expect(seen).toEqual(['A', 'B']);
  });

  it('the age hook gets the account ids of the canonical person, and a young account is new', () => {
    const { engine, asked } = make();
    expect(engine.evaluate('A', 'zorbak.com', { subject: 's1' as SubjectId }).refuse?.reason).toBe('link');
    expect(asked).toEqual([['acct-of-canon-s1']]);
  });

  it('an old account is not new; null, undefined and a throw read as not new; a guest is not new', () => {
    const answers: Array<number | null | undefined> = [30, null, undefined, 3, 2.9];
    const got = answers.map((age) => make({ accountAgeDays: () => age }).engine.evaluate('A', 'zorbak.com', { subject: 's1' as SubjectId }).refuse !== null);
    expect(got).toEqual([false, false, false, false, true]);
    const throwing = make({
      accountAgeDays: () => {
        throw new RangeError('x');
      },
    });
    expect(throwing.engine.evaluate('A', 'zorbak.com', { subject: 's1' as SubjectId }).refuse).toBeNull();
    const { engine, asked } = make();
    expect(engine.evaluate('A', 'zorbak.com', { subject: null }).refuse).toBeNull();
    expect(asked).toEqual([]);
    expect(make({ accountAgeDays: undefined }).engine.evaluate('A', 'zorbak.com', { subject: 's1' as SubjectId }).refuse).toBeNull();
  });

  it('a non-number or negative age reads as not new', () => {
    for (const age of ['5', NaN, -1, {}, true]) {
      expect(make({ accountAgeDays: () => age as never }).engine.evaluate('A', 'zorbak.com', { subject: 's1' as SubjectId }).refuse).toBeNull();
    }
  });

  it('evaluateWith runs a candidate under the same rules, with no room and no person', () => {
    const { engine, asked } = make();
    const v = engine.evaluateWith(S({ links: { action: 'mask' } }), 'x zorbak.com', { subject: null });
    expect(v.spans).toEqual([{ start: 2, end: 12 }]);
    expect(asked).toEqual([]);
  });
});

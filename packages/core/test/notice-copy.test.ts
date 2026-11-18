import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { dayText, englishWords, noticeView, restrictedChatText, timeLeft, untilText } from '../src/noticeCopy.js';
import type { NoticeViewContext } from '../src/noticeCopy.js';
import type { PlayerNotice } from '../src/notices.js';

// noticeView: what a notice says, as plain text. The cases are the ones player-react drew before the move (the card and "My record"), so a
// change in what a player reads fails here. Synthetic references only.

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const notice = (over: Partial<PlayerNotice> = {}): PlayerNotice => ({
  id: 'n1',
  kind: 'chat',
  rule: 2,
  ruleLabel: 'Community Rule 2: No insulting, threatening or targeting another player',
  until: NOW + 3 * HOUR,
  refCode: 'M-AB123',
  excerpt: [],
  createdAt: NOW,
  mustAcknowledge: false,
  ...over,
});

const ctx = (over: Partial<NoticeViewContext> = {}): NoticeViewContext => ({
  words: englishWords(),
  locale: 'en',
  timeZone: 'UTC',
  now: () => NOW,
  ...over,
});

const factsOf = (n: PlayerNotice, over: Partial<NoticeViewContext> = {}) => noticeView(n, ctx(over)).facts.map((f) => [f.id, f.term, f.value]);

describe('noticeView: a warning', () => {
  const w = notice({ kind: 'warning', until: null, mustAcknowledge: true });
  it('is on the record for 90 days, says to acknowledge and asks for an acknowledgement', () => {
    const v = noticeView(w, ctx());
    expect(v).toMatchObject({
      kind: 'warning',
      title: 'You have a warning',
      body: 'A moderator gave you a warning for breaking a community rule. You can keep playing.',
      refHint: 'Quote this code if you contact us.',
      linesLabel: null,
      lines: [],
      mustAcknowledge: true,
      todo: 'Press Acknowledge to confirm you saw this.',
      button: 'Acknowledge',
      sanction: true,
    });
    expect(v.facts.map((f) => [f.id, f.term, f.value])).toEqual([
      ['rule', 'Rule', 'Community Rule 2: No insulting, threatening or targeting another player'],
      ['onRecordUntil', 'On your record until', 'Apr 15, 2027, 12:00 PM'],
      ['ref', 'Reference', 'M-AB123'],
    ]);
  });
  it('asks for an acknowledgement because it is a warning, whatever the flag says', () => {
    expect(noticeView(notice({ kind: 'warning', until: null, mustAcknowledge: false }), ctx()).mustAcknowledge).toBe(true);
  });
});

describe('noticeView: restrictions', () => {
  it('a timed restriction has an until with the time left', () => {
    const v = noticeView(notice(), ctx());
    expect(v).toMatchObject({ title: 'Your chat is turned off', mustAcknowledge: false, todo: null, button: 'Got it', sanction: true });
    expect(v.facts.map((f) => [f.id, f.term, f.value])).toEqual([
      ['rule', 'Rule', 'Community Rule 2: No insulting, threatening or targeting another player'],
      ['until', 'Until', 'Jan 15, 2027, 3:00 PM (in 3 hours)'],
      ['ref', 'Reference', 'M-AB123'],
    ]);
  });
  it('an ended one says Ended with the time and no time left', () => {
    expect(factsOf(notice({ until: NOW - HOUR })).filter(([id]) => id !== 'rule' && id !== 'ref')).toEqual([['ended', 'Ended', 'Jan 15, 2027, 11:00 AM']]);
    // the moment it ends is an end, not "in 0 minutes"
    expect(factsOf(notice({ until: NOW })).map(([id]) => id)).toContain('ended');
  });
  it('a permanent ban has no end date', () => {
    const v = noticeView(notice({ kind: 'ban', until: null }), ctx());
    expect(v).toMatchObject({ title: 'You are banned', sanction: true });
    expect(v.facts.find((f) => f.id === 'until')).toEqual({ id: 'until', term: 'Until', value: 'No end date' });
  });
  it('an area restriction reads its own title and body', () => {
    expect(noticeView(notice({ kind: 'area' }), ctx())).toMatchObject({
      title: 'You cannot join public rooms',
      body: 'A moderator stopped you joining public rooms and matchmaking. You can still play in private rooms.',
    });
  });
  it('the time left follows the clock it is given', () => {
    const at = notice({ until: NOW + 5 * MINUTE });
    expect(factsOf(at).find(([id]) => id === 'until')?.[2]).toBe('Jan 15, 2027, 12:05 PM (in 5 minutes)');
    expect(factsOf(at, { now: () => NOW + 4 * MINUTE }).find(([id]) => id === 'until')?.[2]).toBe('Jan 15, 2027, 12:05 PM (in 1 minute)');
    expect(factsOf(at, { now: () => NOW + 6 * MINUTE }).find(([id]) => id === 'ended')?.[2]).toBe('Jan 15, 2027, 12:05 PM');
  });
});

describe('noticeView: notices that are not sanctions', () => {
  it('a report outcome has no end, no appeal slot and a Got it button', () => {
    const v = noticeView(notice({ kind: 'report_outcome', rule: null, ruleLabel: null, until: null, refCode: null }), ctx());
    expect(v).toMatchObject({ title: 'Thanks for your report', sanction: false, refHint: null, mustAcknowledge: false, button: 'Got it', todo: null });
    expect(v.facts).toEqual([]);
  });
  it.each([
    ['rename_required', 'Please choose a new name'],
    ['appeal_upheld', 'We looked again and kept the decision'],
    ['appeal_reduced', 'We looked again and changed the decision'],
    ['appeal_revoked', 'We looked again and removed the decision'],
  ] as const)('%s reads its own title, shows the rule and the reference, and is not a sanction', (kind, title) => {
    const v = noticeView(notice({ kind, until: null }), ctx());
    expect(v.title).toBe(title);
    expect(v.sanction).toBe(false);
    expect(v.facts.map((f) => f.id)).toEqual(['rule', 'ref']);
  });
  it('a message that does carry an end shows it, like the card always did', () => {
    expect(factsOf(notice({ kind: 'appeal_reduced', until: NOW + DAY })).map(([id]) => id)).toEqual(['rule', 'until', 'ref']);
  });
  it('an unknown kind falls back to the fallback title and body; a kind that is not a sanction has no appeal slot', () => {
    const v = noticeView(notice({ kind: 'mystery' as never, until: null }), ctx());
    expect(v).toMatchObject({ kind: 'mystery', title: 'A message from the moderators', body: 'There is a new message about your account.', sanction: false, button: 'Got it' });
    expect(v.facts.map((f) => f.id)).toEqual(['rule', 'ref']);
    for (const kind of ['__proto__', 'toString', 'constructor']) expect(noticeView(notice({ kind: kind as never, until: null }), ctx()).title).toBe('A message from the moderators');
  });
});

describe('noticeView: parts that come and go', () => {
  it('no rule: no Rule row', () => {
    expect(factsOf(notice({ rule: null, ruleLabel: null })).map(([id]) => id)).toEqual(['until', 'ref']);
  });
  it('no reference: no Reference row and no hint', () => {
    const v = noticeView(notice({ refCode: null }), ctx());
    expect(v.facts.map((f) => f.id)).toEqual(['rule', 'until']);
    expect(v.refHint).toBeNull();
  });
  it('five lines are listed with their day, in order, and the label is there; none has no label', () => {
    const excerpt = Array.from({ length: 5 }, (_, i) => ({ day: `2027-01-${String(10 + i).padStart(2, '0')}`, text: `line ${i}` }));
    const v = noticeView(notice({ excerpt }), ctx());
    expect(v.linesLabel).toBe('What led to this');
    expect(v.lines).toEqual([
      { day: 'Jan 10, 2027', text: 'line 0' },
      { day: 'Jan 11, 2027', text: 'line 1' },
      { day: 'Jan 12, 2027', text: 'line 2' },
      { day: 'Jan 13, 2027', text: 'line 3' },
      { day: 'Jan 14, 2027', text: 'line 4' },
    ]);
    const none = noticeView(notice(), ctx());
    expect(none.linesLabel).toBeNull();
    expect(none.lines).toEqual([]);
  });
  it('a line that is not a day is shown as it came; the text is never changed', () => {
    const v = noticeView(notice({ excerpt: [{ day: 'soon', text: '<b>x</b> ***' }] }), ctx());
    expect(v.lines).toEqual([{ day: 'soon', text: '<b>x</b> ***' }]);
  });
  it('record mode adds Given, after the rule and before the end', () => {
    const v = noticeView(notice(), ctx({ record: true }));
    expect(v.facts.map((f) => f.id)).toEqual(['rule', 'given', 'until', 'ref']);
    expect(v.facts.find((f) => f.id === 'given')).toEqual({ id: 'given', term: 'Given', value: 'Jan 15, 2027, 12:00 PM' });
    expect(factsOf(notice(), { record: false }).map(([id]) => id)).not.toContain('given');
  });
});

describe('noticeView: words, locale and zone', () => {
  it('uses the catalog it is given, and falls back to English for a key it lacks', () => {
    const words = { ...englishWords(), 'player.notice.title.chat': 'Chat aus', 'player.notice.until': 'Bis' };
    const v = noticeView(notice(), ctx({ words }));
    expect(v.title).toBe('Chat aus');
    expect(v.facts.find((f) => f.id === 'until')?.term).toBe('Bis');
    const partial = { 'player.notice.title.chat': 'Chat aus' } as never;
    const p = noticeView(notice(), ctx({ words: partial }));
    expect(p.title).toBe('Chat aus');
    expect(p.body).toBe('A moderator turned off your chat. You can still play.');
    expect(p.button).toBe('Got it');
  });
  it('fills {when} and {left} wherever the translation puts them', () => {
    const words = { ...englishWords(), 'player.notice.untilLeft': '{left} - {when}' };
    expect(noticeView(notice(), ctx({ words })).facts.find((f) => f.id === 'until')?.value).toBe('in 3 hours - Jan 15, 2027, 3:00 PM');
  });
  it('writes times in the locale and the zone', () => {
    expect(factsOf(notice({ until: NOW + 3 * HOUR }), { timeZone: 'America/New_York' }).find(([id]) => id === 'until')?.[2]).toBe('Jan 15, 2027, 10:00 AM (in 3 hours)');
    expect(factsOf(notice({ until: NOW + 2 * DAY }), { locale: 'de' }).find(([id]) => id === 'until')?.[2]).toMatch(/17\.01\.2027.*\(in 2 Tagen\)/);
  });
  it('survives a locale and a zone the runtime does not know', () => {
    expect(() => noticeView(notice(), ctx({ locale: 'not a locale', timeZone: 'Not/AZone' }))).not.toThrow();
  });
  it('does not change the notice it is given', () => {
    const n = notice({ excerpt: [{ day: '2027-01-14', text: 'a' }] });
    const before = JSON.stringify(n);
    noticeView(n, ctx());
    expect(JSON.stringify(n)).toBe(before);
  });
});

describe('dayText, untilText and timeLeft keep the cases they had in player-react', () => {
  describe('dayText', () => {
    it('writes a UTC day as the locale writes a date, in UTC whatever the viewer time zone', () => {
      expect(dayText('2027-01-15', 'en')).toBe('Jan 15, 2027');
      expect(dayText('2027-01-01', 'en')).toBe('Jan 1, 2027');
      expect(dayText('2027-12-31', 'en')).toBe('Dec 31, 2027');
    });
    it('follows the locale', () => {
      expect(dayText('2027-01-15', 'de')).toBe('15.01.2027');
    });
    it('gives a value that is not a day back as it came, never "Invalid Date"', () => {
      for (const bad of ['', 'soon', '2027-13-45', '2027-1-5', '<b>x</b>']) expect(dayText(bad, 'en')).toBe(bad);
    });
    it('survives a locale the runtime does not know', () => {
      expect(dayText('2027-01-15', 'not a locale')).toBe('Jan 15, 2027');
    });
  });

  describe('untilText', () => {
    const at = Date.UTC(2027, 0, 15, 20, 30);
    it('writes a date and time in the locale and the given zone', () => {
      expect(untilText(at, 'en', 'UTC')).toBe('Jan 15, 2027, 8:30 PM');
      expect(untilText(at, 'en', 'America/New_York')).toBe('Jan 15, 2027, 3:30 PM');
      expect(untilText(at, 'de', 'UTC')).toMatch(/15\.01\.2027/);
    });
    it('survives a locale the runtime does not know and a zone it does not know', () => {
      expect(untilText(at, 'not a locale', 'UTC')).toBe('Jan 15, 2027, 8:30 PM');
      expect(() => untilText(at, 'en', 'Not/AZone')).not.toThrow();
    });
    it('never holds a narrow no-break space', () => {
      expect(untilText(at, 'en', 'UTC')).not.toMatch(/[\u202f\u00a0]/);
    });
  });

  describe('timeLeft', () => {
    const now = NOW;
    it('says how long is left in the largest whole unit: minutes, hours, days', () => {
      expect(timeLeft(now + 5 * MINUTE, now, 'en')).toBe('in 5 minutes');
      expect(timeLeft(now + 90 * MINUTE, now, 'en')).toBe('in 2 hours');
      expect(timeLeft(now + 3 * HOUR, now, 'en')).toBe('in 3 hours');
      expect(timeLeft(now + 2 * DAY, now, 'en')).toBe('in 2 days');
      expect(timeLeft(now + 40 * DAY, now, 'en')).toBe('in 40 days');
    });
    it('rounds a part of a minute up to a minute, so a live restriction never reads "in 0 minutes"', () => {
      expect(timeLeft(now + 1000, now, 'en')).toBe('in 1 minute');
      expect(timeLeft(now + 59_000, now, 'en')).toBe('in 1 minute');
    });
    it('says nothing for a time that has passed (or is now)', () => {
      expect(timeLeft(now, now, 'en')).toBeNull();
      expect(timeLeft(now - 1, now, 'en')).toBeNull();
      expect(timeLeft(now - DAY, now, 'en')).toBeNull();
    });
    it('follows the locale', () => {
      expect(timeLeft(now + 2 * DAY, now, 'de')).toBe('in 2 Tagen');
    });
  });
});

describe('the subpath is plain, portable code', () => {
  const source = readFileSync(fileURLToPath(new URL('../src/noticeCopy.ts', import.meta.url)), 'utf8');
  const imports = [...source.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1] as string);

  it('the subpath imports no node module and no React', () => {
    for (const spec of imports) {
      expect(spec, spec).not.toMatch(/^node:/);
      expect(spec, spec).not.toMatch(/^(react|react-dom|fs|path|crypto|os|url|util)(\/|$)/);
    }
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
  it('it imports only types from the rest of core (nothing is loaded when it is)', () => {
    for (const line of source.split('\n').filter((l) => /^import\b/.test(l))) expect(line).toMatch(/^import type\b/);
  });
  it('it holds no clock of its own: the time is passed in', () => {
    expect(source).not.toMatch(/Date\.now\(|new Date\(\)|performance\.now/);
  });
});

describe('restrictedChatText: the line in place of the chat box', () => {
  const words = englishWords();
  const say = (key: keyof typeof words, values: Record<string, string>) => words[key].replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);
  const text = (o: { until: number | null; byModerator: boolean }, over: { now?: number; locale?: string } = {}) =>
    restrictedChatText(say, { ...o, now: over.now ?? NOW, locale: over.locale ?? 'en', timeZone: 'UTC' });

  it('a moderator, with an end: the date and how long is left', () => {
    expect(text({ until: NOW + 3 * HOUR, byModerator: true })).toBe('A moderator turned off your chat until Jan 15, 2027, 3:00 PM (in 3 hours).');
    expect(text({ until: NOW + 2 * DAY, byModerator: true })).toBe('A moderator turned off your chat until Jan 17, 2027, 12:00 PM (in 2 days).');
  });

  it('a moderator, no end', () => {
    expect(text({ until: null, byModerator: true })).toBe('A moderator turned off your chat. It does not end on its own.');
  });

  it('the filter, with and without an end', () => {
    expect(text({ until: NOW + HOUR, byModerator: false })).toBe('Your chat is off until Jan 15, 2027, 1:00 PM (in 1 hour). The automatic filter caught a message.');
    expect(text({ until: null, byModerator: false })).toBe('Your chat is off. It does not end on its own. The automatic filter caught a message.');
  });

  it('an end that has passed says the chat is back on, whoever turned it off', () => {
    for (const byModerator of [true, false]) {
      expect(text({ until: NOW - MINUTE, byModerator })).toBe('Your chat is back on. The restriction ended Jan 15, 2027, 11:59 AM.');
      expect(text({ until: NOW, byModerator })).toBe('Your chat is back on. The restriction ended Jan 15, 2027, 12:00 PM.');
    }
  });

  it('an end that is not a finite number reads as no end', () => {
    expect(text({ until: Number.NaN, byModerator: true })).toBe('A moderator turned off your chat. It does not end on its own.');
    expect(text({ until: Infinity, byModerator: false })).toBe('Your chat is off. It does not end on its own. The automatic filter caught a message.');
  });
});

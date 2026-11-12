import { describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import type { PlayerText } from '../src/i18n.js';

// Test catalogs use keys the real catalog does not have, so the keys are cast.
const k = (key: string): PlayerText => key as PlayerText;
const text = (key: string): string => (en as Record<string, string>)[key] as string;

describe('createT', () => {
  it('returns the catalog text for a key', () => {
    const t = createT({ 'a.b': 'Hello' }, 'en');
    expect(t(k('a.b'))).toBe('Hello');
  });

  it('falls back to the key itself when the catalog has no such key', () => {
    const t = createT({}, 'en');
    expect(t(k('player.missing.key'))).toBe('player.missing.key');
  });

  it('fills {name} placeholders and leaves a placeholder with no value as written', () => {
    const t = createT({ greet: 'Hi {name}, you have {n} left, {unknown}' }, 'en');
    expect(t(k('greet'), { name: 'Ann', n: 3 })).toBe('Hi Ann, you have 3 left, {unknown}');
  });

  it('fills a placeholder every time it appears', () => {
    const t = createT({ twice: '{x} and {x}' }, 'en');
    expect(t(k('twice'), { x: 'a' })).toBe('a and a');
  });

  it('does not expand a placeholder that arrives inside a value', () => {
    const t = createT({ greet: 'Hi {name} {other}' }, 'en');
    expect(t(k('greet'), { name: '{other}', other: 'X' })).toBe('Hi {other} X');
  });

  it('does not treat $ in a value specially', () => {
    const t = createT({ price: 'Cost {p}' }, 'en');
    expect(t(k('price'), { p: "$& $1 $'" })).toBe("Cost $& $1 $'");
  });

  it('formats numbers for the locale', () => {
    expect(createT({ n: '{count} lines' }, 'en')(k('n'), { count: 1234 })).toBe('1,234 lines');
    expect(createT({ n: '{count} lines' }, 'de')(k('n'), { count: 1234 })).toBe('1.234 lines');
  });

  describe('plurals', () => {
    const cat = { 'r.one': '{count} report', 'r.other': '{count} reports', 'r.zero': 'No reports' };
    it('picks .one and .other by the English rule', () => {
      const t = createT(cat, 'en');
      expect(t(k('r'), { count: 1 })).toBe('1 report');
      expect(t(k('r'), { count: 2 })).toBe('2 reports');
      expect(t(k('r'), { count: 11 })).toBe('11 reports');
      expect(t(k('r'), { count: 1.5 })).toBe('1.5 reports');
    });
    it('uses .zero for zero when the catalog has it, in any locale', () => {
      expect(createT(cat, 'en')(k('r'), { count: 0 })).toBe('No reports');
      expect(createT(cat, 'pl')(k('r'), { count: 0 })).toBe('No reports');
    });
    it('uses .other for zero when there is no .zero', () => {
      const t = createT({ 'r.one': '{count} report', 'r.other': '{count} reports' }, 'en');
      expect(t(k('r'), { count: 0 })).toBe('0 reports');
    });
    it('follows the locale rules (Polish has few and many) and falls back to .other for a category the catalog lacks', () => {
      const pl = {
        'r.one': '{count} zgłoszenie',
        'r.few': '{count} zgłoszenia',
        'r.many': '{count} zgłoszeń',
        'r.other': '{count} zgłoszenia (inne)',
      };
      const t = createT(pl, 'pl');
      expect(t(k('r'), { count: 1 })).toBe('1 zgłoszenie');
      expect(t(k('r'), { count: 3 })).toBe('3 zgłoszenia');
      expect(t(k('r'), { count: 12 })).toBe('12 zgłoszeń');
      expect(t(k('r'), { count: 1.5 })).toBe('1,5 zgłoszenia (inne)');
      const sparse = createT({ 'r.one': 'one', 'r.other': 'other {count}' }, 'pl');
      expect(sparse(k('r'), { count: 3 })).toBe('other 3');
    });
    it('uses the plain key when there are no plural forms, and the key when nothing matches', () => {
      expect(createT({ r: 'Reports' }, 'en')(k('r'), { count: 2 })).toBe('Reports');
      expect(createT({}, 'en')(k('r'), { count: 2 })).toBe('r');
    });
    it('a plural form wins over the plain key when there is a count', () => {
      const t = createT({ r: 'plain', 'r.other': 'many' }, 'en');
      expect(t(k('r'), { count: 5 })).toBe('many');
      expect(t(k('r'))).toBe('plain');
    });
    it('ignores a non-numeric count', () => {
      const t = createT({ 'r.one': 'one', 'r.other': 'other', r: 'plain' }, 'en');
      expect(t(k('r'), { count: 'x' })).toBe('plain');
    });
  });

  it('survives a locale the runtime does not know', () => {
    const t = createT({ a: 'x', 'p.one': '1', 'p.other': 'n' }, 'not a locale');
    expect(t(k('a'))).toBe('x');
    expect(t(k('p'), { count: 2 })).toBe('n');
  });
});

describe('the English catalog', () => {
  it('is the player catalog, not the hub one: no hub.* key', () => {
    expect(Object.keys(en).filter((k) => k.startsWith('hub.'))).toEqual([]);
  });
  const keys = Object.keys(en);
  it('is keyed player.* and has no empty text', () => {
    expect(keys.length).toBeGreaterThan(50);
    for (const key of keys) {
      expect(key, key).toMatch(/^player(\.[a-z][A-Za-z0-9_]*)+$/);
      expect(text(key), key).not.toBe('');
    }
  });
  it('gives every plural form both .one and .other', () => {
    const bases = new Set(keys.filter((x) => /\.(zero|one|two|few|many|other)$/.test(x)).map((x) => x.replace(/\.[a-z]+$/, '')));
    expect(bases.size).toBeGreaterThanOrEqual(2);
    for (const base of bases) {
      expect(keys, base).toContain(`${base}.one`);
      expect(keys, base).toContain(`${base}.other`);
    }
  });
  it('uses {count} in every .other form', () => {
    for (const key of keys.filter((x) => x.endsWith('.other'))) expect(text(key), key).toContain('{count}');
  });
  it('writes every placeholder as {name} with letters only', () => {
    for (const key of keys) {
      for (const m of text(key).matchAll(/\{([^}]*)\}/g)) expect(m[1], key).toMatch(/^[a-zA-Z]+$/);
    }
  });
  it('is plain: no marketing words, no em dash, no exclamation mark', () => {
    for (const key of keys) {
      expect(text(key), key).not.toMatch(/[—!]/);
      expect(text(key), key).not.toMatch(/\b(seamless|powerful|robust|blazing)\b/i);
    }
  });
});

// A patch release removes nothing from the public catalogue. `en` and `PlayerText` are exported, and a host that spreads `en` or
// names a key must keep compiling and showing the same words. Every key the 0.1.2 `en` had is listed here. The ones the one-step
// dialog no longer uses stay, marked @deprecated in src/i18n.ts, and go in a later minor.
const V012_KEYS = [
  'player.error.network', 'player.error.unauthorized', 'player.error.forbidden', 'player.error.notFound', 'player.error.rateLimited',
  'player.error.rateLimited.after.one', 'player.error.rateLimited.after.other', 'player.error.server', 'player.error.generic',
  'player.state.retry', 'player.notices.loadFailed',
  'player.notice.title.warning', 'player.notice.title.chat', 'player.notice.title.area', 'player.notice.title.ban',
  'player.notice.title.report_outcome', 'player.notice.title.fallback', 'player.notice.body.warning', 'player.notice.body.chat',
  'player.notice.body.area', 'player.notice.body.ban', 'player.notice.body.report_outcome', 'player.notice.body.fallback',
  'player.notice.position',
  'player.record.loadFailed', 'player.record.intro', 'player.record.empty', 'player.record.kind.warning', 'player.record.kind.chat',
  'player.record.kind.area', 'player.record.kind.ban', 'player.record.kind.fallback',
  'player.rules.title', 'player.rules.loading', 'player.rules.loadFailed', 'player.rules.empty',
  'player.restricted.moderator.until', 'player.restricted.moderator.noEnd', 'player.restricted.filter.until',
  'player.restricted.filter.noEnd', 'player.restricted.ended', 'player.restricted.ref',
  'player.report.title', 'player.report.titleNamed', 'player.report.intro', 'player.report.legend', 'player.report.titleOneTap',
  'player.report.titleOneTapNamed', 'player.report.titleOneTapPlayer', 'player.report.titleSent', 'player.report.titleRefused',
  'player.report.oneTap.intro', 'player.report.oneTap.send', 'player.report.quote', 'player.report.skip', 'player.report.needReason',
  'player.report.needReasonOrSkip', 'player.report.addReason', 'player.report.addReasonHint', 'player.report.detail.legend',
  'player.report.detail.send', 'player.report.detail.need', 'player.report.detail.added', 'player.report.detail.failed',
  'player.report.detail.refused.off', 'player.report.detail.refused.not_found', 'player.report.detail.refused.not_reporter',
  'player.report.detail.refused.too_late', 'player.report.detail.refused.already_added', 'player.report.detail.refused.reason_unknown',
  'player.report.note', 'player.report.noteHint', 'player.report.send', 'player.report.cancel', 'player.report.close',
  'player.report.failed', 'player.report.thanks', 'player.report.remaining.zero', 'player.report.remaining.one',
  'player.report.remaining.other', 'player.report.refused.duplicate', 'player.report.refused.rate', 'player.report.refused.self',
  'player.report.refused.not_player', 'player.report.refused.off', 'player.report.refused.suspended',
  'player.report.refused.reason_required', 'player.report.refused.reason_unknown', 'player.report.refused.unknown',
] as const;

// The keys 0.1.3 stops using: kept, with their 0.1.2 English, so a host that shows or overrides them keeps working.
const DEPRECATED_SINCE_013: Record<string, string> = {
  'player.report.title': 'Report a player',
  'player.report.titleNamed': 'Report {name}',
  'player.report.legend': 'What happened?',
  'player.report.skip': 'Skip and report',
  'player.report.needReasonOrSkip': 'Choose what happened, or skip.',
  'player.report.addReason': 'Add a reason',
  'player.report.addReasonHint': 'This helps, but the moderators decide what it really is. You can add this for a few minutes after you report.',
  'player.report.detail.legend': 'What was it about?',
  'player.report.detail.send': 'Add to my report',
  'player.report.detail.need': 'Choose a reason or write a note.',
  'player.report.detail.added': 'Added. Thanks.',
  'player.report.detail.failed': 'We could not add that.',
  'player.report.detail.refused.off': 'Adding to a report is not available right now.',
  'player.report.detail.refused.not_found': 'We cannot find that report any more.',
  'player.report.detail.refused.not_reporter': 'Only the player who sent a report can add to it.',
  'player.report.detail.refused.too_late': 'It is too late to add to this report. We still have the report.',
  'player.report.detail.refused.already_added': 'You already added to this report.',
  'player.report.detail.refused.reason_unknown': 'That reason is not available any more. Your report is still with us.',
  'player.report.send': 'Send report',
};

describe('the 0.1.2 catalogue stays whole in a patch release', () => {
  it('has every key the 0.1.2 en had', () => {
    const have = new Set(Object.keys(en));
    expect(V012_KEYS.filter((key) => !have.has(key))).toEqual([]);
  });
  it('lists the nineteen keys that went unused, and each is a 0.1.2 key', () => {
    expect(Object.keys(DEPRECATED_SINCE_013)).toHaveLength(19);
    for (const key of Object.keys(DEPRECATED_SINCE_013)) expect(V012_KEYS as readonly string[], key).toContain(key);
  });
  it('gives each deprecated key its old English text', () => {
    for (const [key, words] of Object.entries(DEPRECATED_SINCE_013)) expect(text(key), key).toBe(words);
  });
  it('keeps the old keys in the PlayerText type: a host that names one still compiles, and t() answers', () => {
    const named: PlayerText[] = ['player.report.title', 'player.report.titleNamed', 'player.report.send', 'player.report.detail.refused.too_late'];
    const t = createT(en, 'en');
    expect(named.map((key) => t(key, { name: 'Ann' }))).toEqual([
      'Report a player',
      'Report Ann',
      'Send report',
      'It is too late to add to this report. We still have the report.',
    ]);
  });
  // That each one carries the @deprecated mark is checked on the source in static.test.ts (this file runs in jsdom, with no file URLs).
});

describe('the pace words', () => {
  const REASONS = ['slow_mode', 'flood', 'duplicate'] as const;

  it('each reason has a sentence with the wait, and the wait carries its own "in" (no literal "in" before it)', () => {
    for (const reason of REASONS) {
      const words = text(`player.pace.${reason}`);
      expect(words, reason).toContain('{left}');
      expect(words, reason).not.toMatch(/\bin \{left\}/);
      expect(words, reason).toMatch(/^[A-Z]/);
      expect(words, reason).toMatch(/\.$/);
    }
    expect(text('player.pace.ready')).toMatch(/^[A-Z].*\.$/);
  });

  it('never shames and holds no id: plain second person, no accusation, no number but the wait', () => {
    for (const key of ['player.pace.slow_mode', 'player.pace.flood', 'player.pace.duplicate', 'player.pace.ready']) {
      const words = text(key);
      expect(words, key).not.toMatch(/spam|flood(ing)? the|abus|violat|offen|punish|ban\b|warn|moderator|rule|report|your (id|account|name)|cheat|stupid|annoy/i);
      expect(words, key).not.toMatch(/\d/);
      expect(words, key).toMatch(/\byou\b/i);
    }
  });

  it('fills {left}, and a translation that leaves one key out falls back to English for it', () => {
    const t = createT({ ...en, 'player.pace.flood': 'Zu schnell: {left}.' }, 'de');
    expect(t('player.pace.flood', { left: 'in 3 Sekunden' })).toBe('Zu schnell: in 3 Sekunden.');
    expect(t('player.pace.duplicate', { left: 'in 3 seconds' })).toBe('You already sent that. Say something different, or try again in 3 seconds.');
  });

  it('are in the English catalogue the main entry carries, not in the chat words', () => {
    for (const key of REASONS.map((r) => `player.pace.${r}`)) expect(Object.keys(en)).toContain(key);
  });
});

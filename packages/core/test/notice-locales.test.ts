import { describe, expect, it } from 'vitest';
import { NOTICE_WORDS, durationText, fillWords } from '../src/noticeCopy.js';
import { meta as metaEs } from '../src/noticeLocales.es.js';
import { meta as metaPt } from '../src/noticeLocales.pt.js';
import { APPEAL_WORDS, NOTICE_LOCALES, NOTICE_WORDS_ES, NOTICE_WORDS_PT, chooseLocale, noticeWordsFor } from '../src/noticeLocales.js';
import { APPEAL_REASONS } from '../src/appeals.js';

// The words of the appeal page and the delivery text, in English, Spanish and Portuguese, and the choice between them.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const placeholders = (text: string): string[] => [...text.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => m[1] as string).sort();
const ENGLISH: Record<string, string> = { ...NOTICE_WORDS, ...APPEAL_WORDS };

describe('the word sets', () => {
  it('the English set is NOTICE_WORDS plus APPEAL_WORDS with no key in both', () => {
    const notice = Object.keys(NOTICE_WORDS);
    const appeal = Object.keys(APPEAL_WORDS);
    expect(notice.filter((k) => appeal.includes(k))).toEqual([]);
    expect(notice).toHaveLength(39);
    expect(appeal).toHaveLength(50);
    expect(Object.keys(noticeWordsFor('en').words).sort()).toEqual([...notice, ...appeal].sort());
  });

  it('the key families and their counts', () => {
    const keys = Object.keys(APPEAL_WORDS);
    expect(keys.filter((k) => k.startsWith('player.appeal.reason.'))).toHaveLength(9);
    expect(keys.filter((k) => k.startsWith('player.appealPage.'))).toHaveLength(24);
    expect(keys.filter((k) => k.startsWith('delivery.'))).toHaveLength(17);
  });

  it('es and pt have exactly those keys, none missing, none extra', () => {
    const expected = Object.keys(ENGLISH).sort();
    expect(Object.keys(NOTICE_WORDS_ES).sort()).toEqual(expected);
    expect(Object.keys(NOTICE_WORDS_PT).sort()).toEqual(expected);
  });

  it('every {placeholder} of the English text appears in es and pt, and no other placeholder does', () => {
    for (const [name, catalogue] of [
      ['es', NOTICE_WORDS_ES],
      ['pt', NOTICE_WORDS_PT],
    ] as const) {
      for (const key of Object.keys(ENGLISH)) {
        expect(placeholders(catalogue[key as keyof typeof catalogue]), `${name} ${key}`).toEqual(placeholders(ENGLISH[key] as string));
      }
    }
  });

  it('the catalogues say what they are: a machine draft nobody has reviewed', () => {
    expect(metaEs).toEqual({ locale: 'es', status: 'machine-draft', reviewedBy: [], reviewedAt: null });
    expect(metaPt).toEqual({ locale: 'pt', status: 'machine-draft', reviewedBy: [], reviewedAt: null });
  });

  it('the shipped sets are frozen', () => {
    for (const set of [APPEAL_WORDS, NOTICE_WORDS_ES, NOTICE_WORDS_PT]) {
      expect(Object.isFrozen(set)).toBe(true);
      expect(() => {
        (set as Record<string, string>)['x'] = 'y';
      }).toThrow(TypeError);
    }
    expect(NOTICE_LOCALES).toEqual(['en', 'es', 'pt']);
  });

  it('the nine reason sentences in English are exactly the spec', () => {
    expect(
      Object.fromEntries(Object.entries(APPEAL_WORDS).filter(([k]) => k.startsWith('player.appeal.reason.'))),
    ).toEqual({
      'player.appeal.reason.upheld.rule_applies': 'The rule applies to what was said.',
      'player.appeal.reason.upheld.evidence_clear': 'The chat record shows the rule was broken.',
      'player.appeal.reason.upheld.context_considered': 'We looked at the whole conversation, and the decision stands.',
      'player.appeal.reason.reduced.first_offence': 'We lightened it because this was a first offence.',
      'player.appeal.reason.reduced.lighter_fits': 'A lighter action fits what happened.',
      'player.appeal.reason.reduced.context_considered': 'We looked at the whole conversation and lightened it.',
      'player.appeal.reason.revoked.mistake': 'This was our mistake. We are sorry.',
      'player.appeal.reason.revoked.not_a_violation': 'What was said does not break the rules.',
      'player.appeal.reason.revoked.context_considered': 'We looked at the whole conversation and lifted it.',
    });
  });

  it('every outcome and code the decision offers has a sentence in every language', () => {
    const stem = { uphold: 'upheld', reduce: 'reduced', revoke: 'revoked' } as const;
    for (const set of [ENGLISH, NOTICE_WORDS_ES, NOTICE_WORDS_PT] as Array<Record<string, string>>) {
      for (const outcome of ['uphold', 'reduce', 'revoke'] as const) {
        for (const code of APPEAL_REASONS[outcome]) expect(set[`player.appeal.reason.${stem[outcome]}.${code}`], `${outcome} ${code}`).toBeTruthy();
      }
    }
  });

  it('the page, the form and the delivery words are the spec text (spot checks of every family)', () => {
    expect(APPEAL_WORDS['player.appealPage.title']).toBe('Appeal a decision');
    expect(APPEAL_WORDS['player.appealPage.invalid']).toBe('This link is no longer valid.');
    expect(APPEAL_WORDS['player.appealPage.contact']).toBe('Need help? {contact}');
    expect(APPEAL_WORDS['player.appealPage.expires']).toBe('This link works until {when}.');
    expect(APPEAL_WORDS['player.appealPage.form.hint']).toBe('Up to {max} characters. A different moderator will review it, and the decision is final.');
    expect(APPEAL_WORDS['player.appealPage.form.count']).toBe('{count} of {max} characters');
    expect(APPEAL_WORDS['player.appealPage.sent.return']).toBe('Come back to this page to see the outcome.');
    expect(APPEAL_WORDS['player.appealPage.standing.none']).toBe('Nothing from this decision is on your record.');
    expect(APPEAL_WORDS['player.appealPage.refused.rate']).toBe('You have sent too many appeals this week. Try again {when}.');
    expect(APPEAL_WORDS['player.appealPage.refused.failed']).toBe('Something went wrong. Try again in a little while.');
    expect(APPEAL_WORDS['delivery.subject.chat.timed']).toBe('Your chat has been restricted for {length}');
    expect(APPEAL_WORDS['delivery.subject.ban.noEnd']).toBe('You have been banned');
    expect(APPEAL_WORDS['delivery.subject.appeal_reduced']).toBe('We reviewed your appeal: the decision was made lighter');
    expect(APPEAL_WORDS['delivery.times']).toBe('Times are in UTC.');
    expect(APPEAL_WORDS['delivery.footer']).toBe('You are receiving this message because of a moderation decision about your account.');
  });

  it('the notice words in es and pt are the ones player-react ships (the parity test holds them equal), and a few are really translated', () => {
    expect(NOTICE_WORDS_ES['player.notice.title.warning']).toBe('Tienes una advertencia');
    expect(NOTICE_WORDS_ES['player.appealPage.title']).not.toBe(APPEAL_WORDS['player.appealPage.title']);
    expect(NOTICE_WORDS_PT['player.appealPage.title']).not.toBe(APPEAL_WORDS['player.appealPage.title']);
    expect(NOTICE_WORDS_ES['delivery.footer']).not.toBe(APPEAL_WORDS['delivery.footer']);
  });

  it('no string in APPEAL_WORDS or the catalogues contains the bare words process or require; every value is clean text', () => {
    for (const [name, set] of [
      ['en', APPEAL_WORDS],
      ['es', NOTICE_WORDS_ES],
      ['pt', NOTICE_WORDS_PT],
    ] as const) {
      for (const [key, value] of Object.entries(set)) {
        expect(value, `${name} ${key}`).not.toMatch(/\b(process|require)\b/i);
        expect(value.length, `${name} ${key}`).toBeGreaterThan(0);
        // no control character, no leading or trailing space
        expect([...value].some((ch) => ch.charCodeAt(0) < 32 || (ch.charCodeAt(0) >= 127 && ch.charCodeAt(0) <= 159)), `${name} ${key}`).toBe(false);
        expect(value, `${name} ${key}`).toBe(value.trim());
        expect(key, `${name} ${key}`).not.toMatch(/\b(process|require)\b/i);
      }
    }
  });
});

describe('chooseLocale', () => {
  it('es-MX, pt_BR, ES and en-GB choose es, pt, es and en', () => {
    expect(chooseLocale(['es-MX'])).toBe('es');
    expect(chooseLocale(['pt_BR'])).toBe('pt');
    expect(chooseLocale(['ES'])).toBe('es');
    expect(chooseLocale(['en-GB'])).toBe('en');
    expect(chooseLocale(['pt-PT'])).toBe('pt');
  });

  it('an unknown language is English unless overrides hold it as an own key', () => {
    expect(chooseLocale(['de'])).toBe('en');
    expect(chooseLocale(['de-AT'])).toBe('en');
    expect(chooseLocale(['de'], { de: { k: 'v' } })).toBe('de');
    expect(chooseLocale(['de-AT'], { de: {} })).toBe('de');
    expect(chooseLocale(['de'], { fr: {} })).toBe('en');
    // an inherited key is not the game's own language
    expect(chooseLocale(['constructor'], {})).toBe('en');
    expect(chooseLocale(['tostring'], {})).toBe('en');
  });

  it('the first match in the list wins', () => {
    expect(chooseLocale(['de', 'pt-BR', 'es'])).toBe('pt');
    expect(chooseLocale(['fr', 'de', 'es-AR', 'pt'])).toBe('es');
    expect(chooseLocale(['de', 'fr'], { fr: {} })).toBe('fr');
    expect(chooseLocale(['en', 'es'])).toBe('en');
  });

  it('__proto__, 65 character, non-string and empty entries are skipped; an empty list is English', () => {
    expect(chooseLocale(['__proto__', 'es'])).toBe('es');
    expect(chooseLocale([`${'x'.repeat(62)}-ES`, 'pt'])).toBe('pt');
    expect(chooseLocale(['a'.repeat(65), 'pt'])).toBe('pt');
    expect(chooseLocale([5, null, undefined, {}, [], 'es'])).toBe('es');
    expect(chooseLocale(['', '  ', '-', '_', 'es'])).toBe('es');
    expect(chooseLocale([])).toBe('en');
    expect(chooseLocale(['__proto__'], { __proto__: { x: 1 } } as never)).toBe('en');
  });

  it('a 64 character entry is considered; letters only', () => {
    expect(chooseLocale([`es-${'x'.repeat(61)}`])).toBe('es');
    expect(chooseLocale(['e5'])).toBe('en');
    expect(chooseLocale(['es1'])).toBe('en');
    expect(chooseLocale(['eng'])).toBe('en');
    expect(chooseLocale(['espa'])).toBe('en');
  });

  it('never throws, whatever it is given', () => {
    for (const bad of [undefined, null, 5, 'es', {}, () => 1]) expect(chooseLocale(bad as never)).toBe('en');
    for (const o of [null, 5, 'x', []]) expect(chooseLocale(['de'], o as never)).toBe('en');
    const hostile = {
      toString: () => {
        throw new Error('boom');
      },
    };
    expect(chooseLocale([hostile])).toBe('en');
  });
});

describe('noticeWordsFor', () => {
  it('es text for a notice key and for an appeal key is the catalogue; en is the English set', () => {
    const es = noticeWordsFor('es');
    expect(es.locale).toBe('es');
    expect(es.words['player.notice.title.chat']).toBe(NOTICE_WORDS_ES['player.notice.title.chat']);
    expect(es.words['player.appealPage.title']).toBe(NOTICE_WORDS_ES['player.appealPage.title']);
    expect(es.words).toEqual({ ...NOTICE_WORDS_ES });
    expect(noticeWordsFor('pt-BR').words).toEqual({ ...NOTICE_WORDS_PT });
    expect(noticeWordsFor('en').words).toEqual(ENGLISH);
    expect(noticeWordsFor('xx').locale).toBe('en');
    expect(noticeWordsFor(undefined).locale).toBe('en');
    expect(noticeWordsFor(7).words).toEqual(ENGLISH);
  });

  it('an override replaces a known key and is ignored for an unknown key, an empty string, a number and __proto__', () => {
    const overrides = {
      es: {
        'player.appealPage.title': 'Apelar',
        'player.appealPage.invalid': '',
        'player.appealPage.loading': 5,
        'not.a.key': 'x',
        __proto__: 'x',
      },
    };
    const r = noticeWordsFor('es', overrides as never);
    expect(r.words['player.appealPage.title']).toBe('Apelar');
    expect(r.words['player.appealPage.invalid']).toBe(NOTICE_WORDS_ES['player.appealPage.invalid']);
    expect(r.words['player.appealPage.loading']).toBe(NOTICE_WORDS_ES['player.appealPage.loading']);
    expect(Object.hasOwn(r.words, 'not.a.key')).toBe(false);
    expect(Object.keys(r.words).sort()).toEqual(Object.keys(ENGLISH).sort());
    // a JSON-parsed table with an own __proto__ key
    const parsed = JSON.parse('{"es":{"__proto__":"x","player.appealPage.title":"Otra"}}') as never;
    const p = noticeWordsFor('es', parsed);
    expect(p.words['player.appealPage.title']).toBe('Otra');
    expect(Object.getPrototypeOf(p.words)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['x']).toBeUndefined();
  });

  it("an override of one language does not touch another's words", () => {
    const overrides = { es: { 'player.appealPage.title': 'Apelar' } };
    expect(noticeWordsFor('pt', overrides).words['player.appealPage.title']).toBe(NOTICE_WORDS_PT['player.appealPage.title']);
    expect(noticeWordsFor('en', overrides).words['player.appealPage.title']).toBe('Appeal a decision');
  });

  it('English can be overridden too (a game that words its own English)', () => {
    const r = noticeWordsFor('en', { en: { 'delivery.footer': 'Sent by Game Studio.' } });
    expect(r.words['delivery.footer']).toBe('Sent by Game Studio.');
    expect(r.locale).toBe('en');
  });

  it('the result is a fresh object each call: changing it changes nothing', () => {
    const a = noticeWordsFor('es');
    a.words['player.appealPage.title'] = 'changed';
    delete a.words['delivery.footer'];
    const b = noticeWordsFor('es');
    expect(b.words['player.appealPage.title']).toBe(NOTICE_WORDS_ES['player.appealPage.title']);
    expect(b.words['delivery.footer']).toBe(NOTICE_WORDS_ES['delivery.footer']);
    expect(b.words).not.toBe(a.words);
    expect(NOTICE_WORDS_ES['player.appealPage.title']).not.toBe('changed');
  });

  it('a language only in overrides (de) gives English plus the override and locale de', () => {
    const r = noticeWordsFor('de-CH', { de: { 'player.appealPage.title': 'Einspruch', 'player.appealPage.sent': '' } });
    expect(r.locale).toBe('de');
    expect(r.words['player.appealPage.title']).toBe('Einspruch');
    expect(r.words['player.appealPage.sent']).toBe(APPEAL_WORDS['player.appealPage.sent']);
    expect(r.words['player.notice.title.ban']).toBe(NOTICE_WORDS['player.notice.title.ban']);
    // without the override table de is English
    expect(noticeWordsFor('de').locale).toBe('en');
  });
});

describe('durationText', () => {
  it('under an hour is whole minutes rounded up, at least one', () => {
    expect(durationText(29_000, 'en')).toBe('1 minute');
    expect(durationText(1, 'en')).toBe('1 minute');
    expect(durationText(60_000, 'en')).toBe('1 minute');
    expect(durationText(60_001, 'en')).toBe('2 minutes');
    expect(durationText(30 * 60_000, 'en')).toBe('30 minutes');
    expect(durationText(HOUR - 1, 'en')).toBe('60 minutes');
  });

  it('an hour up to 72 hours is whole hours rounded up; past that whole days rounded up', () => {
    expect(durationText(HOUR, 'en')).toBe('1 hour');
    expect(durationText(61 * 60_000, 'en')).toBe('2 hours');
    expect(durationText(24 * HOUR, 'en')).toBe('24 hours');
    expect(durationText(72 * HOUR, 'en')).toBe('72 hours');
    expect(durationText(73 * HOUR, 'en')).toBe('4 days');
    expect(durationText(7 * DAY, 'en')).toBe('7 days');
    expect(durationText(7 * DAY + 1, 'en')).toBe('8 days');
    expect(durationText(100 * DAY, 'en')).toBe('100 days');
  });

  it('es and pt read in their own language', () => {
    expect(durationText(24 * HOUR, 'es')).toBe('24 horas');
    expect(durationText(7 * DAY, 'es')).toMatch(/^7 d.as$/);
    expect(durationText(24 * HOUR, 'pt-BR')).toBe('24 horas');
    expect(durationText(30 * 60_000, 'es')).toBe('30 minutos');
  });

  it('a bad locale falls back to English; NaN, 0, negatives and non-numbers read as 1 minute', () => {
    expect(durationText(24 * HOUR, 'not a locale')).toBe('24 hours');
    expect(durationText(24 * HOUR, '')).toBe('24 hours');
    expect(durationText(24 * HOUR, 5 as never)).toBe('24 hours');
    for (const ms of [Number.NaN, 0, -5, -HOUR, Infinity, -Infinity, '60000' as never, null as never, undefined as never]) {
      expect(durationText(ms, 'en'), String(ms)).toBe('1 minute');
    }
  });
});

describe('fillWords', () => {
  it('fills {name} values; a name with no value stays as written', () => {
    expect(fillWords('Up to {max} of {count}', { max: '1000', count: '5' })).toBe('Up to 1000 of 5');
    expect(fillWords('Hello {who}', {})).toBe('Hello {who}');
    expect(fillWords('{a}{a}', { a: 'x' })).toBe('xx');
    expect(fillWords('{constructor}', {})).toBe('{constructor}');
    expect(fillWords('no values', { a: 'b' })).toBe('no values');
  });
});

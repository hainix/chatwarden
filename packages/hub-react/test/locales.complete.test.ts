// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { aiEn } from '../src/ai/i18n.js';
import { createT, en } from '../src/i18n.js';
import { es, esAi, esPrivacy } from '../src/locales/es.js';
import { pt, ptAi, ptPrivacy } from '../src/locales/pt.js';
import { privacyEn } from '../src/privacy/i18n.js';
import { clean, deprecatedKeys, hasMarkup, pluralBases, problems } from './locales.helpers.js';

// Completeness is the checklist of a translation: run this file after each batch of keys and fix what it names. A string that is the same in
// English on purpose (a brand, a symbol, a unit) goes on ALLOW, for that locale, by pull request. Keys the source marks `@deprecated` are unused and
// may be left out.

const deprecated = deprecatedKeys(new URL('../src/i18n.ts', import.meta.url), new URL('../src/ai/i18n.ts', import.meta.url), new URL('../src/privacy/i18n.ts', import.meta.url));

const GROUPS = {
  core: { english: en as Record<string, string>, es: es as Record<string, string>, pt: pt as Record<string, string> },
  ai: { english: aiEn as Record<string, string>, es: esAi as Record<string, string>, pt: ptAi as Record<string, string> },
  privacy: { english: privacyEn as Record<string, string>, es: esPrivacy as Record<string, string>, pt: ptPrivacy as Record<string, string> },
} as const;

/**
 * Keys whose text is the same in English and in the language, on purpose: a key name or symbol, a pure format (`{name}`, `{count} of {max}`),
 * a loanword both languages use as it is (API, Chat, Spam, Clan, Normal), a word that is the same in the two. Add a key here by pull request.
 */
const SHARED = ['hub.key.enter', 'hub.key.ctrl', 'hub.key.cmd', 'hub.key.esc', 'hub.source.api', 'hub.category.spam', 'hub.community.share.category.sexual', 'hub.insights.chat', 'hub.rooms.mode.normal'];
const FORMAT = [
  'hub.shell.onNow.person',
  'hub.reports.row.earlierItem',
  'hub.person.named',
  'hub.person.signals.line',
  'hub.report.fact.tag',
  'hub.decide.choice.timed',
  'hub.decide.action.person.option',
  'hub.decide.result.code',
  'hub.settings.signals.dropped.item',
  'hub.preview.effect.for',
  'hub.settings.filters.problem',
];
const ALLOW: Record<'es' | 'pt', ReadonlySet<string>> = {
  es: new Set([...SHARED, ...FORMAT, 'hub.mode.simple', 'hub.case.entity.clan', 'hub.settings.reporting.evidence.chat']),
  pt: new Set([...SHARED, ...FORMAT, 'hub.shell.offline', 'hub.case.entity.item', 'hub.community.share.status', 'hub.settings.filters.links.title', 'hub.report.origin.links', 'hub.settings.ai.status.label', 'hub.settings.ai.gates.col.status', 'hub.settings.ai.gates.gate.volume', 'hub.settings.reporting.evidence.chat']),
};

describe.each(Object.entries(GROUPS))('hub catalogue: %s words', (_name, group) => {
  describe.each(['es', 'pt'] as const)('%s', (locale) => {
    const catalog = group[locale];
    const found = problems(group.english, catalog, { allow: ALLOW[locale], deprecated });

    it('complete: every key of English is here and none outside it', () => {
      expect(found.missing).toEqual([]);
      expect(found.extra).toEqual([]);
    });

    it('placeholders: the {name} set of each string equals the English one', () => {
      expect(found.placeholders).toEqual([]);
    });

    it('plural bases have .one and .other', () => {
      expect(found.plurals).toEqual([]);
    });

    it('no string is empty and none equals its English source unless it is on the allowlist', () => {
      expect(found.empty).toEqual([]);
      expect(found.identical).toEqual([]);
    });

    it('no markup, and the pattern characters of a string (| * ~) survive', () => {
      expect(found.markup).toEqual([]);
      expect(found.syntax).toEqual([]);
      for (const [k, v] of Object.entries(catalog)) expect(hasMarkup(v), k).toBe(false);
    });
  });
});

describe('the three groups together', () => {
  it('have no key in two groups, in English or in a translation', () => {
    const seen = new Map<string, string>();
    for (const [name, group] of Object.entries(GROUPS)) {
      for (const key of Object.keys(group.english)) {
        expect(seen.has(key), `${key} is in ${seen.get(key)} and ${name}`).toBe(false);
        seen.set(key, name);
      }
    }
  });

  it('the key counts are what the catalogues hold now (reported in the chunk report)', () => {
    const count = (c: Record<string, string>): number => Object.keys(c).length;
    const left = [...deprecated].filter((k) => Object.hasOwn(en, k)).length;
    expect(count(GROUPS.core.es)).toBe(count(GROUPS.core.english) - left);
    expect(count(GROUPS.core.pt)).toBe(count(GROUPS.core.english) - left);
    expect(count(GROUPS.ai.es)).toBe(count(GROUPS.ai.english));
    expect(count(GROUPS.privacy.pt)).toBe(count(GROUPS.privacy.english));
  });
});

describe('the checks fail on a bad catalogue (controls)', () => {
  const opts = { allow: new Set<string>(), deprecated: new Set<string>() };
  it('a missing key, an extra one, a changed placeholder, an English leftover, markup and a missing plural form are each named', () => {
    const english = { 'hub.a': 'Hello {name}', 'hub.n.one': '{count} case', 'hub.n.other': '{count} cases', 'hub.p': 'Write a|b' };
    const p = problems(english, { 'hub.a': 'Hola {who}', 'hub.n.one': '{count} caso', 'hub.p': 'Write a|b', 'hub.x': 'x' }, opts);
    expect(p.missing).toEqual(['hub.n.other']);
    expect(p.extra).toEqual(['hub.x']);
    expect(p.placeholders).toEqual(['hub.a']);
    expect(p.identical).toEqual(['hub.p']);
    expect(p.plurals).toEqual(['hub.n']);
    expect(clean(problems({ 'hub.a': 'Hi' }, { 'hub.a': '<b>Hola</b>' }, opts))).toBe(false);
  });
});

describe('dates, numbers and plurals follow the locale', () => {
  const english = { ...en } as Record<string, string>;
  it.each([
    ['es', es as Record<string, string>],
    ['pt', pt as Record<string, string>],
  ])('%s: a count picks the zero, one and other forms of the catalogue; the number is written for the locale', (locale, catalog) => {
    const t = createT({ ...english, ...catalog }, locale);
    expect(t('hub.simple.home.waiting', { count: 0 })).toBe(catalog['hub.simple.home.waiting.zero']);
    expect(t('hub.simple.home.waiting', { count: 1 })).toBe((catalog['hub.simple.home.waiting.one'] as string).replace('{count}', '1'));
    expect(t('hub.simple.home.waiting', { count: 12345 })).toBe((catalog['hub.simple.home.waiting.other'] as string).replace('{count}', new Intl.NumberFormat(locale).format(12345)));
    expect(t('hub.simple.home.waiting', { count: 12345 })).toContain('12.345');
  });

  it('every plural base in the catalogue is picked up by createT in both languages (one and other exist)', () => {
    for (const base of pluralBases(english)) {
      for (const catalog of [es, pt] as Array<Record<string, string>>) {
        if (deprecated.has(`${base}.one`)) continue;
        expect(Object.hasOwn(catalog, `${base}.one`), base).toBe(true);
        expect(Object.hasOwn(catalog, `${base}.other`), base).toBe(true);
      }
    }
  });
});

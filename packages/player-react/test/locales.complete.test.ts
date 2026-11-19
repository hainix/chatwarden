// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_REASONS, DEFAULT_REPORT_THANKS } from '@chatwarden/core';
import { enChat } from '../src/chat/words.js';
import { createT, en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { clean, deprecatedKeys, hasMarkup, placeholders, pluralBases, problems, syntaxMarks } from './locales.helpers.js';

// Completeness is the checklist of a translation. To add a language, copy the loops over `LOCALES`. A string that is the same in
// English on purpose (a name, a symbol) goes on ALLOW, for that locale, by pull request.

const english = { ...en, ...enChat } as Record<string, string>;
const deprecated = deprecatedKeys(new URL('../src/i18n.ts', import.meta.url));
const LOCALES = { es: es as Record<string, string>, pt: pt as Record<string, string> };

/** Keys whose text is the same in English and in the language, on purpose. */
const ALLOW: Record<string, ReadonlySet<string>> = {
  es: new Set(['player.chat.label', 'player.notice.untilLeft', 'player.report.quote', 'player.report.group.chat']),
  pt: new Set(['player.chat.label', 'player.notice.untilLeft', 'player.report.quote', 'player.report.group.chat']),
};

describe.each(Object.entries(LOCALES))('player catalogue %s', (locale, catalog) => {
  const found = problems(english, catalog, { allow: ALLOW[locale] as ReadonlySet<string>, deprecated });

  it('complete: every key of en and enChat is here, and no key outside them', () => {
    expect(found.missing).toEqual([]);
    expect(found.extra).toEqual([]);
  });

  it('has the report-reason labels and hints for every default reason, and the thank-you', () => {
    for (const r of DEFAULT_REPORT_REASONS) {
      expect(catalog[`player.report.reason.${r.id}.label`], r.id).toBeTypeOf('string');
      expect(catalog[`player.report.reason.${r.id}.hint`], r.id).toBeTypeOf('string');
    }
    expect(catalog['player.report.thanks']).toBeTypeOf('string');
  });

  it('placeholders: the {name} set of each string equals the English one', () => {
    expect(found.placeholders).toEqual([]);
  });

  it('plural bases have .one and .other', () => {
    expect(found.plurals).toEqual([]);
    for (const base of pluralBases(catalog)) {
      expect(catalog[`${base}.one`], base).toBeTypeOf('string');
      expect(catalog[`${base}.other`], base).toBeTypeOf('string');
    }
  });

  it('every plural form that English has carries the same placeholders as its English form', () => {
    for (const base of pluralBases(english)) {
      for (const form of ['one', 'other', 'zero']) {
        const key = `${base}.${form}`;
        if (Object.hasOwn(catalog, key) && Object.hasOwn(english, key)) expect(placeholders(catalog[key] as string), key).toEqual(placeholders(english[key] as string));
      }
    }
  });

  it('no string is empty and none equals its English source unless it is on the allowlist', () => {
    expect(found.empty).toEqual([]);
    expect(found.identical).toEqual([]);
  });

  it('no markup, and the pattern characters of a string survive', () => {
    expect(found.markup).toEqual([]);
    expect(found.syntax).toEqual([]);
    for (const [k, v] of Object.entries(catalog)) expect(hasMarkup(v), k).toBe(false);
  });

  it('has a label and a hint for each default reason and for no other id', () => {
    const ids = new Set(DEFAULT_REPORT_REASONS.map((r) => r.id as string));
    const own = Object.keys(catalog).filter((k) => k.startsWith('player.report.reason.'));
    expect(own.length).toBe(DEFAULT_REPORT_REASONS.length * 2);
    for (const k of own) expect(ids.has(k.split('.')[3] as string), k).toBe(true);
  });

  it('a sentence that ends with a full stop in English ends with one here too', () => {
    const lost: string[] = [];
    for (const [k, v] of Object.entries(catalog)) if ((english[k] as string).trim().endsWith('.') && !/[.]$/.test(v.trim())) lost.push(k);
    expect(lost).toEqual([]);
  });
});

describe('the checks fail on a bad catalogue (controls)', () => {
  const small = { 'a.b': 'Hello {name}', 'a.n.one': '{count} item', 'a.n.other': '{count} items', 'a.same': 'OK' };
  const opts = { allow: new Set<string>(), deprecated: new Set<string>() };

  it('a good one is clean', () => {
    expect(clean(problems(small, { 'a.b': 'Hola {name}', 'a.n.one': '{count} cosa', 'a.n.other': '{count} cosas', 'a.same': 'Listo' }, opts))).toBe(true);
  });
  it('a missing key, an extra key, a lost or renamed placeholder, an empty string, an English leftover, markup and a lost pipe are each named', () => {
    const p = problems(small, { 'a.b': 'Hola {nombre}', 'a.n.one': '', 'a.same': 'OK', 'a.x': 'x' }, opts);
    expect(p.missing).toEqual(['a.n.other']);
    expect(p.extra).toEqual(['a.x']);
    expect(p.placeholders).toEqual(['a.b', 'a.n.one']);
    expect(p.empty).toEqual(['a.n.one']);
    expect(p.identical).toEqual(['a.same']);
    expect(p.plurals).toEqual(['a.n']);
    expect(problems({ k: 'Write a|b' }, { k: 'Escribe a b' }, opts).syntax).toEqual(['k']);
    expect(problems({ k: 'Hi' }, { k: 'Hola <b>x</b>' }, opts).markup).toEqual(['k']);
  });
  it('the allowlist and the deprecated list let a key through', () => {
    const p = problems(small, { 'a.b': 'Hola {name}', 'a.n.one': '{count} cosa', 'a.n.other': '{count} cosas', 'a.same': 'OK' }, { allow: new Set(['a.same']), deprecated: new Set() });
    expect(clean(p)).toBe(true);
    expect(problems({ k: 'old' }, {}, { allow: new Set(), deprecated: new Set(['k']) }).missing).toEqual([]);
  });
  it('syntaxMarks reads | * ~ only', () => {
    expect(syntaxMarks('a|b, word*, ~')).toBe('|*~');
  });
});

describe('the English default keys', () => {
  it("the report-reason labels and hints equal core's DEFAULT_REPORT_REASONS, and the thank-you equals DEFAULT_REPORT_THANKS (drift guard)", () => {
    for (const r of DEFAULT_REPORT_REASONS) {
      expect((en as Record<string, string>)[`player.report.reason.${r.id}.label`], r.id).toBe(r.label);
      expect((en as Record<string, string>)[`player.report.reason.${r.id}.hint`], r.id).toBe(r.hint);
    }
    expect(en['player.report.thanks']).toBe(DEFAULT_REPORT_THANKS);
  });
});

describe('plurals: the report-remaining forms', () => {
  it.each(['es', 'pt'] as const)('%s: .one for 1, the zero text for 0, .other for 2 and 1000000 (the many category falls back to .other)', (locale) => {
    const catalog = LOCALES[locale];
    const t = createT({ ...english, ...catalog }, locale);
    expect(t('player.report.remaining', { count: 1 })).toBe((catalog['player.report.remaining.one'] as string).replace('{count}', '1'));
    expect(t('player.report.remaining', { count: 0 })).toBe(catalog['player.report.remaining.zero']);
    for (const n of [2, 1000000]) {
      const text = t('player.report.remaining', { count: n });
      expect(text, String(n)).toBe((catalog['player.report.remaining.other'] as string).replace('{count}', new Intl.NumberFormat(locale).format(n)));
    }
  });

  it('a count with no .zero form: es gives .other for 0, pt gives .one (Portuguese counts 0 as singular)', () => {
    for (const [locale, form] of [
      ['es', 'other'],
      ['pt', 'one'],
    ] as const) {
      const catalog = LOCALES[locale];
      const t = createT({ ...english, ...catalog }, locale);
      expect(t('player.chat.count', { count: 0 })).toBe((catalog[`player.chat.count.${form}`] as string).replace('{count}', '0'));
    }
  });
});

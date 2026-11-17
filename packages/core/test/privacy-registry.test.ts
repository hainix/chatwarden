import { describe, expect, it } from 'vitest';
import {
  ERASED_LINE,
  NO_PERSON_TABLES,
  PRIVACY_CATEGORIES,
  PRIVACY_REGISTRY,
  RETENTION_DEFAULTS,
  erasedReporter,
  isNonPersonReporter,
  isRestrictingKind,
} from '../src/index.js';

// The registry is the one place that says what each kind of stored row does for an export and for an erase (design section 5.1). It is also what
// `GET /privacy/statement` shows, so its words are checked here: plain, complete, and never a claim of compliance or legality.

describe('registry: every PRIVACY_CATEGORIES entry has an export and an erase rule for both modes', () => {
  it('has exactly one rule per category, in the category order', () => {
    expect(PRIVACY_REGISTRY.map((r) => r.category)).toEqual([...PRIVACY_CATEGORIES]);
    expect(new Set(PRIVACY_CATEGORIES).size).toBe(PRIVACY_CATEGORIES.length);
  });

  it.each(PRIVACY_REGISTRY.map((r) => [r.category, r] as const))('%s: a non-blank export, safety and none rule, in ASCII, ending in a full stop', (_name, rule) => {
    for (const text of [rule.export, rule.eraseSafety, rule.eraseNone]) {
      expect(text.trim().length).toBeGreaterThan(6);
      expect(text).toBe(text.trim());
      expect(text.endsWith('.')).toBe(true);
      expect(/^[\x20-\x7e]+$/.test(text), text).toBe(true);
    }
    expect(rule.tables.length).toBeGreaterThan(0);
    for (const t of rule.tables) expect(t).toMatch(/^kit_[a-z_]+$/);
  });

  it('the words never claim compliance, legality or advice', () => {
    const all = PRIVACY_REGISTRY.flatMap((r) => [r.export, r.eraseSafety, r.eraseNone]).join(' ').toLowerCase();
    for (const bad of ['complian', 'gdpr', 'legally', 'lawful', 'ccpa', 'guarantee']) expect(all, bad).not.toContain(bad);
  });

  it('a retention clock named by a rule is a real RetentionPolicy field', () => {
    for (const r of PRIVACY_REGISTRY) if (r.retention !== null) expect(Object.keys(RETENTION_DEFAULTS), r.category).toContain(r.retention);
  });

  it('the audit trail is kept in both modes and a hold is kept whole: the two rules that must not drift', () => {
    const rule = (c: string) => PRIVACY_REGISTRY.find((r) => r.category === c)!;
    expect(rule('audit').eraseSafety.toLowerCase()).toContain('kept');
    expect(rule('audit').eraseNone.toLowerCase()).toContain('kept');
    expect(rule('holds').eraseSafety.toLowerCase()).toContain('kept whole');
    expect(rule('holds').eraseNone.toLowerCase()).toContain('kept whole');
    expect(rule('identifiers').eraseSafety.toLowerCase()).toContain('sanction is in force');
    expect(rule('identifiers').eraseNone.toLowerCase()).toBe('deleted.');
  });
});

describe('tables: every table is claimed once by the registry or listed as holding no person', () => {
  it('no table is in both lists', () => {
    const claimed = new Set(PRIVACY_REGISTRY.flatMap((r) => r.tables));
    for (const t of Object.keys(NO_PERSON_TABLES)) expect(claimed.has(t), t).toBe(false);
  });

  it('every "holds no person" entry has a reason', () => {
    for (const [t, reason] of Object.entries(NO_PERSON_TABLES)) {
      expect(t).toMatch(/^kit_[a-z_]+$/);
      expect(reason.trim().length, t).toBeGreaterThan(10);
    }
  });

  it('names the tables this release added: filter counters, receipts, holds', () => {
    expect(NO_PERSON_TABLES['kit_filter_hits']).toBeDefined();
    expect(NO_PERSON_TABLES['kit_erasures']).toBeDefined();
    expect(PRIVACY_REGISTRY.find((r) => r.category === 'holds')?.tables).toEqual(['kit_legal_holds']);
    // kit_reports is claimed by three categories (filed, about, lines): origin and origin_key hold no person, and a filter report's reporter is `filter:<id>`
    expect(PRIVACY_REGISTRY.filter((r) => r.tables.includes('kit_reports')).map((r) => r.category)).toEqual(['reports_filed', 'reports_about', 'report_lines']);
  });
});

describe('markers and kinds', () => {
  it('a filter or erased reporter is never a person', () => {
    expect(isNonPersonReporter('filter:abc')).toBe(true);
    expect(isNonPersonReporter(erasedReporter('abc'))).toBe(true);
    expect(erasedReporter('abc')).toBe('erased:abc');
    expect(isNonPersonReporter('s_abc')).toBe(false);
    expect(isNonPersonReporter('')).toBe(false);
  });

  it('only chat, area and ban restrict; a warning and a note do not', () => {
    expect(['chat', 'area', 'ban'].every(isRestrictingKind)).toBe(true);
    expect(['warning', 'note', '', 'other'].some(isRestrictingKind)).toBe(false);
  });

  it('the line marker is plain text', () => {
    expect(ERASED_LINE).toBe('[erased]');
  });
});

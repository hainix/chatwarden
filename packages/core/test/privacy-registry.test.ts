import { describe, expect, it } from 'vitest';
import {
  ERASED_LINE,
  NO_PERSON_JSON_COLUMNS,
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

  it('the appeals rule claims the overturn table too, and says so in the export and in both erase rules (0.2.1)', () => {
    const rule = PRIVACY_REGISTRY.find((r) => r.category === 'appeals');
    expect(rule?.tables).toEqual(['kit_appeals', 'kit_overturns']);
    expect(rule?.export).toContain('overturned on appeal');
    expect(rule?.eraseSafety).toContain('overturn record');
    expect(rule?.eraseNone).toContain('overturn record');
    // the old words stay
    expect(rule?.eraseNone).toContain('held for legal reasons');
    expect(rule?.retention).toBe('appealsMs');
    // no other category claims the table
    expect(PRIVACY_REGISTRY.filter((r) => r.tables.includes('kit_overturns')).map((r) => r.category)).toEqual(['appeals']);
  });

  it('the words never claim compliance, legality or advice', () => {
    const all = PRIVACY_REGISTRY.flatMap((r) => [r.export, r.eraseSafety, r.eraseNone]).join(' ').toLowerCase();
    for (const bad of ['complian', 'gdpr', 'legally', 'lawful', 'ccpa', 'guarantee']) expect(all, bad).not.toContain(bad);
  });

  it('a retention clock named by a rule is a real RetentionPolicy field', () => {
    for (const r of PRIVACY_REGISTRY) if (r.retention !== null) expect(Object.keys(RETENTION_DEFAULTS), r.category).toContain(r.retention);
  });

  it('the welfare clock: the report categories name it, as a real RetentionPolicy field, and nothing else does', () => {
    const named = PRIVACY_REGISTRY.filter((r) => r.welfareClock !== undefined).map((r) => r.category);
    expect(named).toEqual(['reports_filed', 'reports_about', 'report_lines']);
    for (const r of PRIVACY_REGISTRY) {
      if (r.welfareClock === undefined) continue;
      expect(r.welfareClock, r.category).toBe('welfareReportsMs');
      expect(Object.keys(RETENTION_DEFAULTS), r.category).toContain(r.welfareClock);
      // It only means something beside the general reports clock.
      expect(r.retention, r.category).toBe('reportsMs');
    }
  });

  it('the words never call a hold a legal duty, and the holds export says only that something is held', () => {
    const rule = (c: string) => PRIVACY_REGISTRY.find((r) => r.category === c)!;
    const all = PRIVACY_REGISTRY.flatMap((r) => [r.export, r.eraseSafety, r.eraseNone]).join(' ').toLowerCase();
    expect(all).not.toContain('legal duty');
    expect(rule('holds').eraseSafety.toLowerCase()).toContain('does not weigh');
    expect(rule('holds').export.toLowerCase()).toContain('how many');
    for (const bad of ['code', 'reason:', 'law enforcement', 'time']) expect(rule('holds').export.toLowerCase(), bad).not.toContain(bad);
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

describe('JSON columns: a column that holds a person inside a JSON value is declared', () => {
  const declared = PRIVACY_REGISTRY.flatMap((r) => r.tables.length > 0 ? r.jsonColumns.map((c) => [r.category, c] as const) : []);

  it('every rule has a jsonColumns list; each entry is table.column_json of a table the rule claims', () => {
    for (const r of PRIVACY_REGISTRY) {
      expect(Array.isArray(r.jsonColumns), r.category).toBe(true);
      for (const c of r.jsonColumns) {
        expect(c, r.category).toMatch(/^kit_[a-z_]+\.[a-z_]+_json$/);
        expect(r.tables, `${r.category}: ${c}`).toContain(c.split('.')[0]);
      }
    }
  });

  it('names the columns that carry people: decisions of reports that stay, the people and lines of a report, the quoted lines of a notice, a webhook key answer, an AI example', () => {
    const names = declared.map(([, c]) => c);
    for (const c of ['kit_decisions.result_json', 'kit_reports.people_json', 'kit_reports.excerpt_json', 'kit_notices.excerpt_json', 'kit_webhook_keys.result_json', 'kit_ai_outcomes.example_json']) {
      expect(names, c).toContain(c);
    }
  });

  it('a JSON column is declared once, and never both declared and listed as holding no person', () => {
    const names = declared.map(([, c]) => c);
    expect(new Set(names).size).toBe(names.length);
    for (const c of Object.keys(NO_PERSON_JSON_COLUMNS)) expect(names, c).not.toContain(c);
  });

  it('every "holds no person" JSON column has a reason and a name of the form table.column_json', () => {
    for (const [c, reason] of Object.entries(NO_PERSON_JSON_COLUMNS)) {
      expect(c).toMatch(/^kit_[a-z_]+\.[a-z_]+_json$/);
      expect(reason.trim().length, c).toBeGreaterThan(10);
    }
  });

  it('kit_webhook_keys is claimed by a category (its answer names a sanction group), not listed as holding no person', () => {
    expect(NO_PERSON_TABLES['kit_webhook_keys']).toBeUndefined();
    expect(PRIVACY_REGISTRY.some((r) => r.tables.includes('kit_webhook_keys'))).toBe(true);
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

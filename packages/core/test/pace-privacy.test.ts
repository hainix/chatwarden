import { describe, expect, it } from 'vitest';
import { NO_PERSON_JSON_COLUMNS, NO_PERSON_TABLES, PRIVACY_CATEGORIES, PRIVACY_REGISTRY } from '../src/privacy.js';

// S3: the pacer's state is keyed by a person (`kit_pace.who`), so it is in the privacy registry: a category of its own, appended at the end of the list.

describe('the registry names the pace table', () => {
  it('pace is the last category, with kit_pace as its table, deleted by an erase in both modes, and no clock of its own', () => {
    expect(PRIVACY_CATEGORIES.at(-1)).toBe('pace');
    const rule = PRIVACY_REGISTRY.find((r) => r.category === 'pace');
    expect(rule?.tables).toEqual(['kit_pace']);
    expect(rule?.eraseSafety).toMatch(/Deleted/);
    expect(rule?.eraseNone).toMatch(/Deleted/);
    expect(rule?.retention).toBeNull();
    expect(rule?.export.length).toBeGreaterThan(10);
  });

  it('the table is claimed once: not also in the holds-no-person list', () => {
    expect(Object.keys(NO_PERSON_TABLES)).not.toContain('kit_pace');
  });

  it('its two JSON columns hold times and digests, never a person: declared as such with a reason', () => {
    for (const column of ['kit_pace.stamps_json', 'kit_pace.recent_json']) {
      expect(NO_PERSON_JSON_COLUMNS[column], column).toMatch(/\S{10,}/);
    }
    const declared = PRIVACY_REGISTRY.flatMap((r) => r.jsonColumns);
    expect(declared).not.toContain('kit_pace.stamps_json');
  });
});

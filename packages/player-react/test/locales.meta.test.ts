import { describe, expect, it } from 'vitest';
import { meta as esMeta } from '../src/locales/es.js';
import { meta as ptMeta } from '../src/locales/pt.js';
import { metaConsistent } from './locales.helpers.js';

// The drafts are machine-made and read by nobody. Changing `status` is a pull request with a reviewer's name, never a drafting task.

describe('meta', () => {
  it.each([
    ['es', esMeta],
    ['pt', ptMeta],
  ])("%s: status is 'machine-draft', reviewedBy is [], reviewedAt is null", (locale, meta) => {
    expect(meta).toEqual({ locale, status: 'machine-draft', reviewedBy: [], reviewedAt: null });
    expect(metaConsistent(meta)).toBe(true);
  });

  it('changing one field without the others fails the check', () => {
    const draft = { locale: 'es', status: 'machine-draft', reviewedBy: [] as string[], reviewedAt: null as string | null };
    expect(metaConsistent(draft)).toBe(true);
    expect(metaConsistent({ ...draft, status: 'checked' })).toBe(false);
    expect(metaConsistent({ ...draft, reviewedBy: ['Ana'] })).toBe(false);
    expect(metaConsistent({ ...draft, reviewedAt: '2026-12-01' })).toBe(false);
    expect(metaConsistent({ ...draft, status: 'checked', reviewedBy: ['Ana'] })).toBe(false);
    expect(metaConsistent({ ...draft, status: 'checked', reviewedAt: '2026-12-01' })).toBe(false);
    // Both given with another status is a real review.
    expect(metaConsistent({ ...draft, status: 'checked', reviewedBy: ['Ana'], reviewedAt: '2026-12-01' })).toBe(true);
  });
});

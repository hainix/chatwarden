import { describe, expect, it } from 'vitest';
import type { TermRow6 } from '@chatwarden/matcher/corpus';
import { diffTerms, renderDiff } from '../src/build/diff.js';

const row = (over: Partial<TermRow6> = {}): TermRow6 => ({
  id: 'CWT-2026-00001', term: 'zorbak', languages: ['en'], category: 'abuse', target: 'none', severity: 'hostile', status: 'accepted', defaultActive: true,
  collidesWith: [], since: '2026.11.0', approvals: 2, positive: ['zorbak'], negative: ['zorbakian'], ...over,
});

describe('diffTerms', () => {
  it('with no previous release every row is added; counts are by status', () => {
    const d = diffTerms(null, null, [row(), row({ id: 'CWT-2026-00002', term: 'vlemmo', status: 'provisional' })], []);
    expect(d).toMatchObject({ previous: null, total: 2, added: ['CWT-2026-00001', 'CWT-2026-00002'], changed: [], unchanged: 0, byStatus: { accepted: 1, provisional: 1, disputed: 0, withdrawn: 0 } });
  });

  it('names the fields that changed, and lines as `lines`; an unchanged row is only counted', () => {
    const before = [row(), row({ id: 'CWT-2026-00002', term: 'vlemmo' }), row({ id: 'CWT-2026-00003', term: 'quissel' })];
    const after = [row(), row({ id: 'CWT-2026-00002', term: 'vlemmo', status: 'disputed', collidesWith: ['es'] }), row({ id: 'CWT-2026-00003', term: 'quissel', negative: ['quisselx'] })];
    const d = diffTerms('2026.11.0', before, after, []);
    expect(d.unchanged).toBe(1);
    expect(d.changed).toEqual([
      { id: 'CWT-2026-00002', fields: ['status', 'collidesWith'] },
      { id: 'CWT-2026-00003', fields: ['lines'] },
    ]);
    expect(d.added).toEqual([]);
  });

  it('the since field alone is not a change', () => {
    expect(diffTerms('2026.11.0', [row({ since: '2026.10.0' })], [row({ since: '2026.11.0' })], []).unchanged).toBe(1);
  });
});

describe('the diff prints ids and counts only', () => {
  const d = diffTerms('2026.11.0', [row()], [row({ status: 'disputed' }), row({ id: 'CWT-2026-00002', term: 'vlemmo' })], [{ id: 'CWT-2026-00009', code: 'negative_blocked' }]);

  it('has no word, and no line, by default', () => {
    const text = renderDiff(d);
    expect(text).toContain('CWT-2026-00002');
    expect(text).toContain('CWT-2026-00001: status');
    expect(text).toContain('CWT-2026-00009: negative_blocked');
    expect(text).toContain('added: 1, changed: 1, unchanged: 0, held out by the gates: 1');
    expect(text).not.toMatch(/zorbak|vlemmo/);
  });

  it('prints the word beside the id only when asked', () => {
    const text = renderDiff(d, new Map([['CWT-2026-00002', 'vlemmo']]));
    expect(text).toContain('CWT-2026-00002 vlemmo');
    expect(text).not.toContain('zorbak');
  });

  it('says so for a first release', () => {
    expect(renderDiff(diffTerms(null, null, [], []))).toContain('the first release');
  });
});

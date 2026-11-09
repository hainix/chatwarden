import { describe, expect, it } from 'vitest';
import { isSqliteExperimental } from './filterWarnings.js';

describe('sqlite warning filter', () => {
  it('matches the SQLite ExperimentalWarning, as a type string or an Error', () => {
    expect(isSqliteExperimental('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')).toBe(true);
    const err = Object.assign(new Error('SQLite is an experimental feature'), { name: 'ExperimentalWarning' });
    expect(isSqliteExperimental(err)).toBe(true);
    expect(isSqliteExperimental('sqlite thing', { type: 'ExperimentalWarning' })).toBe(true);
  });

  it('does not match other experimental features or other warning types', () => {
    expect(isSqliteExperimental('Type stripping is an experimental feature', 'ExperimentalWarning')).toBe(false);
    expect(isSqliteExperimental('SQLite is deprecated', 'DeprecationWarning')).toBe(false);
    expect(isSqliteExperimental('SQLite', undefined)).toBe(false);
  });
});

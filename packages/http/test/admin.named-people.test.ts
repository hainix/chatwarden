import { describe, expect, it } from 'vitest';
import type { StaffReport } from '@chatwarden/core';
import { namedIn } from '../src/admin/apply.js';

// The ids a decision or a suggestion may name for a report: the people it shows, plus the ids it was filed under. A report nobody filed (a
// chat filter's flag) has a reporter value of the form `filter:<id>`, which is not a person and is never named.

const report = (over: Record<string, unknown> = {}): StaffReport =>
  ({
    targetPerson: 'pt',
    targetSubject: 'st',
    reporterPerson: 'pr',
    reporterSubject: 'sr',
    people: ['pt', 'pr', 'px'],
    ...over,
  }) as unknown as StaffReport;

describe('namedIn', () => {
  it('an ordinary report names its target, reporter and excerpt people and the ids it was filed under', () => {
    const named = namedIn(report());
    for (const id of ['pt', 'st', 'pr', 'sr', 'px']) expect(named.has(id), id).toBe(true);
    expect(named.has('other')).toBe(false);
  });

  it('a filter report does not name its reporter value', () => {
    const named = namedIn(report({ origin: 'filter', originKey: 'link.unlisted', reporterPerson: null, reporterSubject: 'filter:abc', people: ['pt', 'px'] }));
    expect(named.has('filter:abc')).toBe(false);
    for (const id of ['pt', 'st', 'px']) expect(named.has(id), id).toBe(true);
  });

  it('any origin is a system report: a watch report neither', () => {
    const named = namedIn(report({ origin: 'watch', reporterPerson: null, reporterSubject: 'watch:abc' }));
    expect(named.has('watch:abc')).toBe(false);
    expect(named.has('st')).toBe(true);
  });

  it('controls: an explicit null origin is an ordinary report', () => {
    expect(namedIn(report({ origin: null })).has('sr')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { actorInitial, actorName, holderOf, liveClaim, teamOf } from '../src/claims.js';
import type { QueueGroup } from '../src/queue.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

describe('liveClaim', () => {
  it('keeps a claim that has not lapsed and drops one that has', () => {
    const c = { by: 'ann@example.test', since: NOW - MIN, until: NOW + MIN };
    expect(liveClaim(c, NOW)).toBe(c);
    expect(liveClaim({ ...c, until: NOW + 1 }, NOW)).not.toBeNull();
  });

  it('a claim is live strictly before until (the kit: gone at until)', () => {
    expect(liveClaim({ by: 'a', since: 0, until: NOW }, NOW)).toBeNull();
    expect(liveClaim({ by: 'a', since: 0, until: NOW - 1 }, NOW)).toBeNull();
  });

  it('is null for null and undefined', () => {
    expect(liveClaim(null, NOW)).toBeNull();
    expect(liveClaim(undefined, NOW)).toBeNull();
  });
});

describe('holderOf', () => {
  const ann = 'ann@example.test';
  it('is none with no claim or a lapsed one', () => {
    expect(holderOf(null, ann, NOW)).toEqual({ kind: 'none' });
    expect(holderOf({ by: ann, since: 0, until: NOW - 1 }, ann, NOW)).toEqual({ kind: 'none' });
  });

  it('is you for your own live claim, other for a teammate', () => {
    expect(holderOf({ by: ann, since: 0, until: NOW + 1 }, ann, NOW)).toEqual({ kind: 'you', by: ann });
    expect(holderOf({ by: 'maya@example.test', since: 0, until: NOW + 1 }, ann, NOW)).toEqual({ kind: 'other', by: 'maya@example.test' });
  });

  it('compares whole actors, not prefixes', () => {
    expect(holderOf({ by: 'ann@example.test.evil', since: 0, until: NOW + 1 }, ann, NOW).kind).toBe('other');
    expect(holderOf({ by: 'Ann@example.test', since: 0, until: NOW + 1 }, ann, NOW).kind).toBe('other');
  });
});

describe('actorName and actorInitial', () => {
  it('shows an email as the part before the @', () => {
    expect(actorName('maya@example.test')).toBe('maya');
    expect(actorName('Rin.Okafor@studio.example')).toBe('Rin.Okafor');
  });

  it('leaves a plain name as it is, trimmed', () => {
    expect(actorName('Maya')).toBe('Maya');
    expect(actorName('  Maya  ')).toBe('Maya');
  });

  it('falls back to the whole actor when the local part is empty', () => {
    expect(actorName('@example.test')).toBe('@example.test');
    expect(actorName('')).toBe('');
  });

  it('takes the first letter, upper-cased, for the avatar', () => {
    expect(actorInitial('maya@example.test')).toBe('M');
    expect(actorInitial('Ana')).toBe('A');
    expect(actorInitial('élodie@example.test')).toBe('É');
  });

  it('takes a whole character, not half of one', () => {
    expect(actorInitial('𝔘ser@example.test')).toBe('𝔘');
  });

  it('is a question mark for nothing to show', () => {
    expect(actorInitial('')).toBe('?');
    expect(actorInitial('@x')).toBe('@');
  });
});

describe('teamOf', () => {
  const group = (person: string, over: Partial<QueueGroup> = {}): QueueGroup => ({
    person,
    handle: person,
    handles: [person],
    categories: ['harassment'],
    reports: 1,
    open: 1,
    actioned: 0,
    dismissed: 0,
    rooms: [],
    reporters: 1,
    reporterPersons: ['rep-1'],
    reporterHandles: {},
    firstAt: NOW - MIN,
    latestAt: NOW - MIN,
    oldestOpenAt: NOW - MIN,
    reportIds: [`r-${person}`],
    entries: [{ id: `r-${person}`, category: 'harassment', createdAt: NOW - MIN }],
    claim: null,
    viewing: [],
    ...over,
  });
  const live = (by: string) => ({ by, since: NOW - MIN, until: NOW + MIN });
  const ann = 'ann@example.test';

  it('lists you alone when nobody holds or views anything', () => {
    expect(teamOf([group('a'), group('b')], ann, NOW)).toEqual([{ actor: ann, you: true, handling: 0, viewing: 0 }]);
  });

  it('counts what each person holds and what each has open', () => {
    const groups = [
      group('a', { claim: live('maya@example.test'), viewing: [ann] }),
      group('b', { claim: live('maya@example.test') }),
      group('c', { claim: live(ann), viewing: ['maya@example.test', 'rin@example.test'] }),
      group('d', { viewing: ['rin@example.test'] }),
    ];
    expect(teamOf(groups, ann, NOW)).toEqual([
      { actor: ann, you: true, handling: 1, viewing: 1 },
      { actor: 'maya@example.test', you: false, handling: 2, viewing: 1 },
      { actor: 'rin@example.test', you: false, handling: 0, viewing: 2 },
    ]);
  });

  it('ignores a claim that has lapsed', () => {
    const lapsed = { by: 'maya@example.test', since: NOW - 20 * MIN, until: NOW - 10 * MIN };
    expect(teamOf([group('a', { claim: lapsed })], ann, NOW).map((m) => m.actor)).toEqual([ann]);
  });

  it('puts you first, then the busiest, then by name, and does not rank by speed', () => {
    const groups = [
      group('a', { claim: live('zed@example.test') }),
      group('b', { claim: live('amy@example.test') }),
      group('c', { claim: live('amy@example.test') }),
      group('d', { claim: live('bob@example.test') }),
    ];
    expect(teamOf(groups, ann, NOW).map((m) => m.actor)).toEqual([ann, 'amy@example.test', 'bob@example.test', 'zed@example.test']);
    expect(Object.keys(teamOf(groups, ann, NOW)[1] as object).sort()).toEqual(['actor', 'handling', 'viewing', 'you']);
  });

  it('counts you once when you both hold and view the same case', () => {
    const out = teamOf([group('a', { claim: live(ann), viewing: [ann] })], ann, NOW);
    expect(out).toEqual([{ actor: ann, you: true, handling: 1, viewing: 1 }]);
  });
});

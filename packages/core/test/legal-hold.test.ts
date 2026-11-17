import { describe, expect, it } from 'vitest';
import { createChatwarden } from '../src/chatwarden.js';
import { HOLD_CODES } from '../src/legal.js';
import type { KitEvent } from '../src/events.js';
import { MemoryStore } from '@chatwarden/store-memory';
import { DAY, NOW, P, legalWorld, seedFullReport, storedReport } from './legalWorld.js';
import { world } from './reportingWorld.js';

// `cw.legal.hold` and `release` (design section 6): a closed code, one hold per report, the event after the commit, and what a spy logger sees.

const OWNER = 'owner_ann';
const SENIOR = 'senior_gus';

describe('hold: a closed code only, one hold per report, release by anyone', () => {
  it('a senior-level actor string is accepted and every code on the closed list works', async () => {
    const w = await legalWorld();
    for (const [i, code] of HOLD_CODES.entries()) {
      seedFullReport(w, `r${i}`, NOW - DAY);
      expect(await w.cw.legal.hold(`r${i}`, { code, actor: SENIOR })).toEqual({ ok: true });
      expect(w.store.loadHold(`r${i}`)).toMatchObject({ code, heldBy: SENIOR, heldAt: NOW, releasedAt: null });
    }
  });

  it.each([
    ['free text', { code: 'because I said so' as never, actor: SENIOR }],
    ['an empty code', { code: '' as never, actor: SENIOR }],
    ['no code', { actor: SENIOR } as never],
    ['an actor with a space', { code: 'other' as const, actor: 'senior gus' }],
    ['an empty actor', { code: 'other' as const, actor: '' }],
    ['no actor', { code: 'other' as const } as never],
    ['a numeric actor', { code: 'other' as const, actor: 7 as never }],
  ])('%s is invalid and writes nothing', async (_name, input) => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    const seen: KitEvent[] = [];
    w.cw.on('report.escalated', (e) => void seen.push(e));
    expect(await w.cw.legal.hold('r1', input)).toEqual({ ok: false, error: 'invalid' });
    expect(w.store.loadHold('r1')).toBeNull();
    expect(seen).toEqual([]);
  });

  it('an unknown report is not_found, an empty id is invalid, and nothing is written for either', async () => {
    const w = await legalWorld();
    expect(await w.cw.legal.hold('nope', { code: 'other', actor: SENIOR })).toEqual({ ok: false, error: 'not_found' });
    expect(await w.cw.legal.hold('', { code: 'other', actor: SENIOR })).toEqual({ ok: false, error: 'invalid' });
    expect(w.store.listHolds()).toEqual([]);
  });

  it('a second hold is already_held and changes nothing: the first code, time and holder stay', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    await w.cw.legal.hold('r1', { code: 'legal_proceeding', actor: SENIOR });
    w.clock.t += 5000;
    expect(await w.cw.legal.hold('r1', { code: 'other', actor: 'senior_bea' })).toEqual({ ok: false, error: 'already_held' });
    expect(w.store.loadHold('r1')).toMatchObject({ code: 'legal_proceeding', heldBy: SENIOR, heldAt: NOW });
  });

  it('release by anyone clears it and writes the row; a release of a report that is not held says so', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    expect(await w.cw.legal.release('r1', { actor: OWNER })).toEqual({ ok: false });
    await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR });
    w.clock.t += 1000;
    expect(await w.cw.legal.release('r1', { actor: 'moderator_zed' })).toEqual({ ok: true });
    expect(w.store.loadHold('r1')).toMatchObject({ releasedBy: 'moderator_zed', releasedAt: NOW + 1000 });
    expect(await w.cw.legal.release('r1', { actor: OWNER })).toEqual({ ok: false });
    expect(await w.cw.legal.release('r1', { actor: 'has space' })).toEqual({ ok: false });
  });

  it('a released report can be held again', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR });
    await w.cw.legal.release('r1', { actor: OWNER });
    expect(await w.cw.legal.hold('r1', { code: 'safety_review', actor: SENIOR })).toEqual({ ok: true });
    expect(w.cw.legal.status('r1')?.code).toBe('safety_review');
  });

  it('status shows the code and the time and never who', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    expect(w.cw.legal.status('r1')).toBeNull();
    await w.cw.legal.hold('r1', { code: 'platform_request', actor: SENIOR });
    expect(w.cw.legal.status('r1')).toEqual({ code: 'platform_request', at: NOW });
    expect(w.cw.legal.status('nope')).toBeNull();
    await w.cw.legal.release('r1', { actor: OWNER });
    expect(w.cw.legal.status('r1')).toBeNull();
  });
});

describe('report.escalated: ids and a code only, once, after the commit', () => {
  it('is emitted once with the report, the time, the code and the person the report is about', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    const seen: KitEvent[] = [];
    w.cw.on('report.escalated', (e) => void seen.push(e));
    await w.cw.legal.hold('r1', { code: 'law_enforcement_request', actor: SENIOR });
    expect(seen).toEqual([{ type: 'report.escalated', reportId: 'r1', at: NOW, code: 'law_enforcement_request', target: P.tgt.id }]);
    expect(Object.keys(seen[0]!).sort()).toEqual(['at', 'code', 'reportId', 'target', 'type']);
    expect(Object.isFrozen(seen[0])).toBe(true);
  });

  it('is emitted after the hold is stored: a listener already finds the hold', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    let found: unknown = 'unset';
    w.cw.on('report.escalated', () => {
      found = w.store.loadHold('r1')?.code;
    });
    await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR });
    expect(found).toBe('other');
  });

  it('is never emitted for a refusal, a second hold or a release', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    const seen: KitEvent[] = [];
    w.cw.on('*', (e) => void seen.push(e));
    await w.cw.legal.hold('nope', { code: 'other', actor: SENIOR });
    await w.cw.legal.hold('r1', { code: 'bad' as never, actor: SENIOR });
    await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR });
    await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR });
    await w.cw.legal.release('r1', { actor: OWNER });
    expect(seen.map((e) => e.type)).toEqual(['report.escalated']);
  });

  it('names the canonical person: a report about a merged alias gives the surviving subject', async () => {
    const w = await legalWorld();
    // two keys, one account: the kit merges them into one person
    w.cw.rooms.seat('room-m', 'p1', { clientKey: 'key-a', accountId: 'acct-merge' }, 'A');
    w.cw.rooms.seat('room-m', 'p2', { clientKey: 'key-b', accountId: 'acct-merge' }, 'B');
    await w.cw.flush();
    const a = w.cw.rooms.subjectAt('room-m', 'p1') as string;
    const b = w.cw.rooms.subjectAt('room-m', 'p2') as string;
    const canonical = w.cw.people.canonical(a);
    expect(w.cw.people.canonical(b)).toBe(canonical);
    const alias = a === canonical ? b : a;
    w.store.insertReport({ ...storedReport('rm', NOW - DAY), targetSubject: alias });
    const seen: KitEvent[] = [];
    w.cw.on('report.escalated', (e) => void seen.push(e));
    await w.cw.legal.hold('rm', { code: 'other', actor: SENIOR });
    expect(seen[0]).toMatchObject({ target: canonical });
  });

  it('a failing listener (sync throw, async rejection) cannot fail the hold, and is logged by class only', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'r1', NOW - DAY);
    seedFullReport(w, 'r2', NOW - DAY);
    w.cw.on('report.escalated', () => {
      throw new Error('listener secret detail');
    });
    w.cw.on('report.escalated', () => Promise.reject(new TypeError('async secret detail')));
    expect(await w.cw.legal.hold('r1', { code: 'other', actor: SENIOR })).toEqual({ ok: true });
    expect(await w.cw.legal.hold('r2', { code: 'other', actor: SENIOR })).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(w.store.listHolds().length).toBe(2);
    const logged = w.logged.filter(([e]) => e === 'chatwarden.listener_failed');
    expect(logged.length).toBe(4);
    expect(JSON.stringify(w.logged)).not.toContain('secret detail');
    expect(logged.map(([, d]) => d)).toEqual(expect.arrayContaining([{ error: 'Error' }, { error: 'TypeError' }]));
  });

  it('a store failure on the hold rejects, writes no hold and emits nothing', async () => {
    class Failing extends MemoryStore {
      override placeHold(): never {
        throw new Error('disk full');
      }
    }
    const store = new Failing();
    store.insertReport(storedReport('r1', NOW - DAY));
    const w = await world({}, store);
    const seen: KitEvent[] = [];
    w.cw.on('report.escalated', (e) => void seen.push(e));
    await expect(w.cw.legal.hold('r1', { code: 'other', actor: SENIOR })).rejects.toThrow('disk full');
    expect(seen).toEqual([]);
  });
});

describe('a spy logger sees event names and error classes only', () => {
  it('nothing of a hold, a release, a refusal or a bundle reaches a log line: no report id, actor, code or secret', async () => {
    const secret = 'logged-secret-logged-secret-logged-secret';
    const w = await legalWorld({ bundleSecret: secret });
    seedFullReport(w, 'r-logged', NOW - DAY);
    await w.cw.legal.hold('r-logged', { code: 'law_enforcement_request', actor: SENIOR });
    await w.cw.legal.hold('r-logged', { code: 'other', actor: SENIOR });
    await w.cw.legal.hold('r-nope', { code: 'other', actor: SENIOR });
    await w.cw.legal.bundle('r-logged', { actor: OWNER });
    await w.cw.legal.release('r-logged', { actor: OWNER });
    const text = JSON.stringify(w.logged);
    for (const bad of ['r-logged', 'r-nope', SENIOR, OWNER, 'law_enforcement_request', secret, P.tgt.id, P.tgt.handle]) expect(text, bad).not.toContain(bad);
  });
});

describe('bundleSecret: at least 32 characters, never logged, never echoed', () => {
  const make = (bundleSecret: unknown) =>
    createChatwarden({ store: new MemoryStore(), secret: 'x', platform: { identify: () => ({}) }, retention: false, bundleSecret: bundleSecret as string });

  it('a shorter secret throws at creation naming bundleSecret and never the value', async () => {
    for (const bad of ['short-bundle-value', 'x'.repeat(31), '', 5, {}]) {
      let message = '';
      try {
        await make(bad);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message, String(bad)).toContain('bundleSecret');
      if (typeof bad === 'string' && bad !== '') expect(message).not.toContain(bad);
    }
  });

  it('32 characters and an absent option are accepted', async () => {
    await expect(make('x'.repeat(32))).resolves.toBeDefined();
    await expect(make(undefined)).resolves.toBeDefined();
  });
});

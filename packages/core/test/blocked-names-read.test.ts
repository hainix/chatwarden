import { describe, expect, it } from 'vitest';
import { MemoryStore, withMemoryNames } from '@chatwarden/store-memory';
import type { Matcher, ProfanityFilter, RawWho, SubjectId } from '../src/types.js';
import { DAY, NOW, world } from './reportingWorld.js';

// cw.blocked.names: the kept blocked names (names.keepBlocked), newest first, for the staff screen. The text is the name as it was typed;
// `person` is the canonical staff ref or null; the window is 1, 7 or 30 days, like the blocked chat lines.

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const filter: ProfanityFilter = { apply: (text) => ({ hit: /snerp/i.test(text), text }) };

async function kit(names: Record<string, unknown> = { keepBlocked: true, profanity: true }, store = withMemoryNames(new MemoryStore())) {
  const w = await world({ matcher, profanity: filter, overrides: { names }, platform: { identify: (ctx: unknown) => ctx as RawWho } } as never, store);
  return w;
}

describe('blocked.names', () => {
  it('lists the kept names newest first with the reason, the term id and the person, and nothing else', async () => {
    const w = await kit();
    w.cw.rooms.seat('room', 'p1', { clientKey: 'k-known' }, 'Known');
    await w.cw.flush();
    const person = w.cw.rooms.subjectAt('room', 'p1') as SubjectId;
    w.cw.names.check('Zorbak_99', { who: { clientKey: 'k-known' } });
    w.clock.t += 1000;
    w.cw.names.check('big_snerp', { who: { clientKey: 'k-known' } });
    w.clock.t += 1000;
    w.cw.names.check('zorbak');
    w.cw.names.check('Fine Name');
    const items = w.cw.blocked.names({ days: 7 });
    expect(items).toEqual([
      { id: expect.any(String), at: NOW + 2000, person: null, name: 'zorbak', termId: 'syn:zorbak', reason: 'name_not_allowed' },
      { id: expect.any(String), at: NOW + 1000, person, name: 'big_snerp', termId: null, reason: 'name_profane' },
      { id: expect.any(String), at: NOW, person, name: 'Zorbak_99', termId: 'syn:zorbak', reason: 'name_not_allowed' },
    ]);
  });

  it('is empty when nothing was kept: keepBlocked off, an allowed name, a store with no names methods', async () => {
    const off = await kit({ profanity: true });
    off.cw.names.check('zorbak');
    expect(off.cw.blocked.names({ days: 30 })).toEqual([]);
    const plain = await world({ matcher, overrides: { names: { keepBlocked: true } } } as never, new MemoryStore());
    plain.cw.names.check('zorbak');
    expect(plain.cw.blocked.names({ days: 30 })).toEqual([]);
  });

  it('the window is 1, 7 or 30 days, counted back from now; any other value is a RangeError', async () => {
    const w = await kit();
    w.cw.names.check('zorbak_old');
    w.clock.t += 8 * DAY;
    w.cw.names.check('zorbak_new');
    expect(w.cw.blocked.names({ days: 1 }).map((r) => r.name)).toEqual(['zorbak_new']);
    expect(w.cw.blocked.names({ days: 7 }).map((r) => r.name)).toEqual(['zorbak_new']);
    expect(w.cw.blocked.names({ days: 30 }).map((r) => r.name)).toEqual(['zorbak_new', 'zorbak_old']);
    for (const days of [0, 2, 31, -1, '7', null, undefined]) expect(() => w.cw.blocked.names({ days: days as never }), String(days)).toThrow(RangeError);
  });

  it('is at most 200 rows (what the store returns in one read)', async () => {
    const w = await kit();
    for (let i = 0; i < 520; i++) {
      w.clock.t += 1000;
      // each name is its own "person" (no who), so the per-person cap does not apply; the overall cap (200 an hour) does: spread over hours
      if (i % 150 === 0) w.clock.t += 3_600_001;
      w.cw.names.check(`zorbak_${i}`);
    }
    expect(w.cw.blocked.names({ days: 30 })).toHaveLength(200);
  });
});

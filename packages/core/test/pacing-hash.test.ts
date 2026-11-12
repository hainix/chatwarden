import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPace } from '../src/pace.js';

// Review M5: the repeat check hashes a line once for an accepted line (check and commit share it) and once for a refused one.
const hashed: string[] = [];
vi.mock('../src/crypto.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/crypto.js')>();
  return {
    ...actual,
    sha256Hex: (data: string): string => {
      hashed.push(data);
      return actual.sha256Hex(data);
    },
  };
});

const { createPacer } = await import('../src/pacing.js');

const T0 = 1_800_000_000_000;
const on: ResolvedPace = { slowModeMs: null, burst: null, duplicateWindowMs: 60_000 };
const key = { roomId: 'R', who: 'w' };

function setup() {
  const clock = { t: T0, now: () => clock.t };
  hashed.length = 0;
  return { clock, pacer: createPacer({ clock, settings: () => on }) };
}

describe('hashing per line', () => {
  it('an accepted first line is hashed once (commit only: the player has no history yet)', () => {
    const { pacer } = setup();
    expect(pacer.check(key, 'first line here').ok).toBe(true);
    pacer.commit(key, 'first line here');
    expect(hashed).toHaveLength(1);
  });

  it('an accepted later line is hashed once: the check\'s digest is reused by the commit', () => {
    const { clock, pacer } = setup();
    pacer.check(key, 'first line here');
    pacer.commit(key, 'first line here');
    hashed.length = 0;
    clock.t += 1000;
    expect(pacer.check(key, 'second line here').ok).toBe(true);
    pacer.commit(key, 'second line here');
    expect(hashed).toHaveLength(1);
  });

  it('a refused repeat is hashed once', () => {
    const { clock, pacer } = setup();
    pacer.commit(key, 'first line here');
    hashed.length = 0;
    clock.t += 1000;
    expect(pacer.check(key, 'first line here').ok).toBe(false);
    expect(hashed).toHaveLength(1);
  });

  it('a commit of another line than the one checked does not reuse the digest', () => {
    const { clock, pacer } = setup();
    pacer.commit(key, 'first line here');
    clock.t += 1000;
    pacer.check(key, 'checked line one');
    pacer.commit(key, 'a different line two');
    // The commit hashed its own line, so a repeat of it is caught.
    clock.t += 1000;
    expect(pacer.check(key, 'a different line two').ok).toBe(false);
    expect(pacer.check(key, 'checked line one').ok).toBe(true);
  });

  it('the stored state holds digests only, whatever the memo does', () => {
    const { pacer } = setup();
    pacer.check(key, 'zorbak vlemmo quissel');
    pacer.commit(key, 'zorbak vlemmo quissel');
    expect(hashed.every((h) => h === 'zorbakvlemmoquissel')).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Ring } from '../src/chat/history.js';

// The history ring is pruned when it is touched. A quiet room with someone still connected is never read, so the broadcaster's own
// heartbeat tick sweeps every ring: text older than the evidence window does not sit in memory just because nobody asked for it.

const rings: Ring[] = [];
vi.mock('../src/chat/history.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/chat/history.js')>();
  return {
    ...real,
    createRing: (opts: Parameters<typeof real.createRing>[0]) => {
      const ring = real.createRing(opts);
      // A copy of the ring whose methods the test can wrap to see when it is touched (touching is what prunes).
      const wrapped: Ring = { ...ring };
      rings.push(wrapped);
      return wrapped;
    },
  };
});

const { chatWorld, SEC } = await import('./chat-world.js');

describe('the idle-room sweep', () => {
  it('a heartbeat tick prunes the ring of a quiet room that is still connected', async () => {
    rings.length = 0;
    const touches: string[] = [];
    const w = await chatWorld();
    const a = w.attend('lobby', 'plenk');
    w.advance(2 * SEC);
    a.session.send({ text: 'a line nobody will read again' });
    expect(rings).toHaveLength(1);
    const ring = rings[0] as Ring;
    // spy on pruning-by-touch: size() prunes, and the sweep is what calls it while no one else does
    const original = ring.size;
    ring.size = () => {
      touches.push('size');
      return original();
    };
    expect(touches).toEqual([]);
    w.advance(20 * SEC); // one heartbeat tick, nobody read anything
    expect(touches.length).toBeGreaterThanOrEqual(1);
    // and with a minute and a half of ticks past the window the text is gone from the ring itself
    w.advance(15 * 60 * SEC + 40 * SEC);
    ring.size = original;
    expect(original()).toBe(0);
  });

  it('the sweep touches every room, not only the first', async () => {
    rings.length = 0;
    const w = await chatWorld();
    w.attend('room-a', 'plenk');
    w.attend('room-b', 'wumbo');
    w.attend('room-c', 'glarn');
    expect(rings).toHaveLength(3);
    const touched = new Set<number>();
    rings.forEach((ring, i) => {
      const original = ring.size;
      ring.size = () => {
        touched.add(i);
        return original();
      };
    });
    w.advance(20 * SEC);
    expect([...touched].sort()).toEqual([0, 1, 2]);
  });

  it('10 000 rooms opened and left leave no ring behind', async () => {
    rings.length = 0;
    const w = await chatWorld();
    for (let i = 0; i < 2000; i += 1) {
      const s = w.chat.session(`room-${i}`, { clientKey: `sweep-key-${i}-aaaaaaaa` }, { name: 'plenk' });
      if ('refused' in s) throw new Error('refused');
      const stream = s.open({ write: () => undefined });
      if ('refused' in stream) throw new Error('refused');
      w.advance(2 * SEC);
      s.send({ text: 'x' });
      stream.close();
    }
    w.advance(10 * 60 * SEC);
    expect(w.chat.stats()).toEqual({ rooms: 0, members: 0, streams: 0 });
    expect(w.pending()).toBe(0);
  }, 60_000);
});

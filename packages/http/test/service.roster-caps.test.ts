import { describe, expect, it } from 'vitest';
import { SERVICE_MAX_ROOMS, SERVICE_MAX_SEATS_PER_ROOM } from '../src/service/routes.js';
import { bodyOf, errorCode } from './serviceKit.js';
import { SEC, serviceWorld } from './serviceWorld.js';

// I-2: the service keeps a bounded tally of the rooms and seats it seated: seats per room and rooms per process are capped; a room over the cap evicts the room idle the longest (closing it in the kit);
// hiddenFor comes from the kit's own roster, so a room of thousands of seats costs the muters, not the seats.

const seatTwo = async (w: Awaited<ReturnType<typeof serviceWorld>>, room: string): Promise<void> => {
  await w.seat(room, 'a', `${room}-ann`);
  await w.seat(room, 'b', `${room}-bob`);
};
const subjectAt = (w: Awaited<ReturnType<typeof serviceWorld>>, room: string, seat: string): string | null => w.real.rooms.subjectAt(room, seat);

describe('defaults', () => {
  it('5000 seats a room and 10000 rooms a process', () => {
    expect(SERVICE_MAX_SEATS_PER_ROOM).toBe(5000);
    expect(SERVICE_MAX_ROOMS).toBe(10_000);
  });

  it('the limits are validated at start-up: whole numbers of 1 or more', async () => {
    for (const bad of [{ maxSeatsPerRoom: 0 }, { maxSeatsPerRoom: 1.5 }, { maxRooms: 0 }, { maxRooms: -1 }, { maxRooms: '5' }, null, 5]) {
      await expect(serviceWorld({ service: { limits: bad as never } }), JSON.stringify(bad)).rejects.toThrow(RangeError);
    }
    await expect(serviceWorld({ service: { limits: { maxSeatsPerRoom: 1, maxRooms: 1 } } })).resolves.toBeDefined();
    await expect(serviceWorld({ service: { limits: {} } })).resolves.toBeDefined();
  });
});

describe('seats per room', () => {
  it('the seat past the cap is refused (400 invalid_value) and never reaches the kit; a seat already held may change hands; other rooms are unaffected', async () => {
    const w = await serviceWorld({ service: { limits: { maxSeatsPerRoom: 3 } } });
    for (const s of ['a', 'b', 'c']) expect((await w.seat('r1', s, `n-${s}`)).status).toBe(200);
    const over = await w.seat('r1', 'd', 'n-d');
    expect(over.status).toBe(400);
    expect(errorCode(over)).toBe('invalid_value');
    expect(subjectAt(w, 'r1', 'd')).toBeNull();
    // the seat changed hands: not a new seat
    expect((await w.seat('r1', 'a', 'n-other')).status).toBe(200);
    expect((await w.seat('r2', 'd', 'n-d')).status).toBe(200);
    // leaving frees a place
    await w.call('DELETE', '/rooms/r1/seats/b');
    expect((await w.seat('r1', 'd', 'n-d')).status).toBe(200);
    expect((await w.seat('r1', 'e', 'n-e')).status).toBe(400);
  });

  it('closing the room frees the whole room', async () => {
    const w = await serviceWorld({ service: { limits: { maxSeatsPerRoom: 2 } } });
    await seatTwo(w, 'r1');
    expect((await w.seat('r1', 'c', 'n-c')).status).toBe(400);
    await w.call('DELETE', '/rooms/r1');
    expect((await w.seat('r1', 'c', 'n-c')).status).toBe(200);
    expect((await w.seat('r1', 'd', 'n-d')).status).toBe(200);
    expect((await w.seat('r1', 'e', 'n-e')).status).toBe(400);
  });

  it('a refused seat leaves no trace in the answer: the same fixed error body, no seat id or room echoed', async () => {
    const w = await serviceWorld({ service: { limits: { maxSeatsPerRoom: 1 } } });
    await w.seat('roomsecret', 'a', 'n-a');
    const over = await w.seat('roomsecret', 'seatsecret', 'n-b');
    expect(JSON.stringify(over.body)).not.toContain('roomsecret');
    expect(JSON.stringify(over.body)).not.toContain('seatsecret');
  });
});

describe('rooms per process', () => {
  it('a new room over the cap closes the room idle the longest; the others keep their seats; a line in a room keeps it fresh', async () => {
    const w = await serviceWorld({ service: { limits: { maxRooms: 3 } } });
    for (const r of ['r1', 'r2', 'r3']) await seatTwo(w, r);
    w.advance(2 * SEC);
    // r1 is used again, so r2 is now the oldest
    expect((await w.line('r1', 'a', 'hello there')).status).toBe(200);
    await seatTwo(w, 'r4');
    expect(subjectAt(w, 'r2', 'a')).toBeNull();
    expect(subjectAt(w, 'r2', 'b')).toBeNull();
    for (const r of ['r1', 'r3', 'r4']) expect(subjectAt(w, r, 'a'), r).not.toBeNull();
    // the evicted room answers like a closed one: a line is a refusal, not a crash
    const late = await w.line('r2', 'a', 'anyone there');
    expect(late.status).toBe(200);
    expect(bodyOf(late).ok).toBe(false);
    // seating into the evicted room opens it again and evicts the next oldest (r3)
    await w.seat('r2', 'a', 'again');
    expect(subjectAt(w, 'r2', 'a')).not.toBeNull();
    expect(subjectAt(w, 'r3', 'a')).toBeNull();
    for (const r of ['r1', 'r4']) expect(subjectAt(w, r, 'a'), r).not.toBeNull();
  });

  it('seating into a room that is already held never evicts; neither does an unseat', async () => {
    const w = await serviceWorld({ service: { limits: { maxRooms: 2 } } });
    await seatTwo(w, 'r1');
    await seatTwo(w, 'r2');
    await w.seat('r1', 'c', 'n-c');
    await w.call('DELETE', '/rooms/r2/seats/a');
    await w.call('DELETE', '/rooms/r2/seats/zz');
    expect(subjectAt(w, 'r1', 'a')).not.toBeNull();
    expect(subjectAt(w, 'r2', 'b')).not.toBeNull();
  });

  it('a room emptied seat by seat is still counted (the kit keeps its tags) until it is closed or evicted', async () => {
    const w = await serviceWorld({ service: { limits: { maxRooms: 2 } } });
    await w.seat('r1', 'a', 'n-a', { tags: { context: 'unknown' } });
    await w.call('DELETE', '/rooms/r1/seats/a');
    await seatTwo(w, 'r2');
    await seatTwo(w, 'r3');
    // r1 (empty, oldest) went first
    expect(w.real.rooms.list().map((r) => r.roomId)).not.toContain('r1');
  });

  it('closing a room frees its place: the next new room evicts nobody', async () => {
    const w = await serviceWorld({ service: { limits: { maxRooms: 2 } } });
    await seatTwo(w, 'r1');
    await seatTwo(w, 'r2');
    await w.call('DELETE', '/rooms/r1');
    await seatTwo(w, 'r3');
    expect(subjectAt(w, 'r2', 'a')).not.toBeNull();
    expect(subjectAt(w, 'r3', 'a')).not.toBeNull();
  });

  it('an eviction is logged by class only: the event, never a room or seat id', async () => {
    const w = await serviceWorld({ service: { limits: { maxRooms: 1 } } });
    await seatTwo(w, 'room-one-secret');
    await seatTwo(w, 'room-two-secret');
    const evicted = w.logs.filter(([event]) => event === 'chatwarden.service_room_evicted');
    expect(evicted).toHaveLength(1);
    expect(JSON.stringify(w.logs)).not.toContain('room-one-secret');
    expect(JSON.stringify(w.logs)).not.toContain('room-two-secret');
  });

  it('with the default cap the 10 001st room evicts the one idle longest', async () => {
    const w = await serviceWorld();
    for (let i = 0; i <= SERVICE_MAX_ROOMS; i++) {
      const res = await w.seat(`room${i}`, 'a', 'n');
      if (res.status !== 200) throw new Error(`seat ${i} refused: ${res.status}`);
    }
    expect(subjectAt(w, 'room0', 'a')).toBeNull();
    expect(subjectAt(w, 'room1', 'a')).not.toBeNull();
    expect(subjectAt(w, `room${SERVICE_MAX_ROOMS}`, 'a')).not.toBeNull();
  }, 60_000);
});

describe('hiddenFor at scale and across the service', () => {
  it('a room of 5000 seats and 3 muters: every line lists the muters and 100 lines stay inside a generous budget', async () => {
    const w = await serviceWorld();
    await w.seat('big', 'sender', 'sender');
    for (const m of ['m0', 'm1', 'm2']) {
      await w.seat('big', m, `muter-${m}`);
      await w.call('PUT', `/rooms/big/seats/${m}/mutes/sender`);
    }
    // the crowd is seated straight in the kit (as a game that also uses the kit directly would)
    for (let i = 0; i < 5000; i++) w.real.rooms.seat('big', `crowd${i}`, { clientKey: `raw-client-key-crowd-${i}-0001` }, `crowd${i}`);
    const t0 = performance.now();
    let last: unknown;
    for (let i = 0; i < 100; i++) {
      w.advance(2 * SEC);
      last = bodyOf(await w.line('big', 'sender', `hello number ${i}`)).hiddenFor;
    }
    expect([...(last as string[])].sort()).toEqual(['m0', 'm1', 'm2']);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('a seat seated in the kit directly (not through the service) that muted the sender is listed too: one roster, not two', async () => {
    const w = await serviceWorld();
    await w.seat('r', 'sender', 'sender');
    w.real.rooms.seat('r', 'direct', { clientKey: 'raw-client-key-direct-0001' }, 'direct');
    w.real.mutes.set('r', 'direct', 'sender', true);
    w.advance(2 * SEC);
    expect(bodyOf(await w.line('r', 'sender', 'hi')).hiddenFor).toEqual(['direct']);
  });
});

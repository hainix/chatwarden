import { describe, expect, it, vi } from 'vitest';
import { HubError } from '../src/client.js';
import type { HubClient } from '../src/client.js';
import { SESSION_REPORTERS_MAX, SESSION_TTL_MS, createSession } from '../src/session.js';
import type { PolicyDocs, Reason, ReporterRecord } from '../src/types.js';

// The session keeps what a moderator would otherwise read again for every case: the rules once, the rest for a few minutes.

const record = (reports: number): ReporterRecord => ({ reports, open: 0, actioned: reports, dismissed: 0, badFaith: 0, suspendedUntil: null, reasonMatched: 0, reasonDecided: 0 });

function fake() {
  const calls = { policy: 0, reasons: 0, blocked: 0, history: [] as string[] };
  let fail: Record<string, boolean> = {};
  const client = {
    policy: vi.fn(() => {
      calls.policy += 1;
      return fail.policy ? Promise.reject(new HubError({ status: 500, code: 'server_error', message: 'x' })) : Promise.resolve({ profile: {}, rules: [] } as unknown as PolicyDocs);
    }),
    listReasons: vi.fn(() => {
      calls.reasons += 1;
      const reasons: Reason[] = [
        { id: 'a', label: 'A', text: 'a', active: true },
        { id: 'b', label: 'B', text: 'b', active: false },
      ];
      return fail.reasons ? Promise.reject(new HubError({ status: 500, code: 'server_error', message: 'x' })) : Promise.resolve({ reasons });
    }),
    listBlocked: vi.fn((options?: { days?: number }) => {
      calls.blocked += 1;
      expect(options).toEqual({ days: 7 });
      return fail.blocked ? Promise.reject(new HubError({ status: 403, code: 'forbidden', message: 'x' })) : Promise.resolve({ items: [] });
    }),
    personHistory: vi.fn((ref: string, options?: { limit?: number }) => {
      calls.history.push(ref);
      expect(options).toEqual({ limit: 1 });
      return fail[`h:${ref}`] ? Promise.reject(new HubError({ status: 500, code: 'server_error', message: 'x' })) : Promise.resolve({ history: [], reports: [], sanctions: [], asReporter: record(calls.history.length) });
    }),
  } as unknown as HubClient;
  const clock = { t: 1_000_000 };
  return { client, calls, clock, set: (f: Record<string, boolean>) => (fail = f), session: () => createSession(client, () => clock.t) };
}

describe('the session: policy', () => {
  it('is read once however often it is asked, even at the same instant', async () => {
    const f = fake();
    const s = f.session();
    const [a, b] = await Promise.all([s.policy(), s.policy()]);
    await s.policy();
    expect(a).toBe(b);
    expect(f.calls.policy).toBe(1);
  });

  it('is kept for the whole session, however much time passes', async () => {
    const f = fake();
    const s = f.session();
    await s.policy();
    f.clock.t += 24 * 60 * 60_000;
    await s.policy();
    expect(f.calls.policy).toBe(1);
  });

  it('a failed read is not kept: the next ask reads again, and its answer is kept', async () => {
    const f = fake();
    const s = f.session();
    f.set({ policy: true });
    await expect(s.policy()).rejects.toBeInstanceOf(HubError);
    f.set({});
    await expect(s.policy()).resolves.toBeDefined();
    await s.policy();
    expect(f.calls.policy).toBe(2);
  });

  it('two sessions (two clients) do not share it', async () => {
    const f = fake();
    await f.session().policy();
    await f.session().policy();
    expect(f.calls.policy).toBe(2);
  });
});

describe('the session: saved reasons and blocked lines', () => {
  it('reasons: only the active ones, read once inside the window and again after it', async () => {
    const f = fake();
    const s = f.session();
    expect((await s.reasons()).map((r) => r.id)).toEqual(['a']);
    f.clock.t += SESSION_TTL_MS - 1;
    await s.reasons();
    expect(f.calls.reasons).toBe(1);
    f.clock.t += 1;
    await s.reasons();
    expect(f.calls.reasons).toBe(2);
  });

  it('blocked lines: the last 7 days, read once inside the window', async () => {
    const f = fake();
    const s = f.session();
    await Promise.all([s.blocked(), s.blocked()]);
    await s.blocked();
    expect(f.calls.blocked).toBe(1);
    f.clock.t += SESSION_TTL_MS;
    await s.blocked();
    expect(f.calls.blocked).toBe(2);
  });

  it('a failed read is dropped, and a late failure does not drop a newer answer', async () => {
    const f = fake();
    const s = f.session();
    f.set({ blocked: true });
    await expect(s.blocked()).rejects.toBeInstanceOf(HubError);
    f.set({});
    await s.blocked();
    await s.blocked();
    expect(f.calls.blocked).toBe(2);
  });
});

describe('the session: reporter records', () => {
  it('one read per reporter inside the window, shared by two asks at once', async () => {
    const f = fake();
    const s = f.session();
    const [a, b] = await Promise.all([s.reporter('r1'), s.reporter('r1')]);
    expect(a).toBe(b);
    await s.reporter('r2');
    await s.reporter('r1');
    expect(f.calls.history).toEqual(['r1', 'r2']);
  });

  it('is read again after the window', async () => {
    const f = fake();
    const s = f.session();
    await s.reporter('r1');
    f.clock.t += SESSION_TTL_MS;
    await s.reporter('r1');
    expect(f.calls.history).toEqual(['r1', 'r1']);
  });

  it('a failure is dropped: the next ask reads again', async () => {
    const f = fake();
    const s = f.session();
    f.set({ 'h:r1': true });
    await expect(s.reporter('r1')).rejects.toBeInstanceOf(HubError);
    f.set({});
    await expect(s.reporter('r1')).resolves.toMatchObject({ reports: expect.any(Number) });
    expect(f.calls.history).toEqual(['r1', 'r1']);
  });

  it('remembers at most SESSION_REPORTERS_MAX reporters, dropping the oldest', async () => {
    const f = fake();
    const s = f.session();
    for (let i = 0; i <= SESSION_REPORTERS_MAX; i += 1) await s.reporter(`r${i}`);
    f.calls.history.length = 0;
    await s.reporter(`r${SESSION_REPORTERS_MAX}`);
    expect(f.calls.history).toEqual([]);
    await s.reporter('r0');
    expect(f.calls.history).toEqual(['r0']);
  });
});

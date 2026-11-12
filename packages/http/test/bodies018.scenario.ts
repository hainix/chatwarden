import type { world } from './world.js';

// One fixed run of the staff routes whose bodies 0.1.9 must leave exactly as 0.1.8 sent them while appeals and the name features are off (or, for
// the handle masks, switched off). The fixture `fixtures/bodies-0.1.8.json` was produced by running this very function against the 0.1.8 code
// (origin/main at 2bf9eb8) in a scratch worktree; the test replays it on this branch and compares. The scenario uses nothing added since 0.1.8.

type World = Awaited<ReturnType<typeof world>>;

/** The responses of the frozen routes, as the router gave them: status, headers and body, in a fixed order. */
export async function scenario018(w: World): Promise<Record<string, unknown>> {
  const seat = (room: string, who: string, key: string, handle: string): void => {
    w.cw.rooms.seat(room, who, { clientKey: key, ip: '203.0.113.99' }, handle);
  };
  const report = async (n: number, targetHandle: string, reporterHandle: string) => {
    const room = `frozen-room-${n}`;
    seat(room, 'p1', `frozen-reporter-key-${n}`, reporterHandle);
    seat(room, 'p2', 'frozen-target-key-shared', targetHandle);
    w.cw.chat.accept(room, 'p2', `a line from the target ${n}`);
    w.cw.chat.accept(room, 'p1', `a line from the reporter ${n}`);
    w.clock.t += 1000;
    const res = await w.cw.reports.submit({ roomId: room, reporterSeat: 'p1', targetSeat: 'p2', category: 'harassment' });
    if (!res.ok) throw new Error(`report refused: ${res.refused}`);
    return res.reportId;
  };
  const first = await report(1, 'Zorbak_Fan', 'FriendlyFox');
  const second = await report(2, 'Zorbak_Fan', 'Zorbak_Reporter');
  await report(3, 'FriendlyFox', 'Quiet_Owl');
  const target = w.cw.reports.get(first)?.targetPerson as string;
  w.clock.t += 1000;
  const decided = await w.cw.decide({
    reportId: first,
    verdict: 'upheld',
    actor: 'mod_ann',
    reason: 'private moderator reason',
    actions: [{ subject: target, kind: 'chat', durationMs: 3_600_000, rule: 2, lineIds: [] }],
  } as never);
  if (!decided.ok) throw new Error('decision refused');
  w.clock.t += 1000;
  await w.cw.sanctions.apply({ kind: 'warning', subject: target, includeIp: false, durationMs: null, reason: 'private reason', actor: 'ann', source: 'moderator', automated: false, rule: 2 });
  w.clock.t += 1000;

  const out: Record<string, unknown> = {};
  const get = async (name: string, path: string, role: 'moderator' | 'senior' | 'owner' = 'moderator', query: Record<string, string> = {}): Promise<void> => {
    const res = await w.call('GET', path, { role, query });
    out[name] = { status: res.status, headers: res.headers ?? null, body: res.body };
  };
  await get('me.moderator', '/me');
  await get('me.senior', '/me', 'senior');
  await get('me.owner', '/me', 'owner');
  await get('changes', '/changes');
  await get('history', `/people/${target}/history`);
  await get('reports', '/reports');
  await get('report', `/reports/${second}`);
  await get('reports.decided', '/reports', 'moderator', { status: 'decided' });
  await get('sanctions', '/sanctions');
  await get('blocked', '/blocked');
  await get('blocked.30', '/blocked', 'moderator', { days: '30' });
  return out;
}

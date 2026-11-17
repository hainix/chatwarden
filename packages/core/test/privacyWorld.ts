import { MemoryStore } from '@chatwarden/store-memory';
import { fullStore } from './legalWorld.js';
import { NOW, world } from './reportingWorld.js';
import type { ChatwardenOptions } from '../src/chatwarden.js';
import type { SubjectId } from '../src/types.js';

// A real kit over a full in-memory store with two connected players, for the privacy tests: `a` is the person who will be erased, `b` another player. Everything is
// done through the kit (seat, chat, report, sanction, mute) so the in-memory indexes hold the person exactly as a running game would.

export { NOW, DAY } from './reportingWorld.js';
export { MemoryStore };

export const A = { key: 'key-a-0001', account: 'acct-a-0001', ip: '10.0.0.11', handle: 'AlphaHandle' };
export const B = { key: 'key-b-0002', account: 'acct-b-0002', ip: '10.0.0.22', handle: 'BravoHandle' };
export const A_LINE = 'tarvo alpha said this line';
export const B_LINE = 'vlemmo bravo said that line';

/** Strings that must be nowhere in the store once A is erased (with `keep: none`). */
export const A_SECRETS = [A.key, A.account, A.ip, A.handle, A_LINE];

export const dump = (s: unknown): string => JSON.stringify(s, (_k, v: unknown) => (v instanceof Map ? [...v.entries()] : v instanceof Set ? [...v.values()] : v));

export async function privacyWorld(over: Partial<ChatwardenOptions> = {}, store: ReturnType<typeof fullStore> = fullStore()) {
  const w = await world({ ...over }, store);
  const { cw } = w;
  const seat = (room: string, seatId: string, p: typeof A) => cw.rooms.seat(room, seatId, { clientKey: p.key, accountId: p.account, ip: p.ip }, p.handle);
  seat('R1', 'p1', A);
  seat('R1', 'p2', B);
  await cw.flush();
  const aId = cw.rooms.subjectAt('R1', 'p1') as SubjectId;
  const bId = cw.rooms.subjectAt('R1', 'p2') as SubjectId;
  return { ...w, store, aId, bId, seat };
}
export type PrivacyWorld = Awaited<ReturnType<typeof privacyWorld>>;

/** A second subject for the person, merged into the first: the same account behind a key the kit had met alone. Returns the alias (the subject that was merged away). */
export async function mergeAlias(w: PrivacyWorld): Promise<string> {
  w.cw.rooms.seat('R9', 'p1', { clientKey: 'key-a-second' }, 'AlphaTwo');
  await w.cw.flush();
  const alone = w.cw.rooms.subjectAt('R9', 'p1') as string;
  w.cw.rooms.seat('R9', 'p1', { clientKey: 'key-a-second', accountId: A.account }, 'AlphaTwo');
  await w.cw.flush();
  const canonical = w.cw.people.canonical(w.aId);
  if (w.cw.people.canonical(alone) !== canonical) throw new Error('expected a merge');
  return alone === canonical ? w.aId : alone;
}

/** Gives A one row of every kind the kit writes through its own paths, and returns the report ids. */
export async function fillA(w: PrivacyWorld): Promise<{ about: string; filed: string; third: string }> {
  const { cw, store, aId, bId } = w;
  cw.chat.accept('R1', 'p1', A_LINE);
  cw.chat.accept('R1', 'p2', B_LINE);
  cw.chat.accept('R1', 'p1', `${A_LINE} again`);
  const about = await cw.reports.submit({ roomId: 'R1', reporterSeat: 'p2', targetSeat: 'p1', reason: 'harassment', note: 'bravo says alpha was rude' });
  if (!about.ok) throw new Error(`refused: ${about.refused}`);
  // A reports B from another room
  w.seat('R2', 'p1', A);
  w.seat('R2', 'p2', B);
  await cw.flush();
  cw.chat.accept('R2', 'p1', 'alpha reports bravo');
  const filed = await cw.reports.submit({ roomId: 'R2', reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment', note: 'alpha note about bravo' });
  if (!filed.ok) throw new Error(`refused: ${filed.refused}`);
  // a third party report that holds one of A's lines
  w.seat('R3', 'p1', B);
  w.seat('R3', 'p2', { key: 'key-c-0003', account: 'acct-c-0003', ip: '10.0.0.33', handle: 'CharlieHandle' });
  w.seat('R3', 'p3', A);
  await cw.flush();
  cw.chat.accept('R3', 'p3', `${A_LINE} in a third room`);
  cw.chat.accept('R3', 'p2', 'charlie line');
  const third = await cw.reports.submit({ roomId: 'R3', reporterSeat: 'p1', targetSeat: 'p2', reason: 'spam' });
  if (!third.ok) throw new Error(`refused: ${third.refused}`);
  cw.mutes.set('R1', 'p1', 'p2', true);
  cw.mutes.set('R1', 'p2', 'p1', true);
  store.insertStrike({ id: 'strike-a', at: NOW - 1000, subject: aId, roomId: 'R1', termId: 't1', rawLine: A_LINE });
  store.insertNotice({ id: 'notice-a', subject: aId, groupId: null, kind: 'report_outcome', rule: null, until: null, refCode: null, excerpt: [{ text: A_LINE, day: '2027-01-15' }], createdAt: NOW - 500, ackedAt: null, withdrawnAt: null });
  store.insertSignal({ id: 'sig-a', kind: 'muted_by_player', subject: aId, sourceKey: `b:${bId}`, bySubject: bId, roomId: null, at: NOW - 400, weight: 1, capBucket: 1 });
  store.claimCase(aId, 'mod_ann', NOW, NOW + 600_000, 'claim');
  return { about: about.reportId, filed: filed.reportId, third: third.reportId };
}

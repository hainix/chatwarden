import { describe, expect, it } from 'vitest';
import type { ChatResult } from '@chatwarden/core';
import { refusalOf } from '../src/chat/wire.js';
import { BLOCKED, chatWorld, SEC } from './chat-world.js';
import { bodyOf } from './serviceKit.js';
import { serviceWorld } from './serviceWorld.js';

// S2: the same scripted conversation through `cw.chat.accept` and through /v1 over toFetch gives the same verdicts, strikes, evidence lines and notices.

const ROOM = 'arena';
const PACE = { slowModeMs: 1000, burst: { lines: 3, windowMs: 10_000 }, duplicateWindowMs: 20_000 } as const;
const IP = '203.0.113.7';

type Verdict = { ok: true; text: string } | { ok: false; refused: Record<string, unknown> };

/** A notice id is random per kit: what is compared is that there is one. */
const masked = (refused: Record<string, unknown>): Record<string, unknown> => ({ ...refused, ...(typeof refused.noticeId === 'string' ? { noticeId: '<id>' } : {}) });
const fromKit = (r: ChatResult): Verdict => ('deliver' in r ? { ok: true, text: r.deliver.text } : { ok: false, refused: masked({ ...refusalOf(r.refuse) }) });

interface Step {
  /** Time to pass first. */
  wait: number;
  seat: 'a' | 'b';
  text: string;
}

const SCRIPT: Step[] = [
  { wait: 2 * SEC, seat: 'a', text: 'hello everyone' },
  { wait: 2 * SEC, seat: 'b', text: 'hi alice, ready to play?' },
  { wait: 2 * SEC, seat: 'a', text: `you ${BLOCKED}, you absolute` },
  { wait: 2 * SEC, seat: 'a', text: 'hello everyone' },
  { wait: 1100, seat: 'a', text: 'one' },
  { wait: 1100, seat: 'a', text: 'two' },
  { wait: 1100, seat: 'a', text: 'three' },
  { wait: 1100, seat: 'a', text: 'four' },
  { wait: 300, seat: 'a', text: 'five too fast' },
  { wait: 12 * SEC, seat: 'b', text: 'that was rude' },
  { wait: 2 * SEC, seat: 'a', text: `again ${BLOCKED}` },
  { wait: 2 * SEC, seat: 'a', text: `and ${BLOCKED} again` },
  { wait: 2 * SEC, seat: 'a', text: 'sorry' },
];

describe('differential: cw.chat.accept and /v1 agree', () => {
  it('one scripted conversation (join, lines including a slur, a flood and a repeat under pace, a report, a ban, a door check) gives identical verdicts, strikes, evidence lines and notices', async () => {
    const direct = await chatWorld({ noBroadcaster: true, pace: PACE });
    const service = await serviceWorld({ world: { pace: PACE } });

    // join
    for (const [seat, name] of [['a', 'alice'], ['b', 'bob']] as const) {
      direct.real.rooms.seat(ROOM, seat, direct.who(name), name);
      expect((await service.seat(ROOM, seat, name, { who: { ip: IP } })).status).toBe(200);
    }

    const viaKit: Verdict[] = [];
    const viaService: Verdict[] = [];
    for (const step of SCRIPT) {
      direct.advance(step.wait);
      service.advance(step.wait);
      viaKit.push(fromKit(direct.real.chat.accept(ROOM, step.seat, step.text)));
      const res = bodyOf(await service.line(ROOM, step.seat, step.text));
      viaService.push(res.ok === true ? { ok: true, text: res.line.text } : { ok: false, refused: masked(res.refused) });
    }
    expect(viaService).toEqual(viaKit);
    // the script really exercised the checks: a delivery, a slur, a repeat, a flood and a restriction
    const reasons = viaKit.map((v) => (v.ok ? 'ok' : (v.refused.reason as string)));
    for (const wanted of ['ok', 'blocked', 'duplicate', 'flood', 'restricted']) expect(reasons, wanted).toContain(wanted);

    // strikes: the same blocked lines, by term and count
    expect(service.real.blocked.countsByTerm({ days: 1 })).toEqual(direct.real.blocked.countsByTerm({ days: 1 }));
    expect(service.real.blocked.list({ days: 1 }).map((b) => b.text)).toEqual(direct.real.blocked.list({ days: 1 }).map((b) => b.text));

    // a report (from bob, about alice), a ban, a door check
    const lastOf = (w: typeof direct.real, seat: string): string => w.rooms.lineStates(ROOM).at(-1)?.lineId ?? seat;
    void lastOf;
    const filedDirect = await direct.real.reports.submit({ roomId: ROOM, reporterSeat: 'b', targetSeat: 'a', reason: 'harassment' });
    const filedService = bodyOf(await service.call('POST', `/rooms/${ROOM}/seats/b/reports`, { body: { target: 'a', reason: 'harassment' } }));
    expect(filedDirect.ok).toBe(true);
    expect(filedService).toEqual(filedDirect.ok ? { ok: true, remaining: filedDirect.remaining, detailUntil: filedDirect.detailUntil } : {});
    const excerptOf = (w: typeof direct.real): string[] => (w.reports.list({}).items[0]?.excerpt ?? []).map((l) => l.raw);
    expect(excerptOf(service.real)).toEqual(excerptOf(direct.real));
    expect(excerptOf(direct.real).length).toBeGreaterThan(3);

    await direct.sanction('ban', ROOM, 'alice', 3_600_000, { ip: IP });
    await service.sanction('ban', ROOM, 'alice', 3_600_000, { ip: IP });
    const door = direct.real.doors.check('join', direct.who('alice'));
    const doorRes = bodyOf(await service.call('POST', '/doors/check', { body: { kind: 'join', who: service.who('alice', { ip: IP }) } }));
    expect(door).not.toBeNull();
    // the ref code and the notice id are random per kit: the shape and the rest are compared
    const shape = (r: { kind?: unknown; until?: unknown; refCode?: unknown; noticeId?: unknown } | null | undefined) => ({ kind: r?.kind, until: r?.until, refCode: typeof r?.refCode, noticeId: typeof r?.noticeId });
    expect(shape(doorRes.refusal)).toEqual(shape(door));
    expect(doorRes.ok).toBe(false);

    // notices: the same pending list for alice and for bob, by kind and content (ids are random)
    const noticesOf = (list: Array<{ kind: string; rule: unknown; until: unknown; mustAcknowledge: boolean; excerpt: unknown }>) => list.map((n) => ({ kind: n.kind, rule: n.rule, until: n.until, mustAcknowledge: n.mustAcknowledge, excerpt: n.excerpt }));
    for (const name of ['alice', 'bob']) {
      const kitList = direct.real.notices.pending(direct.who(name));
      const serviceList = bodyOf(await service.call('POST', '/notices/pending', { body: { who: service.who(name, { ip: IP }) } })).notices;
      expect(noticesOf(serviceList), name).toEqual(noticesOf(kitList));
    }
    const record = bodyOf(await service.call('POST', '/record', { body: { who: service.who('alice', { ip: IP }) } })).record;
    expect(noticesOf(record)).toEqual(noticesOf(direct.real.notices.record(direct.who('alice'))));
  });

  it('the same script over a real fetch (toFetch at /v1) gives the same verdicts as the table called directly', async () => {
    const a = await serviceWorld({ world: { pace: PACE } });
    const b = await serviceWorld({ world: { pace: PACE } });
    for (const w of [a, b]) {
      await w.seat(ROOM, 'a', 'alice');
      await w.seat(ROOM, 'b', 'bob');
    }
    for (const step of SCRIPT) {
      a.advance(step.wait);
      b.advance(step.wait);
      const direct = bodyOf(await a.line(ROOM, step.seat, step.text));
      const fetched = (await b.fetchJson('POST', `/rooms/${ROOM}/seats/${step.seat}/lines`, { text: step.text })).body as { ok: boolean; line?: { id: string; text: string }; refused?: Record<string, unknown> };
      const same = (x: typeof fetched) => (x.ok ? { ok: true, text: x.line?.text } : { ok: false, refused: masked(x.refused ?? {}) });
      expect(same(fetched)).toEqual(same(direct));
    }
  });
});

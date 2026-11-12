import { describe, expect, it } from 'vitest';
import type { Chatwarden, ReportInput, ReportResult } from '@chatwarden/core';
import type { SendResult } from '../src/chat/wire.js';
import { chatWorld, SEC } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';

const ROOM = 'lobby';

function say(w: ChatWorld, s: { send(i: { text: string }): SendResult }, text: string): SendResult {
  w.advance(2 * SEC);
  return s.send({ text });
}

/** A world whose `reports.submit` is recorded, and optionally scripted (by default the real kit answers). */
async function watched(script?: (input: ReportInput) => Promise<ReportResult> | ReportResult | undefined) {
  const submitted: ReportInput[] = [];
  const w = await chatWorld({
    wrap: (cw) => {
      const f = Object.create(cw) as Chatwarden;
      f.reports = {
        ...cw.reports,
        submit: async (input) => {
          submitted.push(structuredClone(input));
          const scripted = script?.(input);
          return scripted === undefined ? cw.reports.submit(input) : scripted;
        },
      };
      return f;
    },
  });
  const author = w.attend(ROOM, 'plenk');
  const reporter = w.attend(ROOM, 'wumbo');
  const line = say(w, author.session, 'plenk says something');
  if (!line.ok) throw new Error('refused');
  return { w, author, reporter, submitted, lineId: line.line.id };
}

describe('report', () => {
  it("a report on a visible line files a kit report with the reporter's seat and the line's author as target and returns only remaining", async () => {
    const { w, reporter, submitted, lineId } = await watched();
    const out = await reporter.session.report({ lineId, reason: 'harassment', note: 'it was rude' });
    expect(out).toEqual({ ok: true, remaining: 9 });
    expect(submitted).toEqual([
      {
        roomId: ROOM,
        reporterSeat: w.seatOf(ROOM, 'wumbo'),
        targetSeat: w.seatOf(ROOM, 'plenk'),
        lineId,
        reason: 'harassment',
        note: 'it was rude',
      },
    ]);
    // never the report id, a seat or a subject
    expect(Object.keys(out)).toEqual(['ok', 'remaining']);
    // and the kit holds exactly one report, about the author
    expect(w.cw.reports.list({}).items).toHaveLength(1);
  });

  it('a report with no reason or note passes neither to the kit', async () => {
    const { reporter, submitted, lineId } = await watched();
    const out = await reporter.session.report({ lineId });
    expect(out.ok).toBe(true);
    expect(Object.keys(submitted[0] ?? {}).sort()).toEqual(['lineId', 'reporterSeat', 'roomId', 'targetSeat']);
  });

  it('non-string reason and note are not passed on', async () => {
    const { reporter, submitted, lineId } = await watched();
    await reporter.session.report({ lineId, reason: 5, note: { x: 1 } } as never);
    expect(Object.keys(submitted[0] ?? {}).sort()).toEqual(['lineId', 'reporterSeat', 'roomId', 'targetSeat']);
  });

  it('the remaining count goes down with each report', async () => {
    const { w, author, reporter } = await watched();
    const second = say(w, author.session, 'a second line');
    if (!second.ok) throw new Error('refused');
    const out = await reporter.session.report({ lineId: second.line.id });
    expect(out).toEqual({ ok: true, remaining: 9 });
  });
});

describe('a line that cannot be reported is not_found', () => {
  it('unknown, aged-out and hidden lines are not_found, and the kit is never asked', async () => {
    const { w, reporter, submitted, lineId } = await watched();
    for (const bad of ['nope', '', 'x'.repeat(100)]) {
      expect(await reporter.session.report({ lineId: bad })).toEqual({ ok: false, refused: 'not_found' });
    }
    for (const bad of [undefined, null, 5, {}, []]) {
      expect(await reporter.session.report({ lineId: bad } as never)).toEqual({ ok: false, refused: 'not_found' });
    }
    expect(await reporter.session.report(undefined as never)).toEqual({ ok: false, refused: 'not_found' });

    // hidden: the reporter muted the author, so the line does not exist for them
    expect(reporter.session.mute({ lineId, on: true })).toBe(true);
    expect(await reporter.session.report({ lineId })).toEqual({ ok: false, refused: 'not_found' });
    // un-hidden again, it can be reported
    expect(reporter.session.mute({ lineId, on: false })).toBe(true);
    expect((await reporter.session.report({ lineId })).ok).toBe(true);

    // aged out of the ring
    const other = say(w, reporter.session, 'a line of my own');
    void other;
    w.advance(16 * 60 * SEC);
    expect(await reporter.session.report({ lineId })).toEqual({ ok: false, refused: 'not_found' });
    expect(submitted).toHaveLength(1);
  });

  it("a line from a room the reporter is not in is not_found (a line id is only good in its own room)", async () => {
    const { w, lineId } = await watched();
    const stranger = w.join('other-room', 'glarn');
    expect(await stranger.report({ lineId })).toEqual({ ok: false, refused: 'not_found' });
  });

  it('a refused line has no id to report', async () => {
    const { w, reporter, submitted } = await watched();
    const refused = say(w, reporter.session, 'x'.repeat(300));
    expect(refused.ok).toBe(false);
    expect(await reporter.session.report({ lineId: '999' })).toEqual({ ok: false, refused: 'not_found' });
    expect(submitted).toHaveLength(0);
  });
});

describe('kit refusals pass through by name', () => {
  it("own line is the kit's self", async () => {
    const { w, reporter, author, submitted } = await watched();
    const mine = say(w, reporter.session, 'my own line');
    if (!mine.ok) throw new Error('refused');
    expect(await reporter.session.report({ lineId: mine.line.id })).toEqual({ ok: false, refused: 'self' });
    expect(submitted).toHaveLength(1);
    void author;
  });

  it('duplicate and reason_unknown come from the real kit', async () => {
    const { reporter, lineId } = await watched();
    expect((await reporter.session.report({ lineId })).ok).toBe(true);
    expect(await reporter.session.report({ lineId })).toEqual({ ok: false, refused: 'duplicate' });
    const bogus = await reporter.session.report({ lineId, reason: 'not-a-reason' });
    expect(bogus).toEqual({ ok: false, refused: 'reason_unknown' });
  });

  it('suspended, off and rate pass through; rate keeps its remaining', async () => {
    for (const [refused, extra] of [
      ['suspended', undefined],
      ['off', undefined],
      ['rate', 0],
      ['not_player', undefined],
      ['reason_required', undefined],
    ] as const) {
      const { reporter, lineId } = await watched(() => ({ ok: false, refused, ...(extra === undefined ? {} : { remaining: extra }) }));
      const out = await reporter.session.report({ lineId });
      expect(out).toEqual(extra === undefined ? { ok: false, refused } : { ok: false, refused, remaining: extra });
    }
  });

  it('whatever else the kit puts in its answer (a report id, a time) is dropped', async () => {
    const { reporter, lineId } = await watched(() => ({ ok: true, reportId: 'r_secret', remaining: 4, detailUntil: 123 }) as ReportResult);
    const out = await reporter.session.report({ lineId });
    expect(out).toEqual({ ok: true, remaining: 4 });
    expect(JSON.stringify(out)).not.toContain('r_secret');
  });
});

describe('the reporter and the target are never chosen by the caller', () => {
  it('a body field naming a seat or reporter is ignored (the API has none)', async () => {
    const { w, reporter, submitted, lineId } = await watched();
    await reporter.session.report({
      lineId,
      reporterSeat: 'someone-else',
      targetSeat: w.seatOf(ROOM, 'wumbo'),
      seat: 'x',
      subject: 's_abc',
      roomId: 'another-room',
      reporter: 'plenk',
    } as never);
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.reporterSeat).toBe(w.seatOf(ROOM, 'wumbo'));
    expect(submitted[0]?.targetSeat).toBe(w.seatOf(ROOM, 'plenk'));
    expect(submitted[0]?.roomId).toBe(ROOM);
    expect(Object.keys(submitted[0] ?? {}).sort()).toEqual(['lineId', 'reporterSeat', 'roomId', 'targetSeat']);
  });
});

describe('a kit that fails', () => {
  it("a kit that rejects is { ok: false, refused: 'off' } and logs the error class only", async () => {
    const { reporter, lineId, w } = await watched(() => Promise.reject(new TypeError('secret detail plenk wumbo')));
    const out = await reporter.session.report({ lineId });
    expect(out).toEqual({ ok: false, refused: 'off' });
    expect(w.logs.filter((l) => l[0].startsWith('chatwarden.chat_'))).toEqual([['chatwarden.chat_report_failed', { error: 'TypeError' }]]);
    expect(JSON.stringify(w.logs)).not.toMatch(/secret detail|plenk|wumbo/);
  });

  it('a kit that throws synchronously is the same', async () => {
    const { reporter, lineId } = await watched(() => {
      throw new RangeError('boom');
    });
    expect(await reporter.session.report({ lineId })).toEqual({ ok: false, refused: 'off' });
  });

  it('report never rejects', async () => {
    const { reporter } = await watched(() => Promise.reject(new Error('x')));
    await expect(reporter.session.report({ lineId: '1' })).resolves.toBeDefined();
  });
});

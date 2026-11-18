import { describe, expect, it } from 'vitest';
import { evidenceLink } from '../src/reporting.js';
import type { KitEvent } from '../src/events.js';
import { roomsWorld } from './roomsWorld.js';
import type { RoomsWorld } from './roomsWorld.js';

// R2: the evidence pointer. An opaque id the game's server gives for the gameplay behind a report (a match, a replay): 1 to 128 of A-Z a-z 0-9 _ : - (no dot, no slash). A bad one is dropped, the report is
// still taken and the class is logged. It reaches no event, no queue summary and no log; `evidenceLink` makes the staff link from the owner's https template.

async function file(w: RoomsWorld, evidenceRef?: unknown) {
  w.cw.rooms.seat('E1', 'p1', { clientKey: 'evidence-rep-aaaaaaaaaaaa' }, 'Rep');
  w.cw.rooms.seat('E1', 'p2', { clientKey: 'evidence-tgt-aaaaaaaaaaaa' }, 'Tgt');
  w.cw.chat.accept('E1', 'p2', 'a line');
  const res = await w.cw.reports.submit({ roomId: 'E1', reporterSeat: 'p1', targetSeat: 'p2', reason: 'harassment', ...(evidenceRef === undefined ? {} : { evidenceRef }) } as never);
  if (!res.ok) throw new Error(res.refused);
  return res.reportId;
}

describe('ReportInput.evidenceRef', () => {
  it('128 characters are accepted, 129 are dropped with the report still taken', async () => {
    const a = await roomsWorld();
    expect(a.store.loadReport(await file(a, 'a'.repeat(128)))?.evidenceRef).toBe('a'.repeat(128));
    const b = await roomsWorld();
    expect(b.store.loadReport(await file(b, 'a'.repeat(129)))?.evidenceRef).toBeNull();
  });

  it('the whole alphabet is accepted: letters, digits, underscore, colon and hyphen', async () => {
    const w = await roomsWorld();
    expect(w.store.loadReport(await file(w, 'Match_42:team-A9'))?.evidenceRef).toBe('Match_42:team-A9');
  });

  it('a dot, slash, space, emoji, NUL, backslash, percent, newline and non-ASCII letter are dropped with the report still taken', async () => {
    for (const bad of ['a.b', 'a/b', 'a b', 'a\u{1F600}', 'a\u0000b', 'a\\b', 'a%2Fb', 'a\nb', 'caf\u00e9', '../etc', 'https://x']) {
      const w = await roomsWorld();
      const id = await file(w, bad);
      expect(w.store.loadReport(id)?.evidenceRef, JSON.stringify(bad)).toBeNull();
    }
  });

  it('null, absent, an empty string and a non-string read null', async () => {
    for (const v of [undefined, null, '', 5, true, {}, ['x']]) {
      const w = await roomsWorld();
      expect(w.store.loadReport(await file(w, v))?.evidenceRef, JSON.stringify(v)).toBeNull();
    }
  });

  it('an invalid ref is logged by class only and the value is never in a log line', async () => {
    const w = await roomsWorld();
    await file(w, 'SENTINEL.not-allowed');
    const text = JSON.stringify(w.logged);
    expect(text).not.toContain('SENTINEL');
    expect(w.logged.map(([event]) => event)).toContain('reports.evidence_ref_dropped');
  });

  it('a valid ref is not logged and is absent from every event', async () => {
    const w = await roomsWorld();
    const events: KitEvent[] = [];
    w.cw.on('*', (e) => void events.push(e));
    await file(w, 'match_SENTINEL_1');
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('SENTINEL');
    expect(JSON.stringify(w.logged)).not.toContain('SENTINEL');
  });

  it('reports.get carries the ref and the evidence read: { ref, url } with the owner\'s https template, or url null with none', async () => {
    const a = await roomsWorld({ overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    const id = await file(a, 'match_9:t-2');
    const got = a.cw.reports.get(id) as { evidence?: unknown } | null;
    expect(got?.evidence).toEqual({ ref: 'match_9:t-2', url: 'https://replays.example.test/m/match_9%3At-2' });
    const b = await roomsWorld();
    const idB = await file(b, 'match_9');
    expect((b.cw.reports.get(idB) as { evidence?: unknown } | null)?.evidence).toEqual({ ref: 'match_9', url: null });
  });

  it('a report with no ref has evidence null on the case read', async () => {
    const w = await roomsWorld({ overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    const id = await file(w);
    expect((w.cw.reports.get(id) as { evidence?: unknown } | null)?.evidence).toBeNull();
  });

  it('the queue listing carries no evidence read', async () => {
    const w = await roomsWorld({ overrides: { reporting: { evidenceUrl: 'https://replays.example.test/m/{ref}' } } });
    await file(w, 'match_9');
    for (const item of w.cw.reports.list({ status: 'open' }).items) expect('evidence' in item).toBe(false);
  });
});

describe('evidenceLink', () => {
  const tpl = 'https://replays.example.test/m/{ref}/view';
  it('replaces {ref} with encodeURIComponent(ref) for an https template with one placeholder', () => {
    expect(evidenceLink({ evidenceUrl: tpl }, 'a:b-c_9')).toBe('https://replays.example.test/m/a%3Ab-c_9/view');
    expect(evidenceLink({ evidenceUrl: 'https://replays.example.test/?m={ref}' }, 'x')).toBe('https://replays.example.test/?m=x');
  });

  it('no template gives null', () => {
    expect(evidenceLink({ evidenceUrl: null }, 'x')).toBeNull();
    expect(evidenceLink({} as never, 'x')).toBeNull();
  });

  it('a template edited to http, with no placeholder, two placeholders, a placeholder in the host, credentials or no host gives null at read', () => {
    for (const bad of ['http://replays.example.test/m/{ref}', 'https://replays.example.test/m/', 'https://replays.example.test/{ref}/{ref}', 'https://{ref}.example.test/', 'https://user:pw@replays.example.test/{ref}', 'https:///{ref}', 'javascript:alert({ref})', '', 'ftp://x/{ref}']) {
      expect(evidenceLink({ evidenceUrl: bad }, 'x'), bad).toBeNull();
    }
  });

  it('a dollar sign pattern in the template is not interpreted', () => {
    expect(evidenceLink({ evidenceUrl: 'https://replays.example.test/$&/{ref}' }, 'x')).toBe('https://replays.example.test/$&/x');
  });
});

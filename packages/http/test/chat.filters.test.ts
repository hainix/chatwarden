import { describe, expect, it } from 'vitest';
import { chatWorld, SEC } from './chat-world.js';
import type { SendResult } from '../src/chat/wire.js';
import { refusalOf } from '../src/chat/wire.js';

// F7: the chat filters over the real routes of the kit. A refusal reaches the author as `{ reason: link | personal_info | filter, rule }` and nothing
// else: never the matched part, a pattern, a counter key or a range. A masked line goes out starred, a flagged one is delivered and files a report.

const ROOM = 'lobby';
const FILTERS = {
  links: { action: 'refuse' as const, rule: 4 },
  personalInfo: { action: 'refuse' as const, rule: 2 },
  phrases: [{ id: 'gold', label: 'Gold ads', action: 'refuse' as const, rule: 5, phrases: ['buy gold now'] }],
};

function refusedOf(res: SendResult) {
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error('expected a refusal');
  expect(Object.keys(res).sort()).toEqual(['ok', 'refused']);
  return res.refused;
}

describe('the chat route answers a filter refusal as reason and rule only', () => {
  it('link, personal_info and filter, each with the rule the owner chose', async () => {
    const w = await chatWorld({ filters: FILTERS });
    const a = w.attend(ROOM, 'plenk');
    const link = refusedOf(a.session.send({ text: 'see blorf.com now' }));
    expect(link).toEqual({ reason: 'link', rule: 4 });
    w.advance(10 * SEC);
    expect(refusedOf(a.session.send({ text: 'mail me at a@b.com' }))).toEqual({ reason: 'personal_info', rule: 2 });
    w.advance(10 * SEC);
    expect(refusedOf(a.session.send({ text: 'please buy gold now friend' }))).toEqual({ reason: 'filter', rule: 5 });
    w.advance(10 * SEC);
    expect(a.session.send({ text: 'a perfectly fine line' }).ok).toBe(true);
  });

  it('a ratio rule refuses as filter too', async () => {
    const w = await chatWorld({ filters: { ratio: { action: 'refuse', caps: { maxPercent: 60, minLetters: 8 } } } });
    const a = w.attend(ROOM, 'plenk');
    const r = refusedOf(a.session.send({ text: 'WHY IS EVERYONE SO SLOW TODAY' }));
    expect(r.reason).toBe('filter');
    expect(typeof r.rule).toBe('number');
  });

  it('never the matched text, a pattern, a counter key, a range or an identifier, in any refusal', async () => {
    const w = await chatWorld({ filters: FILTERS });
    const a = w.attend(ROOM, 'plenk');
    const answers: unknown[] = [];
    for (const text of ['see blorf.com now', 'a@b.com is mine', 'buy gold now please']) {
      answers.push(a.session.send({ text }));
      w.advance(10 * SEC);
    }
    const all = JSON.stringify(answers);
    for (const leak of ['blorf', 'a@b.com', 'buy gold', 'gold', 'link.unlisted', 'personal_info.email', 'phrase.', 'spans', 'start', 'raw-client-key', 'Gold ads']) expect(all, leak).not.toContain(leak);
    expect(all).not.toMatch(/s_[A-Za-z0-9_-]{22}|[0-9a-f]{32}/);
  });

  it('nothing is written to any stream or the room history for a refused line, and the other players hear nothing', async () => {
    const w = await chatWorld({ filters: FILTERS });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'quissel');
    refusedOf(a.session.send({ text: 'see blorf.com now' }));
    expect(b.heard.texts()).toEqual([]);
    expect(a.heard.texts()).toEqual([]);
    expect(JSON.stringify(w.logs)).not.toContain('plenk');
  });

  it('refusalOf passes the three new reasons through with the rule, and drops every other field of a hostile object', () => {
    for (const reason of ['link', 'personal_info', 'filter']) {
      expect(refusalOf({ reason, rule: 4, spans: [{ start: 1, end: 2 }], key: 'link.unlisted', pattern: 'x', hits: [] })).toEqual({ reason, rule: 4 });
    }
    expect(refusalOf({ reason: 'link' })).toEqual({ reason: 'link' });
  });
});

describe('mask and flag', () => {
  it('a masked line goes out starred to everyone, the author included, and the author is shown the delivered text', async () => {
    const w = await chatWorld({ filters: { personalInfo: { action: 'mask' } } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'quissel');
    const res = a.session.send({ text: 'my number is 555-010-9999 ok' });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('refused');
    expect(res.line.text).toBe('my number is ************ ok');
    expect(b.heard.texts()).toEqual(['my number is ************ ok']);
    expect(JSON.stringify(res)).not.toContain('555');
  });

  it('a flag delivers the line as typed and files one report with no reporter, a moderator reads it with reporterPerson null', async () => {
    const w = await chatWorld({ filters: { links: { action: 'flag' } } });
    const a = w.attend(ROOM, 'plenk');
    const b = w.attend(ROOM, 'quissel');
    const res = a.session.send({ text: 'see blorf.com now' });
    expect(res.ok).toBe(true);
    expect(b.heard.texts()).toEqual(['see blorf.com now']);
    await w.real.filters.stats({ days: 7 });
    const items = w.real.reports.list({ status: 'open' }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ origin: 'filter', originKey: 'link.unlisted', reporterPerson: null });
    // the player's side of the same line carries nothing about it
    expect(JSON.stringify(res)).not.toMatch(/report|filter|flag|link\./i);
    expect(JSON.stringify(b.heard.frames)).not.toMatch(/report|filter|flag/i);
  });

  it('a second flagged line while the first report is open files nothing more', async () => {
    const w = await chatWorld({ filters: { links: { action: 'flag' } } });
    const a = w.attend(ROOM, 'plenk');
    a.session.send({ text: 'see blorf.com now' });
    w.advance(10 * SEC);
    a.session.send({ text: 'and wibble.com too' });
    await w.real.filters.stats({ days: 7 });
    expect(w.real.reports.list({ status: 'open' }).items).toHaveLength(1);
  });

  it('with the filters off the answers are exactly as before: a link line is delivered untouched', async () => {
    const w = await chatWorld();
    const a = w.attend(ROOM, 'plenk');
    const res = a.session.send({ text: 'see blorf.com now' });
    expect(res.ok).toBe(true);
    expect(w.real.reports.list({}).items).toEqual([]);
  });
});

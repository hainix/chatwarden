import { describe, expect, it } from 'vitest';
import { chooseLines, redactReportNote } from '../../src/ai/lines.js';
import { mkReport, person } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

const others = (n: number, who = 'vlemmo'): LineSpec[] => Array.from({ length: n }, (_, i) => ({ who, text: `other line ${i}` }));
const mine = (n: number, prefix = 'mine'): LineSpec[] => Array.from({ length: n }, (_, i) => ({ who: 'target', text: `${prefix} ${i}` }));
const texts = (c: ReturnType<typeof chooseLines>) => c.lines.map((l) => l.text);
/** What the service would hand to an adapter: everything but the line ids (those stay server-side, as the map key). */
const sent = (c: ReturnType<typeof chooseLines>) =>
  JSON.stringify({ ...c, lines: c.lines.map((l) => ({ ref: l.ref, secondsIn: l.secondsIn, who: l.who, text: l.text, blocked: l.blocked })) });

describe('chooseLines: the cap and the choice', () => {
  it('keeps at most 40 lines', () => {
    const c = chooseLines(mkReport([...mine(30), ...others(70)]));
    expect(c.lines).toHaveLength(40);
    expect(c.truncated).toBe(true);
  });

  it('keeps everything when there are 40 or fewer', () => {
    const c = chooseLines(mkReport([...mine(10), ...others(30)]));
    expect(c.lines).toHaveLength(40);
    expect(c.truncated).toBe(false);
    expect(chooseLines(mkReport([])).lines).toEqual([]);
    expect(chooseLines(mkReport([])).truncated).toBe(false);
  });

  it("keeps all of the reported person's latest 20", () => {
    const c = chooseLines(mkReport([...mine(30), ...others(70)]));
    const t = texts(c);
    for (let i = 10; i < 30; i += 1) expect(t, `mine ${i}`).toContain(`mine ${i}`);
    for (let i = 0; i < 10; i += 1) expect(t, `mine ${i}`).not.toContain(`mine ${i}`);
    expect(c.lines.filter((l) => l.byReported)).toHaveLength(20);
  });

  it('keeps 12 before and 6 after the pointed-at line', () => {
    // One early line by the reported person, then 100 by someone else; the reporter points at line 50.
    const c = chooseLines(mkReport([...mine(1), ...others(100)], { point: 51 }));
    const t = texts(c);
    // Index 51 is "other line 50": 12 before (38..49) and 6 after (51..56).
    for (let i = 38; i <= 56; i += 1) expect(t, `other line ${i}`).toContain(`other line ${i}`);
    expect(t).toContain('mine 0');
    expect(t).not.toContain('other line 5');
    expect(c.lines).toHaveLength(40);
  });

  it('fills the rest with the nearest other lines', () => {
    const c = chooseLines(mkReport([...mine(1), ...others(100)], { point: 51 }));
    const t = texts(c);
    // 1 + 19 are fixed; the other 20 are the nearest to line 50: 18..37 are further than 57..76 on the right? Distance decides.
    const idx = (s: string) => Number(s.replace('other line ', ''));
    const chosen = t.filter((s) => s.startsWith('other line')).map(idx);
    const inWindow = (i: number) => i >= 38 && i <= 56;
    const extra = chosen.filter((i) => !inWindow(i));
    expect(extra).toHaveLength(20);
    // Every extra is at least as near to 50 as every line left out.
    const left = Array.from({ length: 100 }, (_, i) => i).filter((i) => !chosen.includes(i));
    const far = Math.max(...extra.map((i) => Math.abs(i - 50)));
    for (const i of left) expect(Math.abs(i - 50)).toBeGreaterThanOrEqual(far);
  });

  it('puts the lines in time order, with refs L1..Ln', () => {
    const lines = others(10).map((l, i) => ({ ...l, at: (10 - i) * 1000 })); // listed newest first
    const c = chooseLines(mkReport(lines));
    expect(c.lines.map((l) => l.ref)).toEqual(Array.from({ length: 10 }, (_, i) => `L${i + 1}`));
    expect(texts(c)[0]).toBe('other line 9');
    expect(texts(c)[9]).toBe('other line 0');
  });

  it('seconds are relative to the first chosen line', () => {
    const c = chooseLines(
      mkReport([
        { who: 'target', text: 'a', at: 5_000 },
        { who: 'target', text: 'b', at: 5_400 },
        { who: 'target', text: 'c', at: 8_000 },
        { who: 'target', text: 'd', at: 65_000 },
      ]),
    );
    expect(c.lines.map((l) => l.secondsIn)).toEqual([0, 0, 3, 60]);
  });

  it('keeps each chosen line id so an answer maps back, and nothing else identifying in the line', () => {
    const rep = mkReport([...mine(2), ...others(2)]);
    const c = chooseLines(rep);
    expect(c.lines.map((l) => l.lineId)).toEqual(rep.excerpt.map((l) => l.lineId));
    expect(Object.keys(c.lines[0] ?? {}).sort()).toEqual(['blocked', 'byReported', 'filtered', 'lineId', 'ref', 'secondsIn', 'text', 'who']);
  });

  it('honours opts.max and keeps the pointed-at line and the newest of the reported lines first', () => {
    const rep = mkReport([...mine(30), ...others(30)], { point: 45 });
    const c = chooseLines(rep, { max: 10 });
    expect(c.lines).toHaveLength(10);
    expect(c.reportedLine).not.toBeNull();
    expect(c.lines.some((l) => l.lineId === rep.lineId)).toBe(true);
    expect(texts(c)).toContain('mine 29');
    expect(texts(c)).not.toContain('mine 0');
    expect(c.truncated).toBe(true);
  });

  it('with no pointed-at line, fills with the lines nearest the latest reported one', () => {
    const rep = mkReport([...others(30), ...mine(2), ...others(30, 'drakkuun')]);
    const c = chooseLines(rep, { max: 6 });
    expect(texts(c)).toContain('mine 0');
    expect(texts(c)).toContain('mine 1');
    expect(c.lines).toHaveLength(6);
  });
});

describe('chooseLines: who can see what', () => {
  it('drops lines the reporter could not see', () => {
    const rep = mkReport([
      { who: 'vlemmo', text: 'public one' },
      { who: 'target', text: 'whisper to a friend', audience: ['target', 'vlemmo'] },
      { who: 'target', text: 'whisper to the reporter', audience: ['target', 'reporter'] },
      { who: 'target', text: 'nobody', audience: [] },
      { who: 'target', text: 'public two' },
    ]);
    const t = texts(chooseLines(rep));
    expect(t).toEqual(['public one', 'whisper to the reporter', 'public two']);
  });

  it('a hidden line does not count as truncation', () => {
    const rep = mkReport([...others(5), { who: 'target', text: 'secret', audience: ['vlemmo'] }]);
    const c = chooseLines(rep);
    expect(c.truncated).toBe(false);
    expect(c.lines).toHaveLength(5);
  });

  it('a pointed-at line the reporter could not see gives a null reportedLine', () => {
    const rep = mkReport([...others(3), { who: 'target', text: 'secret', audience: ['vlemmo'] }, ...others(2)], { point: 3 });
    expect(chooseLines(rep).reportedLine).toBeNull();
  });

  it('a hidden line does not leak its text into the people list or the lines', () => {
    const rep = mkReport([{ who: 'target', text: 'hello' }, { who: 'snerp', text: 'psst tarvo', audience: ['snerp', 'target'] }]);
    const c = chooseLines(rep);
    expect(sent(c)).not.toContain('psst');
    expect(c.people.map((p) => p.alias)).not.toContain('P3');
  });
});

describe('chooseLines: aliases and refs', () => {
  it('the reported person is P1 and the reporter P2 even when the reporter spoke first', () => {
    const rep = mkReport([
      { who: 'reporter', text: 'you started it' },
      { who: 'vlemmo', text: 'lol' },
      { who: 'target', text: 'no I did not' },
    ]);
    const c = chooseLines(rep);
    expect(c.lines.map((l) => l.who)).toEqual(['P2', 'P3', 'P1']);
    expect(c.people).toEqual([
      { alias: 'P1', role: 'reported' },
      { alias: 'P2', role: 'reporter' },
      { alias: 'P3', role: 'other' },
    ]);
  });

  it('others are P3... by first appearance', () => {
    const rep = mkReport([
      { who: 'snerp', text: 'a' },
      { who: 'glarn', text: 'b' },
      { who: 'snerp', text: 'c' },
      { who: 'fenrisk', text: 'd' },
    ]);
    const c = chooseLines(rep);
    expect(c.lines.map((l) => l.who)).toEqual(['P3', 'P4', 'P3', 'P5']);
    expect(c.people.map((p) => p.alias)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5']);
  });

  it('a line with no subject is attributed by seat', () => {
    const rep = mkReport([
      { who: 'target', text: 'a', noSubject: true },
      { who: 'reporter', text: 'b', noSubject: true },
      { who: 'snerp', text: 'c', noSubject: true },
      { who: 'snerp', text: 'd', noSubject: true },
    ]);
    const c = chooseLines(rep);
    expect(c.lines.map((l) => l.who)).toEqual(['P1', 'P2', 'P3', 'P3']);
    expect(c.lines.map((l) => l.byReported)).toEqual([true, false, false, false]);
  });

  it('lists P1 and P2 even when neither spoke in the chosen lines', () => {
    const c = chooseLines(mkReport(others(3)));
    expect(c.people.slice(0, 2)).toEqual([
      { alias: 'P1', role: 'reported' },
      { alias: 'P2', role: 'reporter' },
    ]);
  });

  it('refs and aliases are stable for the same report', () => {
    const rep = mkReport([...mine(25), ...others(40), ...others(10, 'snerp')], { point: 40 });
    const a = chooseLines(rep);
    const b = chooseLines(structuredClone(rep));
    expect(b).toEqual(a);
    // Shuffling nothing: the same report with its excerpt reversed in storage chooses the same lines.
    const rev = { ...rep, excerpt: [...rep.excerpt].reverse() };
    expect(chooseLines(rev).lines.map((l) => l.lineId)).toEqual(a.lines.map((l) => l.lineId));
    expect(chooseLines(rev).lines.map((l) => l.who)).toEqual(a.lines.map((l) => l.who));
  });

  it('byReported marks the reported person', () => {
    const c = chooseLines(mkReport([{ who: 'target', text: 'x' }, { who: 'reporter', text: 'y' }, { who: 'snerp', text: 'z' }]));
    expect(c.lines.map((l) => [l.who, l.byReported])).toEqual([['P1', true], ['P2', false], ['P3', false]]);
  });
});

describe('chooseLines: text', () => {
  it('maps the pointed-at line to its ref', () => {
    const rep = mkReport([...others(5), ...mine(1), ...others(5)], { point: 5 });
    const c = chooseLines(rep);
    const ref = c.lines.find((l) => l.text === 'mine 0')?.ref;
    expect(c.reportedLine).toBe(ref);
    expect(chooseLines(mkReport(others(3))).reportedLine).toBeNull();
    expect(chooseLines(mkReport(others(3), { point: 99 })).reportedLine).toBeNull();
  });

  it('sends the raw text of a blocked line, flagged blocked', () => {
    const rep = mkReport([{ who: 'target', text: 'you are a zorbak', blocked: true }, { who: 'target', text: 'sorry' }]);
    const c = chooseLines(rep);
    expect(c.lines[0]).toMatchObject({ text: 'you are a zorbak', blocked: true });
    expect(c.lines[1]).toMatchObject({ text: 'sorry', blocked: false });
  });

  it('sends what was typed, not the star-masked delivery', () => {
    const rep = mkReport([{ who: 'target', text: 'you glarn', delivered: 'you *****' }]);
    expect(chooseLines(rep).lines[0]?.text).toBe('you glarn');
  });

  it('redacts handles, personal data and odd characters in the text', () => {
    const t = person('target');
    const r = person('reporter');
    const rep = mkReport([
      { who: 'snerp', text: `hey ${t.handle}\u200B, I will find you at 10.1.2.3 or ${r.handle} call 555-123-4567` },
      { who: 'target', text: `@${r.handle} mail me zorbak@example.com` },
    ]);
    const c = chooseLines(rep);
    expect(texts(c)).toEqual(['hey P1, I will find you at [ip] or P2 call [phone]', '@P2 mail me [email]']);
  });

  it('redacts the handle of a person who has no chosen line', () => {
    const rep = mkReport([{ who: 'target', text: 'did snerp_handle do that' }, ...others(60, 'vlemmo'), { who: 'snerp', text: 'x' }]);
    const c = chooseLines(rep, { max: 5 });
    expect(sent(c)).not.toContain('snerp_handle');
  });

  it('redacts a seat id and a subject id typed into chat', () => {
    const t = person('target');
    const rep = mkReport([{ who: 'snerp', text: `it was ${t.seat} / ${t.subject}` }, { who: 'target', text: 'hi' }]);
    const out = sent(chooseLines(rep));
    expect(out).not.toContain(t.seat);
    expect(out).not.toContain(t.subject);
  });
});

describe('redactReportNote', () => {
  it('uses the same aliases as the lines and cuts at 300', () => {
    const t = person('target');
    const rep = mkReport([{ who: 'target', text: 'x' }, { who: 'snerp', text: 'y' }], { note: `${t.handle} and snerp_handle keep at it, mail a@b.co ` + 'z'.repeat(400) });
    const note = redactReportNote(rep) ?? '';
    expect(note.startsWith('P1 and P3 keep at it, mail [email] ')).toBe(true);
    expect([...note]).toHaveLength(300);
  });

  it('is null without a note', () => {
    expect(redactReportNote(mkReport(others(2)))).toBeNull();
    expect(redactReportNote(mkReport(others(2), { note: '   ' }))).toBeNull();
  });
});

describe('chooseLines: a generated-report fuzz', () => {
  // A small seeded generator, so a failure is reproducible.
  const mulberry = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const word = (rnd: () => number, n: number) => Array.from({ length: n }, () => 'bcdfghjklmnpqrstvwxz'[Math.floor(rnd() * 20)]).join('');

  it('no subject id, handle, seat id or ip string survives in any chosen line', () => {
    for (let seed = 1; seed <= 60; seed += 1) {
      const rnd = mulberry(seed);
      const names = Array.from({ length: 4 }, () => word(rnd, 5 + Math.floor(rnd() * 6)));
      const ips = Array.from({ length: 3 }, () => `${1 + Math.floor(rnd() * 254)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${1 + Math.floor(rnd() * 254)}`);
      const lines: LineSpec[] = Array.from({ length: 30 + Math.floor(rnd() * 80) }, (_, i) => {
        const who = i % 3 === 0 ? 'target' : i % 3 === 1 ? 'reporter' : names[Math.floor(rnd() * names.length)] ?? 'x';
        const n = names[Math.floor(rnd() * names.length)] ?? '';
        const ip = ips[Math.floor(rnd() * ips.length)] ?? '';
        const forms = [
          `hey ${n} you there`,
          `@${person(who).handle} look at ${ip}`,
          `${person('target').handle.toUpperCase()} is bad, ${ip}`,
          `${person('reporter').seat} ${person('target').subject}`,
          `${person(names[0] ?? 'x').handle}!!`,
          'plain chatter',
        ];
        return { who, text: forms[Math.floor(rnd() * forms.length)] ?? '' };
      });
      const rep = mkReport(lines, { point: Math.floor(rnd() * lines.length) });
      const c = chooseLines(rep);
      const blob = sent(c);
      const secrets = [
        ...rep.excerpt.flatMap((l) => [l.seatId, l.handle]),
        rep.reporterSubject, rep.targetSubject, rep.reporterSeat, rep.targetSeat, rep.reporterHandle, rep.targetHandle,
        ...rep.people, ...ips,
        ...names.map((n) => person(n).handle),
      ];
      for (const s of secrets) {
        if (s.length >= 3) expect(blob.toLowerCase(), `seed ${seed}: ${s}`).not.toContain(s.toLowerCase());
      }
      for (const l of c.lines) expect(l.text.toLowerCase()).not.toContain('seat-');
    }
  });
});

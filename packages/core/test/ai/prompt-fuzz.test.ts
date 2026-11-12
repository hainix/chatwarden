import { describe, expect, it } from 'vitest';
import { chooseLines } from '../../src/ai/lines.js';
import { buildAIInput } from '../../src/ai/prompt.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { mkReport, person } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

// M6: seeded, deterministic generated reports, run through the whole prompt builder. No identifier string may appear anywhere in what
// an adapter is handed: the stable part, the variable part and every structured field.

// 150 seeds cover every generator branch many times over (300 took 4.4 s on an idle machine); the seeds stay fixed, so a failure repeats.
const SEEDS = 150;
const policy = { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) };

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ALPHA = 'bcdfghjklmnpqrstvwxz';
const word = (rnd: () => number, n: number): string => Array.from({ length: n }, () => ALPHA[Math.floor(rnd() * ALPHA.length)]).join('');

describe('the rendered prompt carries no identifier (generated reports)', () => {
  it('150 seeded reports: ids, handles, seats, rooms, tags, ips, invite codes', () => {
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rnd = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
      const names = Array.from({ length: 4 }, () => word(rnd, 5 + Math.floor(rnd() * 6)));
      const ips = Array.from({ length: 3 }, () => [1 + Math.floor(rnd() * 254), Math.floor(rnd() * 255), Math.floor(rnd() * 255), 1 + Math.floor(rnd() * 254)].join('.'));
      const invite = word(rnd, 8);
      const tagValue = 'tag' + word(rnd, 9);
      const hidden = 'hidden' + word(rnd, 5);
      const t = person('target');
      const r = person('reporter');
      const specs: LineSpec[] = Array.from({ length: 20 + Math.floor(rnd() * 90) }, (_, i) => {
        const who = i % 3 === 0 ? 'target' : i % 3 === 1 ? 'reporter' : pick(names);
        const forms = [
          'hey ' + person(pick(names)).handle + ' you there',
          '@' + person(who).handle + ' look at ' + pick(ips),
          t.handle.toUpperCase() + ' is bad, ' + pick(ips),
          r.seat + ' ' + t.subject,
          'join discord.gg/' + invite + ' now',
          'come to https://' + word(rnd, 6) + '.example/' + invite,
          'tell ' + hidden + '_handle hi',
          'plain chatter',
        ];
        return { who, text: pick(forms), blocked: rnd() < 0.1, ...(rnd() < 0.1 ? { delivered: '****' } : {}) };
      });
      specs.push({ who: hidden, text: 'psst', audience: [hidden, 'target'] });
      const report = mkReport(specs, { point: Math.floor(rnd() * specs.length), note: person(pick(names)).handle + ' from ' + pick(ips) + ' / ' + t.seat, reason: 'harassment', tags: { mode: tagValue }, id: 'rep' + word(rnd, 6) });
      const chosen = chooseLines(report);
      const input = buildAIInput({ policy, reason: { id: 'harassment', label: 'Harassment' }, chosen });
      const rendered = (input.prompt.stable + '\n' + input.prompt.variable + '\n' + JSON.stringify({ ...input, prompt: undefined })).toLowerCase();
      const secrets = [
        ...report.excerpt.flatMap((l) => [l.seatId, l.handle]),
        report.reporterSubject, report.targetSubject, report.reporterSeat, report.targetSeat, report.reporterHandle, report.targetHandle,
        ...report.people, ...ips, invite, tagValue, report.roomId, report.id, hidden + '_handle',
        // A name nobody in the room used is a stranger: its handle cannot be known, so it is not a secret.
        ...names.filter((n) => specs.some((sp) => sp.who === n)).map((n) => person(n).handle),
      ];
      for (const s of secrets) {
        if (s.length >= 3) expect(rendered.includes(s.toLowerCase()), 'seed ' + seed + ': ' + s).toBe(false);
      }
      expect(rendered.includes('psst'), 'seed ' + seed + ' hidden line').toBe(false);
      expect(rendered.includes('line-'), 'seed ' + seed + ' line id').toBe(false);
    }
    // About 2 s alone and several times that when the machine is busy: an explicit ceiling, not the 5 s default.
  }, 20_000);
});

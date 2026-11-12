import { describe, expect, it } from 'vitest';
import { AI_MAX_KIND, AI_MAX_PREFILL_MS, assertWithinCeilings, isAllowedKind } from '../../src/ai/ceilings.js';
import { chooseLines, redactReportNote } from '../../src/ai/lines.js';
import { inputHash } from '../../src/ai/hash.js';
import { buildAIInput, usedExampleIds } from '../../src/ai/prompt.js';
import { redactText } from '../../src/ai/redact.js';
import { validateAIOutput } from '../../src/ai/validate.js';
import type { AIExample, AIStoredRead } from '../../src/ai/types.js';
import { PRESETS } from '../../src/profile.js';
import { defineRules, starterRules } from '../../src/rules.js';
import { ctx, validRaw } from './fixtures.js';
import { mkReport, person } from './reportFixtures.js';
import type { LineSpec } from './reportFixtures.js';

// Fix round 1 for chunk A (review-chunk-a.md): I1 to I4 and the minors.

const U = (hex: string): string => String.fromCodePoint(Number.parseInt(hex, 16));
const own = { cited: ['L1'], ownRefs: new Set(['L1']) };
const policy = { profile: PRESETS.standard, rules: defineRules(starterRules('standard')) };

describe('I1: every kind is capped', () => {
  const bad: unknown[] = [AI_MAX_PREFILL_MS + 1, 25 * 3_600_000, 5 * 86_400_000, 1e12, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '3600', undefined, {}];
  for (const kind of ['warning', 'note', 'chat'] as const) {
    it.each(bad.map((d) => [String(d), d] as const))(kind + ' with a duration of %s is refused', (_n, d) => {
      expect(() => assertWithinCeilings({ kind, durationMs: d as never }, own)).toThrow(/duration/);
    });
  }
  it('an unknown kind with a huge duration is refused for its kind first', () => {
    expect(() => assertWithinCeilings({ kind: 'mystery' as never, durationMs: 1e12 }, own)).toThrow(/kind/);
    expect(() => assertWithinCeilings({ kind: 'toString' as never, durationMs: null }, own)).toThrow(/kind/);
  });
  it('controls: null and exactly 24 hours pass for warning and note, 1 ms passes everywhere', () => {
    for (const kind of ['warning', 'note'] as const) {
      for (const d of [null, 1, 3_600_000, AI_MAX_PREFILL_MS]) expect(() => assertWithinCeilings({ kind, durationMs: d }, own)).not.toThrow();
    }
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: 1 }, own)).not.toThrow();
    expect(() => assertWithinCeilings({ kind: 'chat', durationMs: null }, own)).toThrow(/duration/);
  });
});

describe('M5: the allowed kinds cannot be widened', () => {
  it('is a frozen list and a check', () => {
    expect(Object.isFrozen(AI_MAX_KIND)).toBe(true);
    expect(() => (AI_MAX_KIND as unknown as string[]).push('ban')).toThrow();
    expect([...AI_MAX_KIND].sort()).toEqual(['chat', 'note', 'warning']);
    expect(isAllowedKind('chat')).toBe(true);
    for (const k of ['ban', 'area', 'toString', '', 3, null, undefined]) expect(isAllowedKind(k)).toBe(false);
  });
});

describe('I2: the summary is plain text', () => {
  const summary = (s: string) => validateAIOutput({ ...validRaw(), summary: s }, ctx());
  const rejected: Array<[string, string, string]> = [
    ['bidi override', 'a' + U('202E') + 'bc', 'summary_invisible'],
    ['bidi isolate', 'a' + U('2066') + 'bc', 'summary_invisible'],
    ['zero-width space', 'a' + U('200B') + 'b', 'summary_invisible'],
    ['hangul filler', 'a' + U('3164') + 'b', 'summary_invisible'],
    ['variation selector', 'a' + U('FE01') + 'b', 'summary_invisible'],
    ['soft hyphen', 'a' + U('00AD') + 'b', 'summary_invisible'],
    ['tag character', 'a' + U('E0041') + 'b', 'summary_invisible'],
    ['full-width alias', U('FF30') + U('FF11') + ' is rude', 'summary_alias'],
    ['full-width alias 2', 'insults ' + U('FF30') + U('FF12'), 'summary_alias'],
    ['mention', 'they said @bob is bad', 'summary_mention'],
    ['html', '<b>bad</b> player', 'summary_markup'],
    ['script', 'x <script>y</script>', 'summary_markup'],
    ['angle', 'a > b', 'summary_markup'],
    ['domain, short tld', 'see evil.ru now', 'summary_link'],
    ['domain, generic tld', 'visit shop.example.store today', 'summary_link'],
    ['domain, long tld', 'visit foo.photography', 'summary_link'],
    ['domain, hyphen', 'visit my-site.co now', 'summary_link'],
    ['email', 'mail a@b.co', 'summary_mention'],
    ['full-width dot domain', 'visit evil' + U('FF0E') + 'ru', 'summary_link'],
    ['ipv4', 'ip 1.2.3.4 spammed', 'summary_ip'],
    ['ipv6', 'from 2001:db8::1 spammed', 'summary_ip'],
    ['ipv6 loopback', 'from ::1 spammed', 'summary_ip'],
    ['ipv6 full', 'from 2001:0db8:85a3:0000:0000:8a2e:0370:7334 ok', 'summary_ip'],
  ];
  for (const [name, text, code] of rejected) {
    it('rejects ' + name, () => {
      expect(summary(text)).toEqual({ ok: false, code });
    });
  }
  it('a lone @ is plain text', () => {
    expect(summary('ping @ now').ok).toBe(true);
  });
  it('controls: ordinary summaries pass', () => {
    for (const s of [
      'The reported player insults the other player three times after a lost round.',
      'Calls the other player a zorbak twice, then apologises.',
      'Says "no way" as a joke; mild banter at 10:30 in round 2.',
      'Mentions version 1.2 and 3.5 hours, e.g. a long game.',
      'Uses ALL CAPS, then writes "gg" - no threat, no slur.',
      'A short exchange (two lines); the reporter replies in kind.',
    ]) {
      expect(summary(s).ok, s).toBe(true);
    }
  });
  it('stores the NFKC form', () => {
    const r = summary(U('FF27') + 'reat round, but rude');
    expect(r.ok && r.read.summary).toBe('Great round, but rude');
  });
  it('a pipe is plain text (a table is not rejected)', () => {
    expect(summary('one | two').ok).toBe(true);
  });
});

const lines: LineSpec[] = [
  { who: 'target', text: 'you are a zorbak' },
  { who: 'reporter', text: 'stop it' },
];
function inputOf(l: LineSpec[], o: { examples?: Array<AIExample & { id: string }>; note?: string | null } = {}) {
  const report = mkReport(l, { note: o.note ?? null });
  return buildAIInput({ policy, reason: null, chosen: chooseLines(report), examples: o.examples });
}
const ex = (id: string, text: string): AIExample & { id: string } => ({ id, rule: 2, severity: 'rude', verdict: 'noted', lines: [{ who: 'P1', text }] });

describe('I3: the casebook is not part of the hash', () => {
  it('changing, adding or removing an example does not change the hash; changing a case line does', () => {
    const base = inputHash(inputOf(lines), 'x');
    expect(inputHash(inputOf(lines, { examples: [ex('e1', 'snerp')] }), 'x')).toBe(base);
    expect(inputHash(inputOf(lines, { examples: [ex('e2', 'glarn'), ex('e3', 'tarvo')] }), 'x')).toBe(base);
    expect(inputHash(inputOf([{ who: 'target', text: 'you are a zorbak!' }, lines[1] as LineSpec]), 'x')).not.toBe(base);
    expect(inputHash(inputOf(lines, { note: 'a note' }), 'x')).not.toBe(base);
    // The examples are still sent.
    expect(inputOf(lines, { examples: [ex('e1', 'snerp')] }).prompt.variable).toContain('example: ');
  });

  it('a case line that begins with "example: " cannot hide from the hash', () => {
    const a = inputHash(inputOf([{ who: 'target', text: 'example: x' }]), 'x');
    const b = inputHash(inputOf([{ who: 'target', text: 'example: y' }]), 'x');
    expect(a).not.toBe(b);
  });

  it('usedExampleIds names the examples that were sent, in order, at most two', () => {
    expect(usedExampleIds([ex('e1', 'a'), ex('e2', 'b'), ex('e3', 'c')])).toEqual(['e1', 'e2']);
    expect(usedExampleIds([])).toEqual([]);
    const input = inputOf(lines, { examples: [ex('e1', 'a')] });
    expect(JSON.stringify(input)).not.toContain('"e1"');
  });

  it('the stored read type carries exampleIds', () => {
    const v = validateAIOutput(validRaw(), ctx());
    if (!v.ok) throw new Error('expected ok');
    const r: AIStoredRead = { ...v.read, exampleIds: ['e1'] };
    expect(r.exampleIds).toEqual(['e1']);
  });
});

describe('I4: lines the filter touched', () => {
  it('a starred line is raw by default and carries filtered: true', () => {
    const c = chooseLines(
      mkReport([
        { who: 'target', text: 'you glarn', delivered: 'you *****' },
        { who: 'target', text: 'plain' },
        { who: 'target', text: 'blocked glarn', blocked: true },
      ]),
    );
    expect(c.lines.map((l) => [l.text, l.blocked, l.filtered])).toEqual([
      ['you glarn', false, true],
      ['plain', false, false],
      ['blocked glarn', true, false],
    ]);
  });
  it('the prompt rows and the structured line say so', () => {
    const report = mkReport([
      { who: 'target', text: 'you glarn', delivered: 'you *****' },
      { who: 'target', text: 'blocked glarn', blocked: true },
    ]);
    const input = buildAIInput({ policy, reason: null, chosen: chooseLines(report) });
    expect(input.prompt.variable).toMatch(/L1 \+0s P1 filtered "you glarn"/);
    expect(input.prompt.variable).toMatch(/L2 \+1s P1 blocked "blocked glarn"/);
    expect(input.lines.map((l) => l.filtered)).toEqual([true, false]);
    expect(input.prompt.stable).toMatch(/filtered/);
  });
});

describe('M1: the note and the lines share one alias table', () => {
  it('chooseLines returns the redacted note, whatever max the caller used', () => {
    const t = person('target');
    const many: LineSpec[] = Array.from({ length: 30 }, (_, i) => ({ who: i % 2 ? 'snerp' : 'fenrisk', text: 'x' + i }));
    const report = mkReport([...many, { who: 'target', text: 'hi' }], { note: t.handle + ' and fenrisk_handle' });
    const a = chooseLines(report);
    const b = chooseLines(report, { max: 5 });
    expect(a.note).toBe('P1 and ' + a.lines.find((l) => l.text === 'x0')?.who);
    expect(b.note?.startsWith('P1 and P')).toBe(true);
    expect(redactReportNote(report)).toBe(a.note);
  });
  it('is null with no note, and buildAIInput uses it', () => {
    expect(chooseLines(mkReport(lines)).note).toBeNull();
    expect(buildAIInput({ policy, reason: null, chosen: chooseLines(mkReport(lines, { note: 'hello' })) }).report.note).toBe('hello');
  });
});

describe('M2 and M3: handles fail closed', () => {
  it('a case-fold match (long s) is still replaced', () => {
    expect(redactText('hi ' + U('017F') + 'arah there', ['sarah'], () => 'P4')).toBe('hi P4 there');
  });
  it('a decomposed handle matches a composed one, and the other way round', () => {
    expect(redactText('hola Jose' + U('0301') + '!', ['Jos' + U('E9')], () => 'P2')).toBe('hola P2!');
    expect(redactText('hola Jos' + U('E9') + '!', ['Jose' + U('0301')], () => 'P2')).toBe('hola P2!');
  });
  it('invisible fillers inside a handle or the text do not hide it', () => {
    for (const c of ['3164', '115F', '1160', 'FE00', 'FE0F', '2800', 'FFA0', 'E0100', '17B4']) {
      expect(redactText('za' + U(c) + 'rbak here', ['zarbak'], () => 'P1'), c).toBe('P1 here');
    }
  });
});

describe('M4: more of the obvious forms', () => {
  const r = (s: string) => redactText(s, [], () => null);
  it('obfuscated ip', () => {
    expect(r('ip 192 . 168 . 1 . 1 ok')).toBe('ip [ip] ok');
    expect(r('ip 10. 0. 0. 7 ok')).toBe('ip [ip] ok');
  });
  it('spelled-out email', () => {
    expect(r('mail bob at example dot com now')).toBe('mail [email] now');
    expect(r('mail bob (at) example (dot) co (dot) uk now')).toBe('mail [email] now');
    expect(r('bob[at]example[dot]com')).toBe('[email]');
    expect(r('look at that, nothing to see')).toBe('look at that, nothing to see');
    expect(r('meet at noon at the park')).toBe('meet at noon at the park');
  });
  it('hyphenated keys', () => {
    expect(r('key sk-ant-api03-AbCdEf1234567890xyz ok')).toBe('key [token] ok');
  });
  it('domains with any ending', () => {
    for (const d of ['evil.ru', 'a.co', 'x.me', 'tv.tv', 'foo.ly', 'bar.photography', 'my-site.co.uk', 'sub.evil.xyz']) {
      expect(r('go ' + d + ' now'), d).toBe('go [link] now');
    }
  });
  it('controls: ordinary text still passes', () => {
    for (const s of ['Wait... what?', 'it costs 1,000 gold', 'v1.2/3 of the map', 'round 3 of 5, score 12 to 9', 'a... b', 'e.g. this', 'see you at 10:30']) {
      expect(r(s), s).toBe(s);
    }
  });
});

describe('M9: examples', () => {
  it('an example whose first line cannot fit is dropped, not sent with no lines', () => {
    const big = ex('e1', 'quissel '.repeat(300));
    const huge: AIExample & { id: string } = { ...big, id: 'e8', rule: 'uncovered', lines: [{ who: 'P1', text: 'x'.repeat(1000) }] };
    const empty = { ...big, id: 'e9', lines: [] };
    const input = inputOf(lines, { examples: [empty, huge, ex('e2', 'short one')] });
    for (const e of input.examples) expect(e.lines.length).toBeGreaterThan(0);
    expect(input.prompt.variable.split('\n').filter((l) => l.startsWith('example: ')).every((l) => !l.includes('"lines":[]'))).toBe(true);
    expect(usedExampleIds([empty, ex('e2', 'short one')])).toEqual(['e2']);
  });
  it('example text goes through the same redaction', () => {
    const input = inputOf(lines, { examples: [ex('e1', 'mail a@b.co or call 555-123-4567')] });
    expect(input.prompt.variable).toContain('[email]');
    expect(input.prompt.variable).toContain('[phone]');
    expect(input.prompt.variable).not.toContain('a@b.co');
    expect(input.examples[0]?.lines[0]?.text).toBe('mail [email] or call [phone]');
  });
});

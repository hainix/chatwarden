import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { createChatwarden } from '../src/chatwarden.js';
import { ExcerptError, NoticeService } from '../src/notices.js';
import { CommunityRules, STARTER_RULES } from '../src/rules.js';
import { SubjectIndex } from '../src/subjects.js';
import type { Logger, Matcher, RawWho, ReportExcerptLine, SubjectId } from '../src/types.js';

// NoticeService.lineText (0.2.0): the text a player is shown for one excerpt line. It is the per-line step `createForSanction` stores, so a
// staff screen that previews a notice reads exactly what the player will read. Synthetic terms only.

const NOW = Date.UTC(2027, 0, 15, 12, 0, 0);

const fakeMatcher: Matcher = {
  match: (t) => (/zorbak|vlemmo/i.test(t) ? { termId: 'syn' } : null),
  spans: (t) => {
    const out: Array<{ start: number; end: number; termId: string }> = [];
    for (const m of t.matchAll(/zorbak|vlemmo/gi)) out.push({ start: m.index, end: m.index + m[0].length, termId: 'syn' });
    return out;
  },
};

function setup(opts: { matcher?: Matcher } = {}) {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const logs: Array<{ event: string; detail?: Record<string, string | number | boolean> }> = [];
  const logger: Logger = { warn: (event, detail) => void logs.push({ event, detail }) };
  const svc = new NoticeService({
    store,
    subjects,
    rules: new CommunityRules(STARTER_RULES),
    clock,
    matcher: 'matcher' in opts ? opts.matcher : fakeMatcher,
    logger,
    notify: (() => undefined) as never,
  });
  const person = (key: string): SubjectId => subjects.resolve({ clientKey: key, accountId: null, ipHash: null }) as SubjectId;
  return { store, svc, logs, person };
}

const line = (over: Partial<ReportExcerptLine> = {}): ReportExcerptLine => ({
  lineId: 'L1',
  ts: Date.UTC(2027, 0, 14, 23, 59, 59),
  seatId: 'seat-secret',
  handle: 'HandleSecret',
  raw: 'hello there',
  delivered: 'hello there',
  blocked: false,
  audience: null,
  p: 0,
  ...over,
});

const group = (subject: SubjectId) => ({ groupId: 'g1', refCode: 'M-AB1CD', kind: 'chat' as const, until: NOW + 86_400_000, rule: 2 as number, subject });

/** Every case: the line, and the matcher it is read with. */
const CASES: Array<[string, ReportExcerptLine, Matcher | undefined, string]> = [
  ['a delivered line', line({ raw: 'raw words', delivered: 'delivered words' }), fakeMatcher, 'delivered words'],
  ['a delivered line with starring', line({ raw: 'what the heck', delivered: 'what the h***' }), fakeMatcher, 'what the h***'],
  ['a blocked line with spans: only the matched terms starred', line({ raw: 'you zorbak and vlemmo', delivered: null, blocked: true }), fakeMatcher, 'you ****** and ******'],
  ['a blocked line is never given its delivered text', line({ raw: 'you zorbak', delivered: 'you zorbak', blocked: true }), fakeMatcher, 'you ******'],
  ['a blocked line, no matcher at all: all stars', line({ raw: 'you zorbak', delivered: null, blocked: true }), undefined, '**********'],
  ['a blocked line, a matcher with no spans: all stars', line({ raw: 'you zorbak', delivered: null, blocked: true }), { match: fakeMatcher.match }, '**********'],
  ['a blocked line the matcher does not recognise: all stars', line({ raw: 'you glarn', delivered: null, blocked: true }), fakeMatcher, '*********'],
  ['a blocked line with a throwing matcher: all stars', line({ raw: 'you zorbak', delivered: null, blocked: true }), { match: () => null, spans: () => { throw new Error('boom'); } }, '**********'],
  ['a blocked line with a matcher that returns junk: all stars', line({ raw: 'you zorbak', delivered: null, blocked: true }), { match: () => null, spans: (() => 'nope') as never }, '**********'],
  ['a line that is not blocked and has no delivered text: all stars, never raw', line({ raw: 'you zorbak', delivered: null, blocked: false }), fakeMatcher, 'you ******'],
  ['an empty raw line', line({ raw: '', delivered: null, blocked: true }), fakeMatcher, ''],
];

describe('lineText equals the text createForSanction stores for the same line', () => {
  it.each(CASES)('%s', (_name, l, matcher, expected) => {
    const t = setup({ matcher });
    expect(t.svc.lineText(l)).toBe(expected);
    const a = t.person('ka');
    t.svc.createForSanction(group(a), [l]);
    expect(t.svc.pending(a)[0]?.excerpt[0]?.text).toBe(expected);
    expect(t.svc.lineText(l)).toBe(t.svc.pending(a)[0]?.excerpt[0]?.text);
  });

  it('a blocked line never shows a matched term, whatever the matcher answers', () => {
    for (const [, l, matcher] of CASES) {
      if (!l.blocked) continue;
      const out = setup({ matcher }).svc.lineText(l);
      expect(out).not.toMatch(/zorbak|vlemmo/i);
    }
  });

  it('a throwing matcher is logged by class only, with no text', () => {
    const t = setup({ matcher: { match: () => null, spans: () => { throw new Error('boom'); } } });
    t.svc.lineText(line({ raw: 'you zorbak', delivered: null, blocked: true }));
    expect(t.logs.map((l) => l.event)).toContain('notices.mask_failed');
    expect(JSON.stringify(t.logs)).not.toMatch(/zorbak|boom/);
  });

  it('a line with no usable raw text is refused, as createForSanction refuses it', () => {
    const t = setup();
    expect(() => t.svc.lineText(line({ raw: 5 as never }))).toThrow(ExcerptError);
    expect(() => t.svc.lineText(null as never)).toThrow(ExcerptError);
  });

  it('createForSanction still refuses a bad time and too many lines', () => {
    const t = setup();
    const a = t.person('ka');
    expect(() => t.svc.createForSanction(group(a), [line({ ts: Number.NaN })])).toThrow(ExcerptError);
    expect(() => t.svc.createForSanction(group(a), Array.from({ length: 6 }, () => line()))).toThrow(ExcerptError);
  });
});

describe('cw.notices.lineText is the staff side', () => {
  it('the facade carries it, reading the kit matcher', async () => {
    const cw = await createChatwarden({
      store: new MemoryStore(),
      secret: 'linetext-secret',
      platform: { identify: (ctx) => ctx as RawWho },
      matcher: fakeMatcher,
      retention: false,
    });
    expect(cw.notices.lineText(line({ raw: 'you zorbak', delivered: null, blocked: true }))).toBe('you ******');
    expect(cw.notices.lineText(line({ raw: 'hi', delivered: 'hi' }))).toBe('hi');
  });
});

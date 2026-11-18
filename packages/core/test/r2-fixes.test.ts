import { MemoryStore } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import { codeOfConduct } from '../src/documents.js';
import type { DocumentPolicy } from '../src/documents.js';
import { suggest } from '../src/ladder.js';
import { noticeView, NOTICE_WORDS } from '../src/noticeCopy.js';
import { buildDeliveryContent, noticeWordsFor } from '../src/noticeLocales.js';
import type { NoticeDelivery } from '../src/delivery.js';
import { resolveProfile } from '../src/profile.js';
import { defineRules, starterRules } from '../src/rules.js';
import { appealsKit } from './appealsWorld.js';
import { world } from './reportingWorld.js';

// Review R2 fixes in core (0.2.2): I3 the delivery email follows the evidence kind, M1 a 0.2.2 server accepts chat lines on a play or name decision (stored, kind and words
// unchanged), M3 the code of conduct says what really comes first, M4 the suggestion carries no unused `rename` field.

const NOW = 1_800_000_000_000;
const nv = (n: Parameters<typeof noticeView>[0]) => noticeView(n, { words: NOTICE_WORDS, locale: 'en', now: () => 0 });

describe('I3: the delivery email follows the evidence kind', () => {
  const content = (locale: string, evidence?: 'chat' | 'play' | 'name', kind: 'warning' | 'chat' = 'warning', words: Readonly<Record<string, string>> = noticeWordsFor(locale).words) =>
    buildDeliveryContent({
      words,
      locale,
      kind: 'sanction',
      notice: { kind, rule: 2, ruleLabel: 'CR 2', until: kind === 'warning' ? null : NOW + 3_600_000, refCode: 'M-ABCDE', createdAt: NOW, ...(evidence === undefined ? {} : { evidence }) },
      appealUrl: null,
    });
  const SAYS: Array<[string, 'chat' | 'play' | 'name' | undefined, string]> = [
    ['en', 'chat', 'for something you wrote'],
    ['en', 'play', 'for how you played'],
    ['en', 'name', 'about your name'],
    ['en', undefined, 'for breaking a community rule'],
    ['es', 'chat', 'por algo que escribiste'],
    ['es', 'play', 'por c\u00f3mo jugaste'],
    ['es', 'name', 'por tu nombre'],
    ['es', undefined, 'incumplir una regla de la comunidad'],
    ['pt', 'chat', 'por algo que escreveu'],
    ['pt', 'play', 'pela forma como jogou'],
    ['pt', 'name', 'por causa do seu nome'],
    ['pt', undefined, 'quebrar uma regra da comunidade'],
  ];
  it.each(SAYS)('%s, evidence %s: the text and the html say "%s"', (locale, evidence, snippet) => {
    const c = content(locale, evidence);
    expect(c.text).toContain(snippet);
    expect(c.html).toContain(snippet);
  });
  it.each(['chat', 'play', 'name'] as const)('a warning about %s never says another kind\u2019s words', (evidence) => {
    const own = content('en', evidence).text;
    for (const other of ['chat', 'play', 'name'] as const) if (other !== evidence) expect(own).not.toContain(NOTICE_WORDS[`player.notice.body.warning.${other}` as keyof typeof NOTICE_WORDS]);
  });
  it('a kind with no variant (a chat restriction) reads its own body whatever the evidence', () => {
    const plain = content('en', undefined, 'chat').text;
    expect(content('en', 'play', 'chat').text).toBe(plain);
    expect(content('en', 'name', 'chat').text).toBe(plain);
    expect(content('en', 'chat', 'chat').text).toBe(plain);
  });
  it('a catalog without the variant reads its own neutral body, never English mixed in', () => {
    const es = { ...noticeWordsFor('es').words };
    delete es['player.notice.body.warning.play'];
    const c = content('es', 'play', 'warning', es);
    expect(c.text).toContain('incumplir una regla de la comunidad');
    expect(c.text).not.toContain('how you played');
  });
  it('an evidence kind that is not one is read as none', () => {
    expect(content('en', 'moon' as never).text).toContain('for breaking a community rule');
  });
  it('the same notice reads the same in the queue and in the email', () => {
    for (const evidence of ['chat', 'play', 'name'] as const) {
      const body = nv({ kind: 'warning', evidence, excerpt: [], refCode: null, mustAcknowledge: true, rule: 2, ruleLabel: 'CR 2', until: null, createdAt: NOW } as never).body;
      expect(content('en', evidence).text).toContain(body);
    }
  });

  describe('through the kit', () => {
    const LANDING = 'https://game.example/appeal';
    async function delivered(reason: string | undefined, rule: number, evidenceKind?: 'chat' | 'play' | 'name') {
      const calls: NoticeDelivery[] = [];
      const k = await appealsKit({ appeals: { landingUrl: LANDING }, notices: { deliver: (d: NoticeDelivery) => void calls.push(d) } } as never, {});
      k.cw.rooms.seat('acct-room', 'p1', { clientKey: 'key-ev', accountId: 'acct-1' }, 'Acct');
      const f = await k.file(reason === undefined ? {} : { reason }, { target: 'key-ev' });
      const res = await k.cw.decide({
        reportId: f.id,
        verdict: 'upheld',
        actor: 'mod_ann',
        reason: 'private',
        ...(evidenceKind === undefined ? {} : { evidenceKind }),
        actions: [{ subject: f.target, kind: 'warning', durationMs: null, rule, lineIds: [] }],
      } as never);
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      return calls[0] as NoticeDelivery;
    }
    it('an AFK warning is delivered as being about play', async () => {
      const d = await delivered('afk', 6);
      expect(d.text).toContain('for how you played');
      expect(d.html).toContain('for how you played');
      expect(d.text).not.toContain('something you wrote');
    });
    it('a name warning is delivered as being about the name', async () => {
      expect((await delivered('name', 7)).text).toContain('about your name');
    });
    it('a chat warning is delivered as being about what was written', async () => {
      expect((await delivered('harassment', 2)).text).toContain('for something you wrote');
    });
    it('a decision that says its own kind is delivered in that kind', async () => {
      expect((await delivered('harassment', 2, 'play')).text).toContain('for how you played');
    });
    it('a report with no kind (and a rule with none) is delivered neutral', async () => {
      const d = await delivered(undefined, 1);
      expect(d.text).toMatch(/community rule/);
    });
  });
});

describe('M1: a 0.2.2 server accepts chat lines on a play or name decision', () => {
  async function filed(reason: string | undefined, over: Record<string, unknown> = {}) {
    const w = await world(over, new MemoryStore());
    const t = w.table({ target: 'key-target-m1' });
    for (const text of ['Hello', 'good game', 'nice one']) {
      w.cw.chat.accept(t.room, 'p2', text);
      w.clock.t += 1000;
    }
    const res = await w.submit(t.room, reason === undefined ? {} : { reason });
    if (!res.ok) throw new Error(`refused ${res.refused}`);
    const report = w.cw.reports.get(res.reportId);
    if (report === null) throw new Error('no report');
    const own = report.ownLineIds[report.targetPerson] ?? [];
    const decide = (rule: number, lineIds: string[], evidenceKind?: 'chat' | 'play' | 'name') =>
      w.cw.decide({
        reportId: res.reportId,
        verdict: 'upheld',
        actor: 'mod_ann',
        reason: 'private reason',
        ...(evidenceKind === undefined ? {} : { evidenceKind }),
        actions: [{ subject: report.targetPerson, kind: 'warning', durationMs: null, rule, lineIds }],
      } as never);
    return { w, own, decide, pending: () => w.cw.notices.pending({ clientKey: 'key-target-m1' }), res };
  }
  it.each([
    ['afk', 6, 'play'],
    ['griefing', 6, 'play'],
    ['cheating', 5, 'play'],
    ['name', 7, 'name'],
  ] as const)('a %s decision with a line is taken: the line is stored, the kind stays %s, the words stay neutral', async (reason, rule, kind) => {
    const f = await filed(reason);
    expect((await f.decide(rule, [f.own[0] as string])).ok).toBe(true);
    const [n] = f.pending();
    expect(n?.evidence).toBe(kind);
    expect(n?.excerpt).toHaveLength(1);
    const v = nv(n as never);
    expect(v.linesLabel).toBe('What led to this');
    expect(v.body).toBe(NOTICE_WORDS[`player.notice.body.warning.${kind}` as keyof typeof NOTICE_WORDS]);
  });
  it('the rule is a fallback too: CR 7 with no reason takes a line and stays a name', async () => {
    const f = await filed(undefined);
    expect((await f.decide(7, [f.own[0] as string])).ok).toBe(true);
    expect(f.pending()[0]?.evidence).toBe('name');
    expect(f.pending()[0]?.excerpt).toHaveLength(1);
  });
  it('a decision that says name or play over a chat report takes the line as well', async () => {
    const f = await filed('harassment');
    expect((await f.decide(2, f.own.slice(0, 2), 'name')).ok).toBe(true);
    expect(f.pending()[0]).toMatchObject({ evidence: 'name' });
    expect(f.pending()[0]?.excerpt).toHaveLength(2);
  });
  it('the other refusals still hold: a line that is not theirs is refused', async () => {
    const f = await filed('afk');
    expect(await f.decide(6, ['not-a-line'])).toEqual({ ok: false, error: 'invalid' });
    expect(f.w.cw.reports.get(f.res.reportId)?.status).toBe('open');
  });
  it('chat evidence is as it was', async () => {
    const f = await filed('harassment');
    expect((await f.decide(2, f.own.slice(0, 2))).ok).toBe(true);
    expect(f.pending()[0]).toMatchObject({ evidence: 'chat' });
    expect(f.pending()[0]?.excerpt).toHaveLength(2);
  });
});

describe('M3: the code of conduct says what really comes first for play and names', () => {
  const policyOf = (profile: ReturnType<typeof resolveProfile>): DocumentPolicy => ({ profile, rules: defineRules(starterRules(profile.rules)) });
  const doc = (profile: ReturnType<typeof resolveProfile>) => codeOfConduct(policyOf(profile), { format: 'text', gameName: 'Test Game' });
  const section = (text: string): string => {
    const at = text.indexOf('They are judged on what happened');
    expect(at).toBeGreaterThan(-1);
    return text.slice(at, at + 400);
  };
  it('standard: a warning first, then a ban from public rooms and matchmaking (as before)', () => {
    const s = section(doc(resolveProfile('standard')));
    expect(s).toContain('Usually a warning comes first.');
    expect(s).toContain('If you carry on, the next steps are a ban from public rooms and matchmaking, then longer bans.');
  });
  it('relaxed: a first time is only noted for the moderators, a name still gets a warning, never "a warning comes first"', () => {
    const s = section(doc(resolveProfile('relaxed')));
    expect(s).toContain('Usually the first time is only noted for the moderators, and you are not sent a warning.');
    expect(s).toContain('A name that breaks the rules gets a warning.');
    expect(s).not.toContain('a warning comes first');
  });
  it('a first step that is nothing, or a restriction, is said as that', () => {
    expect(section(doc(resolveProfile('standard', { firstOffense: { banter: 'none', rude: 'none', hostile: { kind: 'chat', durationMs: 86_400_000 }, severe: { kind: 'chat', durationMs: 604_800_000 } } })))).toContain('Usually the first time is not acted on.');
    expect(section(doc(resolveProfile('standard', { firstOffense: { banter: 'none', rude: { kind: 'chat', durationMs: 3_600_000 }, hostile: { kind: 'chat', durationMs: 86_400_000 }, severe: { kind: 'chat', durationMs: 604_800_000 } } })))).toContain('Usually a restriction comes first.');
  });
  it('a profile whose area rules leave out the played rules does not promise a ban from public rooms', () => {
    const s = section(doc(resolveProfile('standard', { areaRules: [2] })));
    expect(s).not.toContain('ban from public rooms and matchmaking, then longer bans');
    expect(s).toContain('If you carry on, the steps get stricter.');
  });
  it('a profile with one of the played rules in its area rules keeps the sentence', () => {
    expect(section(doc(resolveProfile('standard', { areaRules: [6] })))).toContain('a ban from public rooms and matchmaking, then longer bans');
  });
  it('the html and markdown say the same', () => {
    const p = policyOf(resolveProfile('relaxed'));
    for (const format of ['markdown', 'html'] as const) expect(codeOfConduct(p, { format, gameName: 'Test Game' })).toContain('only noted for the moderators');
  });
});

describe('M4: the suggestion has no unused rename field', () => {
  it('a name with renames on still says to ask for a new name, and carries no rename key', () => {
    const renames = resolveProfile('relaxed', { names: { renames: true } });
    const s = suggest(renames, [], null, 7, NOW, { evidence: 'name' });
    expect(Object.hasOwn(s, 'rename')).toBe(false);
    expect(s.why).toMatch(/new name/);
    expect(s.outcome).toBe('warning');
  });
});

import { describe, expect, it } from 'vitest';
import { codeOfConduct, moderatorGuide } from '../src/documents.js';
import type { DocumentPolicy } from '../src/documents.js';
import type { PlayerNotice } from '../src/notices.js';
import { NOTICE_WORDS, bodyKey, noticeView } from '../src/noticeCopy.js';
import type { NoticeView, NoticeWords } from '../src/noticeCopy.js';
import { APPEAL_WORDS, NOTICE_WORDS_ES, NOTICE_WORDS_PT, noticeWordsFor } from '../src/noticeLocales.js';
import { PRESETS } from '../src/profile.js';
import { defineRules, starterRules } from '../src/rules.js';
import type { NoticeKind } from '../src/types.js';

// Neutral notice words and the chat, play and name variants (0.2.2, audit P1, P2, P5, P6, P7, P8, P9, P11, S3, S12, C5).

const NOW = 1_800_000_000_000;
const notice = (over: Partial<PlayerNotice> = {}): PlayerNotice => ({
  id: 'n1',
  kind: 'warning',
  rule: 6,
  ruleLabel: 'Community Rule 6: No throwing, stalling or ruining games on purpose',
  until: null,
  refCode: 'M-ABCDE',
  excerpt: [],
  createdAt: NOW,
  mustAcknowledge: true,
  ...over,
});
const ctx = (words: NoticeWords = NOTICE_WORDS) => ({ words, locale: 'en', now: () => NOW });
const view = (over: Partial<PlayerNotice> = {}, words: NoticeWords = NOTICE_WORDS): NoticeView => noticeView(notice(over), ctx(words));
const KINDS: NoticeKind[] = ['warning', 'chat', 'area', 'ban'];

describe('the warning body (P1)', () => {
  it('the default is neutral: it names no message, no chat, nothing written', () => {
    const body = NOTICE_WORDS['player.notice.body.warning'];
    expect(body).toBe('A moderator gave you a warning for breaking a community rule. You can keep playing.');
    expect(body).not.toMatch(/wrote|written|message|chat|said/i);
    expect(view().body).toBe(body);
  });
  it('a notice with no kind reads neutral (a 0.2.1 notice, a custom reason)', () => {
    expect(view({ evidence: undefined }).body).toBe(NOTICE_WORDS['player.notice.body.warning']);
  });
  it('the chat variant keeps today\'s words: "something you wrote"', () => {
    expect(NOTICE_WORDS['player.notice.body.warning.chat']).toBe('A moderator gave you a warning for something you wrote. You can keep playing.');
    expect(view({ evidence: 'chat' }).body).toBe(NOTICE_WORDS['player.notice.body.warning.chat']);
  });
  it('the play and name variants say what it was about', () => {
    expect(view({ evidence: 'play' }).body).toBe('A moderator gave you a warning for how you played. You can keep playing.');
    expect(view({ evidence: 'name' }).body).toBe('A moderator gave you a warning about your name. You can keep playing.');
    for (const k of ['play', 'name'] as const) expect(view({ evidence: k }).body).not.toMatch(/wrote|message|chat/i);
  });
  it.each(['play', 'name'] as const)('the %s variant is not the chat one', (k) => {
    expect(view({ evidence: k }).body).not.toBe(view({ evidence: 'chat' }).body);
  });
  it('every sanction body is neutral of the conduct for every kind (chat, area, ban name the action only)', () => {
    for (const kind of KINDS) {
      for (const evidence of [undefined, 'play', 'name'] as const) {
        const body = view({ kind, evidence, until: kind === 'warning' ? null : NOW + 1 }).body;
        expect(body, `${kind}/${evidence}`).not.toMatch(/wrote|written|said/i);
      }
    }
  });
  it('bodyKey says which key a notice uses, and the fallback kind still falls back', () => {
    expect(bodyKey('warning')).toBe('player.notice.body.warning');
    expect(bodyKey('warning', 'chat')).toBe('player.notice.body.warning.chat');
    expect(bodyKey('warning', 'play')).toBe('player.notice.body.warning.play');
    expect(bodyKey('chat', 'play')).toBe('player.notice.body.chat');
    expect(bodyKey('someday', 'chat')).toBe('player.notice.body.fallback');
  });
  it('a studio catalog that has the old keys only reads its own base body, never English mixed in', () => {
    const studio = { ...NOTICE_WORDS, 'player.notice.body.warning': 'Un aviso.' } as Record<string, string>;
    delete studio['player.notice.body.warning.chat'];
    delete studio['player.notice.body.warning.play'];
    expect(view({ evidence: 'chat' }, studio as NoticeWords).body).toBe('Un aviso.');
    expect(view({ evidence: 'play' }, studio as NoticeWords).body).toBe('Un aviso.');
  });
});

describe('the lines label (P2, P11)', () => {
  const lines = [{ day: '2027-01-15', text: 'Hello' }];
  it('with no kind it is neutral: "What led to this"', () => {
    expect(NOTICE_WORDS['player.notice.lines']).toBe('What led to this');
    expect(view({ excerpt: lines }).linesLabel).toBe('What led to this');
  });
  it('"Your messages that led to this" only for chat', () => {
    expect(NOTICE_WORDS['player.notice.lines.chat']).toBe('Your messages that led to this');
    expect(view({ excerpt: lines, evidence: 'chat' }).linesLabel).toBe('Your messages that led to this');
    expect(view({ excerpt: lines, evidence: 'play' }).linesLabel).toBe('What led to this');
    expect(view({ excerpt: lines, evidence: 'name' }).linesLabel).toBe('What led to this');
  });
  it('no lines, no label, whatever the kind', () => {
    for (const evidence of [undefined, 'chat', 'play', 'name'] as const) expect(view({ evidence }).linesLabel).toBeNull();
  });
  it('the view carries the kind, so an adopter UI can branch (P11)', () => {
    expect(view({ evidence: 'play' }).evidence).toBe('play');
    expect(view({}).evidence).toBeUndefined();
    expect(Object.hasOwn(view({}), 'evidence')).toBe(false);
  });
});

describe('es and pt (P6)', () => {
  it.each([
    ['es', NOTICE_WORDS_ES, /escribiste/, /mensajes/],
    ['pt', NOTICE_WORDS_PT, /escreveu/, /mensagens/],
  ] as const)('%s: the base warning and lines are neutral, the chat variant keeps the old meaning', (_n, set, wrote, messages) => {
    expect(set['player.notice.body.warning']).not.toMatch(wrote);
    expect(set['player.notice.body.warning.chat']).toMatch(wrote);
    expect(set['player.notice.body.warning.play']).not.toMatch(wrote);
    expect(set['player.notice.body.warning.name']).not.toMatch(wrote);
    expect(set['player.notice.lines']).not.toMatch(messages);
    expect(set['player.notice.lines.chat']).toMatch(messages);
  });
  it('the appeal reasons are neutral in every language: no "what was said", no "the chat record"', () => {
    for (const set of [APPEAL_WORDS, NOTICE_WORDS_ES, NOTICE_WORDS_PT] as const) {
      for (const [k, v] of Object.entries(set)) {
        if (!k.startsWith('player.appeal.reason.')) continue;
        expect(v, k).not.toMatch(/was said|chat record|conversation|se dijo|registro del chat|conversaci|foi dito|registro do chat|conversa\b/i);
      }
    }
  });
  it('noticeWordsFor serves the variants in every language', () => {
    for (const l of ['en', 'es', 'pt']) expect(Object.keys(noticeWordsFor(l).words)).toContain('player.notice.body.warning.play');
  });
});

describe('the appeal reasons in English (P5)', () => {
  it('are exactly these, with no chat word', () => {
    const got = Object.fromEntries(Object.entries(APPEAL_WORDS).filter(([k]) => k.startsWith('player.appeal.reason.')));
    expect(got).toEqual({
      'player.appeal.reason.upheld.rule_applies': 'The rule applies to what happened.',
      'player.appeal.reason.upheld.evidence_clear': 'The record shows the rule was broken.',
      'player.appeal.reason.upheld.context_considered': 'We looked at the whole situation, and the decision stands.',
      'player.appeal.reason.reduced.first_offence': 'We lightened it because this was a first offence.',
      'player.appeal.reason.reduced.lighter_fits': 'A lighter action fits what happened.',
      'player.appeal.reason.reduced.context_considered': 'We looked at the whole situation and lightened it.',
      'player.appeal.reason.revoked.mistake': 'This was our mistake. We are sorry.',
      'player.appeal.reason.revoked.not_a_violation': 'What happened does not break the rules.',
      'player.appeal.reason.revoked.context_considered': 'We looked at the whole situation and lifted it.',
    });
  });
});

describe('the lines of a chat restriction stay as they are (C5)', () => {
  it('the automatic filter line still says a message was caught', () => {
    expect(NOTICE_WORDS['player.restricted.filter.until']).toContain('The automatic filter caught a message.');
  });
});

describe('starter rules (P9)', () => {
  const rules = (flavour: 'relaxed' | 'standard' | 'strict') => Object.fromEntries(starterRules(flavour).map((r) => [r.number, r]));
  it('numbers never move: 1 to 8, the same titles but CR 3', () => {
    const std = rules('standard');
    expect(Object.keys(std)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(std[1]?.title).toBe('No slurs or hate aimed at who someone is');
    expect(std[2]?.title).toBe('No insulting, threatening or targeting another player');
    expect(std[4]?.title).toBe('No spam, flooding or advertising');
    expect(std[7]?.title).toBe('No offensive names');
  });
  it('CR 3 is about sexual content, not only messages', () => {
    for (const f of ['relaxed', 'standard', 'strict'] as const) {
      expect(rules(f)[3]?.title).toBe('No sexual content');
      expect(rules(f)[3]?.text).toMatch(/names/);
    }
  });
  it('CR 4 no longer says "the chat"', () => {
    for (const f of ['relaxed', 'standard', 'strict'] as const) {
      expect(rules(f)[4]?.text).not.toMatch(/the chat/);
      expect(rules(f)[4]?.text).toMatch(/invites|pings/);
    }
  });
  it('CR 2 covers chat, play and names in standard and strict; relaxed stays as it was', () => {
    for (const f of ['standard', 'strict'] as const) expect(rules(f)[2]?.text).toMatch(/in chat, in how you play or in your name/);
    expect(rules('relaxed')[2]?.title).toBe('No harassment or threats');
    expect(rules('relaxed')[2]?.text).not.toMatch(/in chat/);
  });
  it('CR 1 keeps its words', () => {
    expect(rules('standard')[1]?.text).toContain('what you say about other players');
  });
});

describe('the code of conduct (P7, P8) and the guide (S3, S12)', () => {
  const policy = (name: 'relaxed' | 'standard' | 'strict'): DocumentPolicy => ({ profile: PRESETS[name], rules: defineRules(starterRules(PRESETS[name].rules)) });
  const conduct = (n: 'relaxed' | 'standard' | 'strict' = 'standard') => codeOfConduct(policy(n), { format: 'markdown', gameName: 'Test Game' });
  it('P7: reports are reviewed, and what is reviewed depends on the report', () => {
    for (const n of ['relaxed', 'standard', 'strict'] as const) {
      const doc = conduct(n);
      expect(doc).not.toContain('Reported messages are reviewed');
      expect(doc).not.toContain('Recent chat from that game is reviewed before a decision is made.');
      expect(doc).toContain('Reports are reviewed by a moderator before a decision is made. Depending on the report that can be chat, how the game was played, or a player name.');
      expect(doc).toContain('Pick the reason that fits best and describe what happened.');
    }
  });
  it('P8: the page says what happens for playing and names, naming the rules', () => {
    const doc = conduct();
    expect(doc).toContain('Playing and names');
    const section = doc.slice(doc.indexOf('Playing and names'));
    expect(section).toMatch(/CR 5/);
    expect(section).toMatch(/CR 6/);
    expect(section).toMatch(/CR 7/);
    expect(section).toMatch(/warning/i);
  });
  it('P8: a policy with no play or name rules active has no such section', () => {
    const rules = defineRules(starterRules('standard').map((r) => ([5, 6, 7].includes(r.number) ? { ...r, retired: true } : r)));
    const doc = codeOfConduct({ profile: PRESETS.standard, rules }, { format: 'markdown', gameName: 'Test Game' });
    expect(doc).not.toContain('Playing and names');
  });
  it('S12: the guide tells moderators to write what happened', () => {
    const guide = moderatorGuide(policy('standard'), { format: 'markdown' });
    expect(guide).not.toContain('what was said, and why it breaks the rule you cite');
    expect(guide).toContain('what happened, and why it breaks the rule you cite');
  });
  it('S3: the guide describes the ladder columns without chat words, and keeps chat as an example', () => {
    const guide = moderatorGuide(policy('standard'), { format: 'markdown' });
    expect(guide).toContain('Low / medium (minor or isolated)');
    expect(guide).toContain('High (serious or repeated, or severe)');
    expect(guide).not.toContain('Banter is never acted on, whatever the record.');
    expect(guide).toMatch(/banter, is never acted on, whatever the record\. In chat that is/);
  });
});

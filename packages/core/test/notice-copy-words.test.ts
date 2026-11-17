import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bodyKey, englishWords, isSanction, NOTICE_WORDS, titleKey, WARNING_DAYS } from '../src/noticeCopy.js';
import type { NoticeWordKey } from '../src/noticeCopy.js';
import type { NoticeKind } from '../src/types.js';
import { NOTICE_RECORD_WINDOW_MS } from '../src/notices.js';

// The words of a player notice, kept in one place. The snapshot below is the player-react `en` catalog of 0.1.14 for these keys, taken before
// the move: moving the code must not change a word.

/** Every kind a notice can have. Typed over the union: a kind added to `NoticeKind` fails to compile here until it is listed. */
const KINDS: Record<NoticeKind, true> = {
  warning: true,
  chat: true,
  area: true,
  ban: true,
  report_outcome: true,
  rename_required: true,
  appeal_upheld: true,
  appeal_reduced: true,
  appeal_revoked: true,
};

const SNAPSHOT_0_1_14: Record<string, string> = {
  'player.notice.title.warning': 'You have a warning',
  'player.notice.title.chat': 'Your chat is turned off',
  'player.notice.title.area': 'You cannot join public rooms',
  'player.notice.title.ban': 'You are banned',
  'player.notice.title.report_outcome': 'Thanks for your report',
  'player.notice.title.rename_required': 'Please choose a new name',
  'player.notice.title.appeal_upheld': 'We looked again and kept the decision',
  'player.notice.title.appeal_reduced': 'We looked again and changed the decision',
  'player.notice.title.appeal_revoked': 'We looked again and removed the decision',
  'player.notice.title.fallback': 'A message from the moderators',
  'player.notice.body.warning': 'A moderator gave you a warning for something you wrote. You can keep playing.',
  'player.notice.body.chat': 'A moderator turned off your chat. You can still play.',
  'player.notice.body.area': 'A moderator stopped you joining public rooms and matchmaking. You can still play in private rooms.',
  'player.notice.body.ban': 'A moderator banned you from playing.',
  'player.notice.body.report_outcome': 'A moderator looked at your report and took action. We do not share what was done.',
  'player.notice.body.rename_required': 'A moderator asked you to change your name because it breaks the community rules. Choose a new name to keep playing.',
  'player.notice.body.appeal_upheld': 'A moderator read your appeal. The original decision stands.',
  'player.notice.body.appeal_reduced': 'A moderator read your appeal and made the decision lighter. The new decision is on your record.',
  'player.notice.body.appeal_revoked': 'A moderator read your appeal and took the decision off your record.',
  'player.notice.body.fallback': 'There is a new message about your account.',
  'player.notice.rule': 'Rule',
  'player.notice.given': 'Given',
  'player.notice.until': 'Until',
  'player.notice.ended': 'Ended',
  'player.notice.noEnd': 'No end date',
  'player.notice.onRecordUntil': 'On your record until',
  'player.notice.untilLeft': '{when} ({left})',
  'player.notice.ref': 'Reference',
  'player.notice.refHint': 'Quote this code if you contact us.',
  'player.notice.lines': 'Your messages that led to this',
  'player.notice.todo.warning': 'Press Acknowledge to confirm you saw this.',
  'player.notice.acknowledge': 'Acknowledge',
  'player.notice.gotIt': 'Got it',
  'player.notice.appeal': 'Think this is a mistake?',
  'player.restricted.moderator.until': 'A moderator turned off your chat until {when} ({left}).',
  'player.restricted.moderator.noEnd': 'A moderator turned off your chat. It does not end on its own.',
};

describe('NOTICE_WORDS', () => {
  it.each(Object.keys(KINDS))('every NoticeKind has a title and a body in NOTICE_WORDS: %s', (kind) => {
    for (const key of [titleKey(kind), bodyKey(kind)]) {
      expect(key, kind).not.toMatch(/fallback$/);
      expect(typeof NOTICE_WORDS[key], key).toBe('string');
      expect(NOTICE_WORDS[key].length, key).toBeGreaterThan(0);
    }
    expect(titleKey(kind)).toBe(`player.notice.title.${kind}`);
    expect(bodyKey(kind)).toBe(`player.notice.body.${kind}`);
  });

  it('NOTICE_WORDS equals the 0.1.14 strings', () => {
    expect({ ...NOTICE_WORDS }).toEqual(SNAPSHOT_0_1_14);
  });

  it('is frozen, and englishWords() is a fresh unfrozen copy each call', () => {
    expect(Object.isFrozen(NOTICE_WORDS)).toBe(true);
    const a = englishWords();
    const b = englishWords();
    expect(a).toEqual({ ...NOTICE_WORDS });
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a)).toBe(false);
    a['player.notice.rule'] = 'changed';
    expect(NOTICE_WORDS['player.notice.rule']).toBe('Rule');
    expect(englishWords()['player.notice.rule']).toBe('Rule');
  });

  it('player-react still says the same words (until it takes them from here)', () => {
    const source = readFileSync(fileURLToPath(new URL('../../player-react/src/i18n.ts', import.meta.url)), 'utf8');
    // Either player-react still holds each string, or it spreads NOTICE_WORDS into its catalog.
    if (/\.\.\.NOTICE_WORDS/.test(source)) return;
    for (const [key, value] of Object.entries(NOTICE_WORDS)) expect(source, key).toContain(`'${key}': ${JSON.stringify(value).replace(/^"|"$/g, "'")}`);
  });

  it('every key is a player-react key: player.notice.* or player.restricted.moderator.*', () => {
    for (const key of Object.keys(NOTICE_WORDS)) expect(key).toMatch(/^player\.(notice|restricted\.moderator)\./);
  });

  it('the fallbacks exist, and an unknown kind (or a prototype name) gets them', () => {
    const fallback: NoticeWordKey[] = ['player.notice.title.fallback', 'player.notice.body.fallback'];
    for (const key of fallback) expect(NOTICE_WORDS[key].length).toBeGreaterThan(0);
    for (const kind of ['', 'mystery', 'toString', '__proto__', 'constructor', 'Warning']) {
      expect(titleKey(kind), kind).toBe('player.notice.title.fallback');
      expect(bodyKey(kind), kind).toBe('player.notice.body.fallback');
    }
  });

  it('isSanction is true for the four sanctions and nothing else', () => {
    for (const kind of Object.keys(KINDS)) expect(isSanction(kind), kind).toBe(['warning', 'chat', 'area', 'ban'].includes(kind));
    for (const kind of ['', 'mystery', 'note', 'toString']) expect(isSanction(kind), kind).toBe(false);
  });

  it('WARNING_DAYS is the 90-day window core keeps a notice on the record', () => {
    expect(WARNING_DAYS).toBe(90);
    expect(WARNING_DAYS * 24 * 60 * 60 * 1000).toBe(NOTICE_RECORD_WINDOW_MS);
  });
});

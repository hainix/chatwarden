import { screen, waitFor } from '@testing-library/react';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import * as core from '@chatwarden/core/notice-copy';
import { NOTICE_WORDS, noticeView } from '@chatwarden/core/notice-copy';
import type { NoticeWordKey } from '@chatwarden/core/notice-copy';
import type { PlayerAppeal, PlayerNotice } from '@chatwarden/core';
import { MyRecord } from '../src/MyRecord.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import * as ui from '../src/ui.js';
import { RestrictedChatLine } from '../src/RestrictedChatLine.js';
import type { PlayerClient } from '../src/client.js';
import { dayText, timeLeft, untilText } from '../src/format.js';
import { createT, en } from '../src/i18n.js';
import type { PlayerText } from '../src/i18n.js';
import { FIXED, renderUi } from './render.js';

// The player's most-seen dialog must render exactly what it did before its words and formatters moved to core (Review Focus 5).
// The fixtures in test/baselines/ were taken from the components BEFORE the move (UPDATE_BASELINES=1 regenerates them); every shape
// below is rendered again and compared with them, character for character.

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FILE = join(import.meta.dirname, 'baselines', 'notice-shapes.json');

const base: PlayerNotice = { id: 'n1', kind: 'chat', rule: 2, ruleLabel: 'Community Rule 2: No insulting players', until: NOW + DAY, refCode: 'CW-ABCD-1234', excerpt: [], createdAt: NOW - HOUR, mustAcknowledge: false };
const lines = [
  { text: 'you are a *****', day: '2027-01-15' },
  { text: 'honestly tarvo', day: '2027-01-16' },
];
const make = (more: Partial<PlayerNotice>): PlayerNotice => ({ ...base, ...more });

const SHAPES: Array<[string, PlayerNotice]> = [
  ['warning', make({ kind: 'warning', until: null, mustAcknowledge: true })],
  ['warning with lines', make({ kind: 'warning', until: null, mustAcknowledge: true, excerpt: lines })],
  ['chat with end', make({ kind: 'chat' })],
  ['chat with lines', make({ kind: 'chat', excerpt: lines })],
  ['chat, no end', make({ kind: 'chat', until: null })],
  ['chat, ended', make({ kind: 'chat', until: NOW - HOUR })],
  ['chat in 20 minutes', make({ kind: 'chat', until: NOW + 20 * 60_000 })],
  ['chat in 5 days', make({ kind: 'chat', until: NOW + 5 * DAY })],
  ['area', make({ kind: 'area', excerpt: lines.slice(0, 1) })],
  ['area, no end', make({ kind: 'area', until: null })],
  ['ban', make({ kind: 'ban', until: null })],
  ['ban with end', make({ kind: 'ban', until: NOW + 30 * DAY })],
  ['no rule, no reference', make({ kind: 'chat', rule: null, ruleLabel: null, refCode: null })],
  ['uncovered rule', make({ kind: 'warning', rule: 'uncovered', ruleLabel: 'Not covered by a rule yet', until: null, mustAcknowledge: true })],
  ['report outcome', make({ kind: 'report_outcome', rule: null, ruleLabel: null, until: null, refCode: null })],
  ['rename required', make({ kind: 'rename_required', until: null, refCode: null })],
  ['appeal upheld', make({ kind: 'appeal_upheld', until: null })],
  ['appeal reduced', make({ kind: 'appeal_reduced', until: null })],
  ['appeal revoked', make({ kind: 'appeal_revoked', until: null })],
  ['a message that must be acknowledged', make({ kind: 'appeal_upheld', until: null, mustAcknowledge: true })],
  ['a message with an end', make({ kind: 'rename_required', until: NOW + 3 * HOUR, refCode: null })],
  ['unknown kind', make({ kind: 'zorbak_kind' as PlayerNotice['kind'], until: null, rule: null, ruleLabel: null })],
  ['unknown kind that looks like an Object member', make({ kind: 'constructor' as PlayerNotice['kind'], until: null })],
  ['five lines', make({ kind: 'chat', excerpt: [...lines, ...lines, lines[0] as { text: string; day: string }] })],
  ['a bad day in a line', make({ kind: 'chat', excerpt: [{ text: 'vlemmo', day: 'not a day' }] })],
];

function client(notices: PlayerNotice[], appeals: PlayerAppeal[] = []): PlayerClient {
  return {
    notices: async () => notices,
    record: async () => notices,
    ack: async () => true,
    rules: async () => ({ summary: '', rules: [] }),
    appeals: async () => appeals,
    fileAppeal: async () => ({ ok: false, refused: 'off' }) as never,
  };
}

/** The document as HTML with the generated ids made stable. */
const dom = (): string => document.body.innerHTML.replace(/:r[0-9a-z]+:/g, ':rN:');

type Fixtures = Record<string, string>;
const fixtures: Fixtures = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Fixtures) : {};
const taken: Fixtures = {};
const update = process.env['UPDATE_BASELINES'] === '1';

/** Compare with the stored baseline, or record it when asked to. */
function check(name: string, html: string): void {
  if (update) {
    taken[name] = html;
    mkdirSync(dirname(FILE), { recursive: true });
    writeFileSync(FILE, `${JSON.stringify({ ...fixtures, ...taken }, null, 1)}\n`);
    return;
  }
  expect(fixtures[name], `no baseline for ${name}`).toBeDefined();
  expect(html).toBe(fixtures[name]);
}

const common = { now: () => NOW, ...FIXED } as const;
const words = { words: NOTICE_WORDS, locale: 'en', timeZone: 'UTC', now: () => NOW } as const;

describe('en and the shared words', () => {
  it('en contains NOTICE_WORDS exactly (same keys, same values)', () => {
    for (const [key, value] of Object.entries(NOTICE_WORDS)) {
      expect(Object.hasOwn(en, key), key).toBe(true);
      expect((en as Record<string, string>)[key]).toBe(value);
    }
    expect(Object.keys(NOTICE_WORDS)).toHaveLength(39); // 36 notice words and the three restricted-chat words that moved with restrictedChatText (0.2.0)
  });

  it('PlayerText is the same union (every shared key is a PlayerText, and the notice position key stays)', () => {
    expectTypeOf<NoticeWordKey>().toExtend<PlayerText>();
    expectTypeOf<'player.notice.position'>().toExtend<PlayerText>();
  });

  it('a translation spread over en still wins for a notice key; a missing key falls back to English', () => {
    const de: Record<string, string> = { ...en, 'player.notice.title.chat': 'Dein Chat ist aus' };
    delete de['player.notice.title.ban'];
    const t = createT(de, 'de');
    expect(t('player.notice.title.chat')).toBe('Dein Chat ist aus');
    expect(t('player.notice.title.warning')).toBe('You have a warning');
    // The shared view, given a catalog that lacks a key, reads English for it.
    const lacking = { ...NOTICE_WORDS } as Record<string, string>;
    delete lacking['player.notice.title.ban'];
    lacking['player.notice.title.chat'] = 'Dein Chat ist aus';
    const view = (n: PlayerNotice) => noticeView(n, { ...words, words: lacking as unknown as typeof NOTICE_WORDS });
    expect(view(base).title).toBe('Dein Chat ist aus');
    expect(view(make({ kind: 'ban' })).title).toBe('You are banned');
  });
});

describe('there is one copy of the words and the formatters (the core subpath)', () => {
  it('the formatters, titleKey, bodyKey and isSanction are the core functions themselves', () => {
    expect(dayText).toBe(core.dayText);
    expect(untilText).toBe(core.untilText);
    expect(timeLeft).toBe(core.timeLeft);
    expect(ui.titleKey).toBe(core.titleKey);
    expect(ui.bodyKey).toBe(core.bodyKey);
    expect(ui.isSanction).toBe(core.isSanction);
  });

  it('the package keeps no second WARNING_DAYS', async () => {
    const { WARNING_DAYS } = await import('../src/constants.js');
    expect(WARNING_DAYS).toBe(core.WARNING_DAYS);
  });

  it('the catalog file does not spell out a shared word again', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'i18n.ts'), 'utf8');
    for (const key of Object.keys(NOTICE_WORDS)) expect(source, key).not.toContain(`'${key}'`);
    expect(source).toContain('...NOTICE_WORDS');
  });
});

describe('the public exports are unchanged', () => {
  it('dayText, secondsLeft, timeLeft, untilText, createT, en and the components are still exported from the entry', async () => {
    const entry = await import('../src/index.js');
    for (const name of ['dayText', 'secondsLeft', 'timeLeft', 'untilText', 'createT', 'en', 'NoticeQueue', 'MyRecord', 'RestrictedChatLine', 'RulesPage', 'ReportDialog', 'AppealDialog']) {
      expect(Object.hasOwn(entry, name), name).toBe(true);
    }
    expect(entry.dayText).toBe(core.dayText);
  });
});

describe('NoticeQueue renders the same DOM as the baselines for every shape', () => {
  it.each(SHAPES)('%s', async (name, notice) => {
    renderUi(<NoticeQueue client={client([notice])} {...common} />);
    await screen.findByRole('dialog');
    check(`queue: ${name}`, dom());
  });

  it('with the appeal link', async () => {
    renderUi(<NoticeQueue client={client([base])} appealUrl="/appeal" {...common} />);
    await screen.findByRole('dialog');
    check('queue: appeal link', dom());
  });

  it('appeals on', async () => {
    renderUi(<NoticeQueue client={client([base])} appeals {...common} />);
    await screen.findByRole('button', { name: 'Think this is a mistake?' });
    check('queue: appeals on', dom());
  });

  it('appeals on, an appeal already sent', async () => {
    const sent: PlayerAppeal = { id: 'a1', noticeId: 'n1', status: 'open', createdAt: NOW - HOUR / 2, decidedAt: null };
    renderUi(<NoticeQueue client={client([base], [sent])} appeals {...common} />);
    await waitFor(() => expect(document.body.textContent).toContain('Appeal sent'));
    check('queue: appeal sent', dom());
  });

  it('two notices waiting', async () => {
    renderUi(<NoticeQueue client={client([base, make({ id: 'n2', createdAt: NOW })])} {...common} />);
    await screen.findByRole('dialog');
    check('queue: two waiting', dom());
  });
});

describe('MyRecord renders the same DOM as the baselines for every shape', () => {
  it.each(SHAPES)('%s', async (name, notice) => {
    renderUi(<MyRecord client={client([notice])} {...common} />);
    await screen.findByRole('list', { name: 'Your record' });
    check(`record: ${name}`, dom());
  });

  it('every shape at once, with the appeal link', async () => {
    const all = SHAPES.map(([, n], i) => ({ ...n, id: `n${i}`, createdAt: NOW - i * HOUR }));
    renderUi(<MyRecord client={client(all)} appealUrl="/appeal" {...common} />);
    await screen.findByRole('list', { name: 'Your record' });
    check('record: all shapes', dom());
  });

  it('appeals on', async () => {
    renderUi(<MyRecord client={client([base, make({ id: 'n2', kind: 'warning', until: null })])} appeals {...common} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Think this is a mistake?' })).toHaveLength(2));
    check('record: appeals on', dom());
  });
});

describe('their text equals noticeView', () => {
  const pairs = (list: Element[], a: string, b: string) => list.map((f) => [f.querySelector(a)?.textContent, f.querySelector(b)?.textContent]);

  it.each(SHAPES)('NoticeQueue: %s', async (_name, notice) => {
    renderUi(<NoticeQueue client={client([notice])} {...common} />);
    const dialog = await screen.findByRole('dialog');
    const view = noticeView(notice, words);
    expect(dialog.querySelector('.cw-title')?.textContent).toBe(view.title);
    expect(dialog.querySelector('.cw-body')?.textContent).toBe(view.body);
    expect(pairs([...dialog.querySelectorAll('.cw-fact')], 'dt', 'dd')).toEqual(view.facts.map((f) => [f.term, f.value]));
    expect(pairs([...dialog.querySelectorAll('.cw-lines li')], '.cw-line-day', '.cw-line-text')).toEqual(view.lines.map((l) => [l.day, l.text]));
    expect(dialog.querySelector('.cw-lines-label')?.textContent ?? null).toBe(view.linesLabel);
    const hints = [...dialog.querySelectorAll('.cw-hint')].map((h) => h.textContent);
    expect(hints).toEqual([...(view.refHint === null ? [] : [view.refHint]), ...(view.todo === null ? [] : [view.todo])]);
    expect(screen.getByRole('button', { name: view.button })).toBeInTheDocument();
  });

  it.each(SHAPES)('MyRecord: %s', async (_name, notice) => {
    renderUi(<MyRecord client={client([notice])} {...common} />);
    const list = await screen.findByRole('list', { name: 'Your record' });
    const view = noticeView(notice, { ...words, record: true });
    expect(pairs([...list.querySelectorAll('.cw-fact')], 'dt', 'dd')).toEqual(view.facts.map((f) => [f.term, f.value]));
    expect(pairs([...list.querySelectorAll('.cw-lines li')], '.cw-line-day', '.cw-line-text')).toEqual(view.lines.map((l) => [l.day, l.text]));
  });
});

describe('RestrictedChatLine renders the same text for moderator and filter, with and without an end', () => {
  const END = NOW + 3 * HOUR;
  const cases: Array<[string, { until?: number | null; byModerator?: boolean; refCode?: string }]> = [
    ['moderator, ends', { until: END, byModerator: true }],
    ['moderator, no end', { until: null, byModerator: true }],
    ['filter, ends', { until: END, byModerator: false }],
    ['filter, no end', { until: null, byModerator: false }],
    ['moderator, ended', { until: NOW - HOUR, byModerator: true }],
    ['filter, ended', { until: NOW - HOUR, byModerator: false }],
    ['moderator with a reference', { until: END, byModerator: true, refCode: 'CW-ABCD-1234' }],
  ];
  it.each(cases)('%s', (name, p) => {
    renderUi(<RestrictedChatLine {...p} {...common} />);
    check(`restricted: ${name}`, dom());
  });
});

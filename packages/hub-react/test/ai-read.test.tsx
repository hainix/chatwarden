import { act, cleanup, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetHiddenAi } from '../src/case/CaseContext.js';
import { aiCase, aiWorld, noStrip, open, openPlain, pageReads, reads, settle, strip, TALK } from './aiHub.js';
import { renderHub } from './render.js';

// Level 1: the AI's read on the case card. Over the real routes with the scripted fake behind them: what the strip says, what it never
// says, the skeleton that waits for a read, and the tick on the lines it cited.

const SUMMARY = 'The reported player was rude in chat.';

afterEach(() => {
  vi.useRealTimers();
  forgetHiddenAi();
  cleanup();
});

describe('the strip: nothing when there is nothing to say', () => {
  it('renders nothing at level 0 or with no read', async () => {
    // Level 0: no adapter, no setting. Nothing is drawn and nothing is asked for.
    const { container, w, f } = await aiCase({ level: 0 });
    await settle(60);
    expect(noStrip()).toBeNull();
    expect(container.querySelector('.cw-ai')).toBeNull();
    expect(pageReads(w, f.id)).toBe(1);
  });

  it('a closed case shows no strip, whatever the AI read', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container } = await openPlain(w, f.id);
    await settle(60);
    expect(container.querySelector('.cw-ai')).toBeNull();
  });

  it('the Simple mode card shows no strip at level 0 either', async () => {
    const { container } = await aiCase({ level: 0, mode: 'simple' });
    await settle(60);
    expect(container.querySelector('.cw-ai')).toBeNull();
  });
});

describe('the strip: what it says', () => {
  it('renders the tag, level word, rule and summary', async () => {
    await aiCase({ level: 1 });
    const region = await strip();
    expect(within(region).getByText('AI')).toBeInTheDocument();
    expect(region.querySelector('.cw-ai-level')?.textContent).toBe('Rude');
    expect(within(region).getByText('Rule 1')).toBeInTheDocument();
    expect(within(region).getByText(SUMMARY)).toBeInTheDocument();
    // The count of lines it cited, as the strip says it.
    expect(within(region).getByText('AI cited 1 line')).toBeInTheDocument();
  });

  it('says how many lines it cited, in the right plural', async () => {
    const { w } = await aiCase({
      level: 1,
      script: (input) => reads({ evidence: input.lines.filter((l) => l.who === 'P1').map((l) => l.ref) })(input),
    });
    expect(w.adapter?.callCount).toBe(1);
    const region = await strip();
    expect(within(region).getByText('AI cited 2 lines')).toBeInTheDocument();
  });

  it('names each conduct level in words and a rule that no rule fits', async () => {
    await aiCase({ level: 1, script: reads({ severity: 'severe', rule: 'uncovered' }) });
    const region = await strip();
    expect(region.querySelector('.cw-ai-level')?.textContent).toBe('Severe');
    expect(within(region).getByText('No rule fits yet')).toBeInTheDocument();
  });

  it('draws no rule chip when the AI named none', async () => {
    await aiCase({
      level: 1,
      script: reads({ severity: 'banter', rule: null, evidence: [], recommendation: { verdict: 'no_action', severity: 'banter', rule: null, evidence: [] } }),
    });
    const region = await strip();
    expect(region.querySelector('.cw-ai-level')?.textContent).toBe('Banter');
    expect(within(region).queryByText(/^Rule /)).toBeNull();
    expect(within(region).queryByText(/AI cited/)).toBeNull();
  });

  it('the summary is text: a <b> and a markdown link are shown literally', async () => {
    const { w, f } = await aiWorld({ level: 1 });
    const odd = 'a <b>bold</b> claim and a [link](https://x.test) and **stars**';
    w.intercept.fn = async (req) => {
      if (req.method !== 'GET' || req.path !== `/reports/${f.id}`) return undefined;
      const res = await w.raw({ method: 'GET', path: req.path });
      const body = res.body as { ai: { summary: string } };
      return { ...res, body: { ...body, ai: { ...body.ai, summary: odd } } };
    };
    await open(w, f.id);
    const region = await strip();
    expect(within(region).getByText(odd)).toBeInTheDocument();
    expect(region.querySelector('b, a, strong:not(.cw-ai-level), em')).toBeNull();
    expect(region.innerHTML).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('is the same on the Simple mode card, where a level 1 case gets the read and no new button', async () => {
    await aiCase({ level: 1, mode: 'simple' });
    const region = await strip();
    expect(within(region).getByText(SUMMARY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    // The card still has its own buttons only: the step, nothing wrong here, something else.
    expect(screen.getByRole('button', { name: 'No action needed' })).toBeInTheDocument();
  });

  it('the strip is neutral and dashed: it uses no tone class of its own', async () => {
    await aiCase({ level: 1 });
    const region = await strip();
    expect(region.className).toBe('cw-ai');
    expect(region.querySelector('[class*="--bad"], [class*="--warn"], [class*="--accent"]')).toBeNull();
  });

  it('a read that is stale or flagged says nothing alarming in the strip', async () => {
    await aiCase({ level: 1, script: reads({ injectionSuspected: true }) });
    const region = await strip();
    expect(region.textContent).not.toMatch(/instruct|injection|older|stale|warning|suspicious|attack/i);
    expect(region.querySelector('.cw-tag--bad, .cw-tag--warn, .cw-notice')).toBeNull();
  });
});

describe('the skeleton while a read is expected', () => {
  const FAKE: Parameters<typeof vi.useFakeTimers>[0] = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] };
  const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
  const settleAll = async () => {
    for (let i = 0; i < 8; i += 1) await tick(0);
  };

  it('pending shows a skeleton and then disappears after 20 seconds (fake timers)', async () => {
    const { w, f } = await aiWorld({ level: 1, script: [{ hang: true }], noRead: true });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await settleAll();
    const region = screen.getByRole('region', { name: 'AI read' });
    expect(region).toHaveAttribute('aria-busy', 'true');
    expect(within(region).getByText('The AI is reading this case.')).toBeInTheDocument();
    expect(region.querySelector('.cw-skel')).not.toBeNull();
    await tick(19_000);
    expect(screen.queryByRole('region', { name: 'AI read' })).not.toBeNull();
    await tick(2_000);
    expect(noStrip()).toBeNull();
    // No error was ever shown on the case: a read that never arrives looks like the AI being off.
    expect(document.querySelector('.cw-ai')).toBeNull();
    expect(screen.queryByText(/AI.*(failed|could not|error)/i)).toBeNull();
  });

  it('while it waits the case is read again a few times, not in a loop', async () => {
    const { w, f } = await aiWorld({ level: 1, script: [{ hang: true }], noRead: true });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await settleAll();
    const first = pageReads(w, f.id);
    await tick(25_000);
    const more = pageReads(w, f.id) - first;
    expect(more).toBeGreaterThanOrEqual(2);
    expect(more).toBeLessThanOrEqual(5);
    // And it stops: nothing more is asked once the 20 seconds are over.
    const stopped = pageReads(w, f.id);
    await tick(60_000);
    expect(pageReads(w, f.id)).toBe(stopped);
  });

  it('a read that arrives while the skeleton shows replaces it', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { w, f } = await aiWorld({ level: 1, script: async () => (await gate, { usage: {} }), noRead: true });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await settleAll();
    expect(screen.getByRole('region', { name: 'AI read' })).toHaveAttribute('aria-busy', 'true');
    release();
    await tick(10);
    await settleAll();
    await tick(4_000);
    await settleAll();
    const region = screen.getByRole('region', { name: 'AI read' });
    expect(region).not.toHaveAttribute('aria-busy', 'true');
    expect(within(region).getByText(SUMMARY)).toBeInTheDocument();
  });

  it('no skeleton on a case where the AI is off', async () => {
    const { w, f } = await aiWorld({ level: 0 });
    vi.useFakeTimers(FAKE);
    renderHub(w, { path: `/reports/${f.id}`, mode: 'detailed' });
    await settleAll();
    expect(noStrip()).toBeNull();
  });
});

describe('the lines the AI cited', () => {
  it('the cited lines carry a tick and a text alternative', async () => {
    await aiCase({ level: 1 });
    await strip();
    const lines = [...document.querySelectorAll<HTMLElement>('.cw-lines .cw-line')];
    expect(lines.length).toBeGreaterThanOrEqual(4);
    const cited = lines.filter((l) => l.querySelector('.cw-aitick') !== null);
    expect(cited).toHaveLength(1);
    expect(cited[0]).toHaveTextContent('you are trash');
    expect(within(cited[0] as HTMLElement).getByText('Cited by the AI')).toBeInTheDocument();
    // Not on the other lines, the reporter's or the bystander's.
    for (const l of lines.filter((x) => x !== cited[0])) expect(l.querySelector('.cw-aitick')).toBeNull();
  });

  it('the tick is a mark, not a control: the line is still picked by its own box', async () => {
    await aiCase({ level: 1 });
    await strip();
    const tick = document.querySelector('.cw-aitick') as HTMLElement;
    expect(tick.querySelector('button, input, a')).toBeNull();
    expect(tick.closest('.cw-line')?.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('the Simple mode card shows the tick on the lines it lists', async () => {
    await aiCase({ level: 1, mode: 'simple' });
    await strip();
    expect(document.querySelectorAll('.cw-aitick')).toHaveLength(1);
  });

  it('with no read there is no tick', async () => {
    await aiCase({ level: 0 });
    await settle(40);
    expect(document.querySelector('.cw-aitick')).toBeNull();
  });
});

describe('the words come from the catalog', () => {
  it('a translation of the strip\'s words is used where an adopter supplies one, and English fills the gaps', async () => {
    const { createT, en } = await import('../src/i18n.js');
    const t = createT({ ...en, 'hub.ai.label': 'Lecture IA', 'hub.ai.tag': 'IA', 'hub.ai.cites.one': 'IA : {count} ligne citée', 'hub.ai.cites.other': 'IA : {count} lignes citées' } as never, 'fr');
    await aiCase({ level: 1, t });
    const region = await screen.findByRole('region', { name: 'Lecture IA' });
    expect(within(region).getByText('IA')).toBeInTheDocument();
    expect(within(region).getByText('IA : 1 ligne citée')).toBeInTheDocument();
    // A word the adopter did not translate comes from the strip's own English.
    expect(within(region).getByRole('button', { name: 'AI details' })).toBeInTheDocument();
  });
});

describe('the case page stays what it was', () => {
  it('the strip sits between the header and the transcript', async () => {
    await aiCase({ level: 1 });
    const region = await strip();
    const note = document.querySelector('.cw-note') as HTMLElement;
    const transcript = document.querySelector('.cw-transcript') as HTMLElement;
    expect(region.compareDocumentPosition(transcript) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(TALK.length).toBe(4);
  });
});

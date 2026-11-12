import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { fakeRead } from '@chatwarden/core';
import type { AIReadInput } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The queue's one AI chip: the severity word, neutral, with a text alternative, and nothing of the evidence. Against the real routes,
// with the scripted fake behind them.

const SUMMARY = 'The reported player was rude in chat.';

const reading = (severity: 'banter' | 'rude' | 'hostile' | 'severe', over: Record<string, unknown> = {}) => (input: AIReadInput) => {
  const base = fakeRead(input);
  return { output: { ...base, severity, recommendation: { ...base.recommendation, severity }, ...over } };
};

/** Files a report about `target` and lets the AI read it, so the next file is the next call. */
async function filed(w: HubWorld, target: string, at?: number) {
  const f = await w.file({ target });
  await w.aiIdle();
  if (at !== undefined) w.clock.t = at;
  return f;
}

const chips = (root: HTMLElement): HTMLElement[] => [...root.querySelectorAll<HTMLElement>('.cw-aichip')];
const chipOf = (li: HTMLElement): HTMLElement | null => li.querySelector<HTMLElement>('.cw-aichip');

async function reportsScreen(options: WorldOptions, targets: string[]) {
  cleanup();
  const w = await hubWorld({ actor: 'ann@example.test', ...options });
  for (const t of targets) await filed(w, t);
  const r = renderHub(w, { path: '/reports', mode: 'detailed' });
  await screen.findByRole('list', { name: 'Reported people' });
  // The chip is a lazy part: it is there a moment after the row.
  if (options.ai !== undefined && options.ai.script !== undefined) await waitFor(() => expect(r.container.querySelector('.cw-qrow .cw-aichip')).not.toBeNull());
  return { w, ...r };
}

describe('the chip on the Reports screen', () => {
  it('the queue chip shows the severity word and nothing of the evidence', async () => {
    const { container } = await reportsScreen({ ai: { level: 2, script: reading('hostile') } }, ['Mallory']);
    const row = container.querySelector('.cw-qrow') as HTMLElement;
    const chip = chipOf(row) as HTMLElement;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toMatch(/^AI read:\s*Hostile$/);
    // Nothing of the evidence: no summary, no rule, no line, no confidence in the row.
    expect(row.textContent).not.toContain(SUMMARY);
    expect(row.textContent).not.toMatch(/confidence|medium|cited|Rule 1/i);
    expect(chips(row)).toHaveLength(1);
  });

  it('the chip has a text alternative', async () => {
    const { container } = await reportsScreen({ ai: { level: 1, script: reading('severe') } }, ['Mallory']);
    const chip = chipOf(container.querySelector('.cw-qrow') as HTMLElement) as HTMLElement;
    // A screen reader hears what it is, not a bare word beside the reason chips.
    expect(chip.querySelector('.cw-sr')?.textContent).toMatch(/AI read/i);
    expect(chip).toHaveTextContent(/AI read.*Severe/);
    expect(chip.getAttribute('title')).toBe('AI read');
  });

  it('each of the four words is said', async () => {
    for (const sev of ['banter', 'rude', 'hostile', 'severe'] as const) {
      const { container } = await reportsScreen({ ai: { level: 1, script: reading(sev) } }, ['Mallory']);
      expect((chipOf(container.querySelector('.cw-qrow') as HTMLElement) as HTMLElement).textContent?.replace(/^AI read:?\s*/, '')).toBe(sev[0]!.toUpperCase() + sev.slice(1));
    }
  });

  it('with the AI off there is no chip', async () => {
    const { container } = await reportsScreen({}, ['Mallory']);
    expect(chips(container)).toHaveLength(0);
  });

  it('a case with no read yet has no chip', async () => {
    cleanup();
    const w = await hubWorld({ ai: { level: 1, script: [{ hang: true }] } });
    await w.file({ target: 'Mallory' });
    const { container } = renderHub(w, { path: '/reports', mode: 'detailed' });
    await screen.findByRole('list', { name: 'Reported people' });
    expect(chips(container)).toHaveLength(0);
  });

  it('a stale read or a suspected injection shows the same chip: the marks live only in AI details', async () => {
    const plain = await reportsScreen({ ai: { level: 1, script: reading('rude') } }, ['Mallory']);
    const before = chipOf(plain.container.querySelector('.cw-qrow') as HTMLElement)?.outerHTML;
    const flagged = await reportsScreen({ ai: { level: 1, script: reading('rude', { injectionSuspected: true }) } }, ['Mallory']);
    expect(chipOf(flagged.container.querySelector('.cw-qrow') as HTMLElement)?.outerHTML).toBe(before);
    expect(flagged.container.textContent).not.toMatch(/instruct|older rules|stale/i);
  });

  it('a decided case shows no chip', async () => {
    cleanup();
    const w = await hubWorld({ ai: { level: 1, script: reading('rude') } });
    const f = await filed(w, 'Mallory');
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    const { container } = renderHub(w, { path: '/reports?status=all', mode: 'detailed' });
    await screen.findByRole('list', { name: 'Reported people' });
    expect(chips(container)).toHaveLength(0);
  });
});

describe('the chip in the queue pane', () => {
  it('shows on the row of the case, in the Detailed hub, beside the reason chips', async () => {
    cleanup();
    const w = await hubWorld({ ai: { level: 1, script: reading('hostile') } });
    await filed(w, 'Mallory');
    renderHub(w, { path: '/', mode: 'detailed' });
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).queryByText('Loading the queue')).not.toBeInTheDocument());
    const row = within(pane).getAllByRole('listitem')[0] as HTMLElement;
    expect(chipOf(row)?.textContent).toMatch(/Hostile$/);
    expect(chips(row)).toHaveLength(1);
  });

  it('is left out of Simple mode, which stays calm', async () => {
    cleanup();
    const w = await hubWorld({ ai: { level: 1, script: reading('hostile') } });
    await filed(w, 'Mallory');
    renderHub(w, { path: '/', mode: 'simple' });
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).queryByText('Loading the queue')).not.toBeInTheDocument());
    expect(chips(pane)).toHaveLength(0);
  });
});

describe('the queue order with the AI on', () => {
  const names = (): string[] => [...document.querySelectorAll('.cw-case .cw-case-name')].map((n) => n.textContent ?? '');

  it('puts a severe read above a banter read that waited longer', async () => {
    cleanup();
    // Calls are numbered in the order the reports were filed: the first is banter, the second severe.
    const w = await hubWorld({
      ai: {
        level: 1,
        script: (input, ctx) => reading(ctx.call === 1 ? 'banter' : 'severe')(input),
      },
    });
    await filed(w, 'Calm');
    w.clock.t += 3_600_000;
    await filed(w, 'Angry');
    renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(names()).toEqual(['Angry', 'Calm']);
  });

  it('keeps the longest wait first when the AI is off (the sort is unchanged)', async () => {
    cleanup();
    const w = await hubWorld({});
    await filed(w, 'Calm');
    w.clock.t += 3_600_000;
    await filed(w, 'Angry');
    renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(names()).toEqual(['Calm', 'Angry']);
  });

  it('keeps the longest wait first when the AI is on but has read nothing yet', async () => {
    cleanup();
    const w = await hubWorld({ ai: { level: 1, script: [{ hang: true }, { hang: true }] } });
    await w.file({ target: 'Calm' });
    w.clock.t += 3_600_000;
    await w.file({ target: 'Angry' });
    renderHub(w, { path: '/', mode: 'detailed' });
    await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(names()).toHaveLength(2));
    expect(names()).toEqual(['Calm', 'Angry']);
  });
});

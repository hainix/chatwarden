import { screen, waitFor, within } from '@testing-library/react';
import { fakeRead } from '@chatwarden/core';
import type { AIReadInput } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { MINUTE, hubWorld } from './world.js';

// Take next says what it takes. In the oldest-first queue it is "Take next case, oldest unclaimed"; in the AI's priority order it is "Take next:
// highest priority", and it claims the top case of the list on screen. On the real routes, with the scripted fake behind them.

const pane = (): HTMLElement => screen.getByRole('region', { name: 'Open cases' });
const sev = (severities: string[]) => {
  let n = 0;
  return (input: AIReadInput) => {
    const severity = severities[Math.min(n++, severities.length - 1)] as 'banter';
    const base = fakeRead(input);
    return { output: { ...base, severity, recommendation: { ...base.recommendation, severity } } };
  };
};

async function loaded() {
  await screen.findByRole('region', { name: 'Open cases' });
  await waitFor(() => expect(within(pane()).queryByText('Loading the queue')).not.toBeInTheDocument());
}

async function world(ai: boolean) {
  const w = await hubWorld({ actor: 'ann@example.test', ...(ai ? { ai: { level: 1, script: sev(['banter', 'severe']) } } : {}) });
  const a = await w.file({ target: 'Alpha' });
  if (ai) await w.aiIdle();
  w.clock.t += MINUTE;
  const b = await w.file({ target: 'Bravo' });
  if (ai) await w.aiIdle();
  return { w, a, b };
}

describe('the Take next button', () => {
  it('without the AI: "Take next case" with "oldest unclaimed" under it', async () => {
    const { w } = await world(false);
    renderHub(w);
    await loaded();
    const button = within(pane()).getByRole('button', { name: /Take next case/ });
    expect(button).toHaveTextContent('oldest unclaimed');
    expect(within(pane()).queryByText('Take next: highest priority')).toBeNull();
  });

  it('in the AI\'s order: "Take next: highest priority", and no oldest unclaimed', async () => {
    const { w } = await world(true);
    renderHub(w);
    await loaded();
    await within(pane()).findByRole('button', { name: /Take next: highest priority/ });
    expect(within(pane()).queryByText('oldest unclaimed')).toBeNull();
  });

  it('in the AI\'s order it opens the case at the top of the list, not the one that waited longest', async () => {
    const { w, a, b } = await world(true);
    const { user, router } = renderHub(w);
    await loaded();
    await user.click(await within(pane()).findByRole('button', { name: /Take next: highest priority/ }));
    await waitFor(() => expect(router.path).toBe(`/reports/${b.id}`));
    expect(w.cw.cases.holder(b.person)?.by).toBe('ann@example.test');
    expect(w.cw.cases.holder(a.person)).toBeNull();
    expect(w.sent.filter((r) => r.path === '/cases/next')).toHaveLength(0);
  });

  it('the same button, when someone has taken the top case a moment before, opens the next one', async () => {
    const { w, a, b } = await world(true);
    const { user, router } = renderHub(w);
    await loaded();
    const button = await within(pane()).findByRole('button', { name: /Take next: highest priority/ });
    await w.clientFor('maya@example.test').claimCase(b.person);
    await user.click(button);
    await waitFor(() => expect(router.path).toBe(`/reports/${a.id}`));
    expect(w.cw.cases.holder(b.person)?.by).toBe('maya@example.test');
  });
});

import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine } from './world.js';

// axe over the report page and the decision panel in each state, in both themes. jsdom has no layout or painted colours, so
// `color-contrast` is off here (the real-browser run owns it); every other rule runs and any violation fails.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'you zorbak' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

const panel = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });

async function ready(w: HubWorld, id: string, theme: 'light' | 'dark') {
  const r = renderHub(w, { path: `/reports/${id}`, theme });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  await screen.findByText(/Has filed/);
  return r;
}

async function fill(user: UserEvent) {
  await user.click(within(panel()).getByRole('radio', { name: 'Fair' }));
  await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
  const group = within(panel()).getByRole('group', { name: 'Action 1' });
  const what = within(group).getByLabelText('What happens');
  await user.selectOptions(what, within(what).getByRole('option', { name: 'Warning' }));
  return group;
}

describe.each(['light', 'dark'] as const)('axe on the report page, %s theme', (theme) => {
  it('a fresh report', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK, note: 'Keeps following me.' });
    const { container } = await ready(w, f.id, theme);
    expect(container.querySelector('.cw-hub')).toHaveAttribute('data-cw-theme', theme);
    expect(await violations(container)).toEqual([]);
  });

  it('the person with a record, a silent reported person and a filter', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: [{ who: 'reporter', text: 'hi' }, { who: 'bystander', text: 'hm' }], cite: null });
    await w.sanction(f.person, 'warning');
    const { container, user } = await ready(w, f.id, theme);
    expect(screen.getByText('Mallory sent no messages in this excerpt.')).toBeInTheDocument();
    await user.click(within(screen.getByRole('group', { name: 'Show lines from' })).getByRole('button', { name: 'Only Bystander' }));
    expect(await violations(container)).toEqual([]);
  });

  it('the form with an action, lines and the gap note', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container, user } = await ready(w, f.id, theme);
    const group = await fill(user);
    const rule = within(group).getByLabelText('Community Rule');
    await user.selectOptions(rule, within(rule).getByRole('option', { name: 'No rule covers this' }));
    await user.click(within(group).getAllByRole('checkbox')[0]!);
    expect(await violations(container)).toEqual([]);
  });

  it('bad faith with its evidence box', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container, user } = await ready(w, f.id, theme);
    await user.click(within(panel()).getByRole('radio', { name: 'Bad faith' }));
    expect(await violations(container)).toEqual([]);
  });

  it('the list of problems and the fields they point at', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container, user } = await ready(w, f.id, theme);
    await user.click(within(panel()).getByRole('radio', { name: 'Bad faith' }));
    await user.click(within(panel()).getByRole('button', { name: 'Add an action' }));
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await within(panel()).findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('a server error with its Try again button', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container, user } = await ready(w, f.id, theme);
    await user.click(within(panel()).getByRole('radio', { name: 'Not a problem' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Fine.');
    w.intercept.fn = (req) => (req.path.endsWith('/decide') ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await within(panel()).findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('the result with its reference codes', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    const { container, user } = await ready(w, f.id, theme);
    const group = await fill(user);
    await user.click(within(group).getAllByRole('checkbox')[1]!);
    await user.type(within(panel()).getByRole('textbox', { name: 'Reason' }), 'Clear.');
    await user.click(within(panel()).getByRole('button', { name: 'Decide' }));
    await within(panel()).findByText('Decided. The report is closed.', { selector: 'strong' });
    await waitFor(() => expect(within(screen.getByRole('group', { name: 'About this report' })).getByText('Actioned')).toBeInTheDocument());
    expect(await violations(container)).toEqual([]);
  });

  it('a decided report with its decision', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ lines: TALK });
    await w.client.decide(f.id, { verdict: 'bad_faith', reason: 'Abuse.', evidence: 'They reported a friend.', actions: [] });
    const { container } = renderHub(w, { path: `/reports/${f.id}`, theme });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByText('They reported a friend.');
    expect(await violations(container)).toEqual([]);
  });

  it('a role that cannot decide', async () => {
    const w = await hubWorld({ permissions: { 'reports.decide': 'owner' } });
    const f = await w.fileRich({ lines: TALK });
    const { container } = renderHub(w, { path: `/reports/${f.id}`, theme });
    await within(await screen.findByRole('region', { name: 'Decision' })).findByText('Your role can read reports but not decide them.');
    expect(await violations(container)).toEqual([]);
  });

  it('a missing report', async () => {
    const w = await hubWorld();
    const { container } = renderHub(w, { path: '/reports/nope', theme });
    await screen.findByText('That no longer exists.');
    expect(await violations(container)).toEqual([]);
  });
});

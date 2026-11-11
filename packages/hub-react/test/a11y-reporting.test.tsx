import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { RichLine } from './world.js';

// The Reporting settings, the "No reason" Simple card and the case views under axe, in both themes and in each state a moderator meets;
// and the phone-width rules the stylesheet lays out (jsdom has no layout, so the structure and the rules are checked here and the pixels
// by the screenshots in the task report). `color-contrast` is off here: the screen adds no colour token, and the stylesheet's contrast is
// computed from its tokens by the static tests.
const RULES = { 'color-contrast': { enabled: false } } as const;
const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'a line from the target' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'another line from the target' },
];

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

describe.each(['light', 'dark'] as const)('axe on reporting, %s theme', (theme) => {
  async function open(options: Parameters<typeof hubWorld>[0] = { role: 'owner' }) {
    const w = await hubWorld(options);
    const r = renderHub(w, { theme, path: '/settings/reporting' });
    await screen.findByRole('list', { name: 'Reasons' });
    return { w, ...r };
  }

  it('the screen has no violations', async () => {
    const { container } = await open();
    expect(await violations(container)).toEqual([]);
  });

  it('each flow, with its picture, has none', async () => {
    const { container, user } = await open();
    for (const name of ['Pick a reason first', 'Reason required', 'One tap']) {
      await user.click(screen.getByRole('radio', { name }));
      expect(await violations(container)).toEqual([]);
    }
  });

  it('a row with its rules open, a new blank row and a marked field have none', async () => {
    const { container, user } = await open();
    const hate = within(screen.getByRole('group', { name: 'Reason: Hate' }));
    await user.click(hate.getByRole('button', { name: /^Rules/ }));
    expect(await violations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Add a reason' }));
    fireEvent.change(hate.getByLabelText('Name players see'), { target: { value: '' } });
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findAllByText('Give the reason a name players will understand.');
    expect(await violations(container)).toEqual([]);
  });

  it('the save question, a refusal and the reset question have none', async () => {
    const { container, user, w } = await open();
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await violations(container)).toEqual([]);
    w.intercept.fn = (req) => (req.method === 'PUT' ? { status: 400, body: { error: 'invalid_profile', message: 'no', path: 'layer.reporting.flow' } } : undefined);
    await user.type(screen.getByRole('textbox', { name: /Why are you changing this/ }), 'x');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText("That setting isn't allowed.");
    expect(await violations(container)).toEqual([]);
  });

  it('a role that only reads has none', async () => {
    const { container } = await open({ role: 'moderator' });
    expect(await violations(container)).toEqual([]);
  });

  it('the leave question has none', async () => {
    const { container, user } = await open();
    await user.click(screen.getByRole('radio', { name: 'Reason required' }));
    await user.click(screen.getByRole('link', { name: 'Steps and ladder' }));
    await screen.findByRole('dialog', { name: 'Leave without saving?' });
    expect(await violations(container)).toEqual([]);
  });
});

describe.each(['light', 'dark'] as const)('axe on the cases with reasons, %s theme', (theme) => {
  it('the Simple card that asks which rule, with a rule picked, and with a rule preselected', async () => {
    const w = await hubWorld();
    const none = await w.fileRich({ lines: TALK, reason: null });
    const first = renderHub(w, { mode: 'simple', theme, path: `/reports/${none.id}` });
    const picker = await screen.findByRole('combobox', { name: 'Which rule does this break?' });
    expect(await violations(first.container)).toEqual([]);
    await first.user.selectOptions(picker, '2');
    await waitFor(() => expect(within(screen.getByRole('region', { name: 'Decision' })).getAllByRole('button').length).toBeGreaterThan(2));
    expect(await violations(first.container)).toEqual([]);
    first.unmount();
    const known = await w.fileRich({ lines: TALK, target: 'Gamma', reason: 'harassment', room: 'g' });
    const second = renderHub(w, { mode: 'simple', theme, path: `/reports/${known.id}` });
    await screen.findByRole('combobox', { name: 'The rule it breaks' });
    expect(await violations(second.container)).toEqual([]);
  });

  it('the Detailed case with and without a reason, the queue filter and a reporter with an accuracy line have none', async () => {
    const w = await hubWorld({ role: 'owner' });
    for (let i = 0; i < 3; i += 1) {
      const f = await w.file({ target: `T${i}`, reporter: 'Rae', reason: 'harassment' });
      const subject = w.cw.rooms.subjectAt(f.room, 'p2') as string;
      await w.cw.decide({ reportId: f.id, verdict: 'upheld', actor: 'ann@example.test', reason: 'checked', actions: [{ subject, kind: 'warning', durationMs: null, rule: 2, lineIds: [] }] });
    }
    const a = await w.fileRich({ lines: TALK, reason: null, reporter: 'Rae' });
    const r = renderHub(w, { theme, path: `/reports/${a.id}` });
    await screen.findByRole('heading', { level: 2, name: /report against/ });
    await screen.findByText('Their reasons matched the decision 3 of 3 times.');
    expect(await violations(r.container)).toEqual([]);
  });
});

const css = readFileSync(join(process.cwd(), 'packages', 'hub-react', 'src', 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const block = (selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at));
};

describe('reporting on a phone (360px)', () => {
  it('every box of the screen can shrink and the fields share a row only while they fit', () => {
    for (const sel of ['.cw-hub .cw-reasons', '.cw-hub .cw-reason-fields', '.cw-hub .cw-flowopts', '.cw-hub .cw-mock', '.cw-hub .cw-scard-rule']) expect(block(sel), sel).toMatch(/min-width:\s*0/);
    expect(block('.cw-hub .cw-reason-fields')).toMatch(/minmax\(min\(100%,/);
  });

  it('the flags and the move buttons wrap instead of widening the row', () => {
    expect(block('.cw-hub .cw-reason-flags')).toMatch(/flex-wrap:\s*wrap/);
  });

  it('long words wrap inside the picture of what players see, and its width is capped', () => {
    expect(block('.cw-hub .cw-mock')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(block('.cw-hub .cw-mock')).toMatch(/max-width:\s*26rem/);
  });

  it('fields fill their row and never push past it', () => {
    expect(block('.cw-hub .cw-reason-fields input')).toMatch(/width:\s*100%/);
    expect(block('.cw-hub .cw-scard-rule select')).toMatch(/width:\s*100%/);
  });

  it('the screen holds the structure the layout lays out: one list, one card per reason, the picture last', async () => {
    const w = await hubWorld({ role: 'owner' });
    renderHub(w, { path: '/settings/reporting' });
    const list = await screen.findByRole('list', { name: 'Reasons' });
    expect(within(list).getAllByRole('group')).toHaveLength(10);
    expect(list.className).toContain('cw-reasons');
    const regions = screen.getAllByRole('region').map((r) => r.getAttribute('aria-labelledby') !== null && r.querySelector('h2')?.textContent);
    expect(regions.filter(Boolean).at(-1)).toBe('What players see');
  });
});

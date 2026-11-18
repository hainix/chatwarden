import { act, fireEvent, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHubController } from '../src/headless/controller.js';
import type { TransportRequest } from '../src/transport.js';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { WorldOptions } from './world.js';

// "Ask for a new name" in the case decision (0.2.0): a quiet row in the decision bar, one request with the decision, and what each answer says.

const FAKE = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;
const isDecide = (r: TransportRequest): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
const decides = (w: AppealsHub): TransportRequest[] => w.sent.filter(isDecide);
const bar = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
const rename = (): HTMLInputElement | null => within(bar()).queryByRole('checkbox', { name: 'Ask for a new name' });
const ruleOfRename = (): HTMLSelectElement => within(bar()).getByLabelText('The rule they are told') as HTMLSelectElement;
const world = (o: WorldOptions & { names?: Record<string, unknown> } = {}) => appealsHub({ names: { renames: true }, ...o });

afterEach(() => {
  vi.useRealTimers();
});

async function open(w: AppealsHub, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  w.clock.t += 400;
  return r;
}
const fair = (user: UserEvent) => user.click(within(bar()).getByRole('radio', { name: 'Fair' }));
const advance = (ms: number): Promise<void> =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
/** Edit opens the action editor: the disclosure the row hides behind for any reason but a name. */
const openEditor = async (user: UserEvent) => {
  await user.click(within(bar()).getByRole('button', { name: 'Change' }));
};

describe('the row', () => {
  it('is shown at once for a name report, starts unticked, and is behind the editor for any other reason', async () => {
    const w = await world();
    const name = await w.file({ target: 'Mallory', reason: 'name' });
    const { user, unmount } = await open(w, name.id);
    await fair(user);
    expect(rename()).not.toBeNull();
    expect(rename()?.checked).toBe(false);
    expect(within(bar()).getByText('They get a notice asking them to pick another name. This applies no sanction by itself.')).toBeInTheDocument();
    unmount();
    const other = await w.file({ target: 'Vlemmo', reason: 'harassment' });
    const second = await open(w, other.id);
    await fair(second.user);
    expect(rename()).toBeNull();
    await openEditor(second.user);
    expect(rename()).not.toBeNull();
    expect(rename()?.checked).toBe(false);
  });

  it('is absent with renames off', async () => {
    const w = await appealsHub();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const { user } = await open(w, f.id);
    await fair(user);
    expect(rename()).toBeNull();
  });

  it('is absent for a role without sanctions.apply', async () => {
    const w = await world({ permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const { user } = await open(w, f.id);
    await fair(user);
    expect(rename()).toBeNull();
  });

  it('is only for the verdict fair: not a problem and bad faith do not show it', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const { user } = await open(w, f.id);
    await fair(user);
    expect(rename()).not.toBeNull();
    await user.click(within(bar()).getByRole('radio', { name: 'Not a problem' }));
    expect(rename()).toBeNull();
    await user.click(within(bar()).getByRole('radio', { name: 'Bad faith' }));
    expect(rename()).toBeNull();
  });
});

describe('its rule', () => {
  it('starts on the first action\'s rule, else the report\'s, and is required', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const { user } = await open(w, f.id);
    await fair(user);
    await user.click(rename() as HTMLElement);
    // A name report's rule is CR 7 and the pre-filled action cites it too.
    expect(ruleOfRename().value).toBe('7');
    expect([...ruleOfRename().options].map((o) => o.value)).not.toContain('uncovered');
    await user.selectOptions(ruleOfRename(), '');
    await user.type(within(bar()).getByRole('textbox', { name: 'Reason' }), 'A name against the rules.');
    await user.click(within(bar()).getByRole('button', { name: 'Decide' }));
    expect(await within(bar()).findByRole('alert')).toHaveTextContent('Choose the rule this is under.');
    expect(decides(w)).toHaveLength(0);
  });

  it('a dismissal verdict clears the request and says so', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const { user } = await open(w, f.id);
    await fair(user);
    await user.click(rename() as HTMLElement);
    expect(rename()?.checked).toBe(true);
    await user.click(within(bar()).getByRole('radio', { name: 'Not a problem' }));
    expect(await within(bar()).findByText(/Removed the request for a new name\. Only a fair report can ask for one\./)).toBeInTheDocument();
    await fair(user);
    // Back to fair: the row is there again and is not ticked (it is a deliberate choice).
    expect(rename()?.checked).toBe(false);
  });
});

describe('the body sent', () => {
  async function send(w: AppealsHub, f: { id: string }, tick: boolean, reason = 'A name against the rules.') {
    const r = await open(w, f.id);
    await fair(r.user);
    if (tick) await r.user.click(rename() as HTMLElement);
    await r.user.type(within(bar()).getByRole('textbox', { name: 'Reason' }), reason);
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decide' }));
    return r;
  }

  it('has rename only when ticked, and nothing is sent before the hold ends', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await send(w, f, true);
    await advance(4_900);
    expect(decides(w)).toHaveLength(0);
    await advance(300);
    expect(decides(w)).toHaveLength(1);
    expect((decides(w)[0]?.body as { rename?: unknown }).rename).toEqual({ rule: 7 });
    await advance(200);
    expect(w.cw.names.pendingRename({ clientKey: 'key-target-Mallory' })).toBe(true);
  });

  it('is the plain body when not ticked', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await send(w, f, false);
    await advance(5_300);
    expect(decides(w)).toHaveLength(1);
    expect(Object.keys(decides(w)[0]?.body as object)).not.toContain('rename');
  });

  it('Undo sends nothing', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await send(w, f, true);
    await advance(1_000);
    fireEvent.click(within(screen.getByRole('region', { name: 'Notifications' })).getByRole('button', { name: 'Undo' }));
    await advance(6_000);
    expect(decides(w)).toHaveLength(0);
    expect(w.cw.names.pendingRename({ clientKey: 'key-target-Mallory' })).toBe(false);
  });

  // The form-to-server seam: the body the hub builds goes through the real http handler and the core service (the hub world's transport), not a mock.
  it.each([
    ['a note', 'note:null'],
    ['a warning', 'warning:null'],
  ] as const)('rename plus %s is accepted by the real server: the verdict sent is upheld and the player is asked', async (_name, what) => {
    const w = await world({ role: 'senior' });
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const r = await open(w, f.id);
    await fair(r.user);
    await openEditor(r.user);
    for (const remove of within(bar()).queryAllByRole('button', { name: /^Remove action/ })) await r.user.click(remove);
    await r.user.click(within(bar()).getByRole('button', { name: 'Add an action' }));
    await r.user.selectOptions(within(bar()).getAllByRole('combobox', { name: 'What happens' }).at(-1) as HTMLSelectElement, what);
    await r.user.selectOptions(within(bar()).getAllByLabelText('Community Rule').at(-1) as HTMLSelectElement, '7');
    await r.user.click(rename() as HTMLElement);
    await r.user.type(within(bar()).getByRole('textbox', { name: 'Reason' }), 'A name against the rules.');
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decide' }));
    await advance(5_300);
    vi.useRealTimers();
    expect((decides(w)[0]?.body as { verdict: string }).verdict).toBe('upheld');
    expect(await screen.findByText('They have been asked to choose a new name.')).toBeInTheDocument();
    expect(screen.queryByText(/did not accept/)).toBeNull();
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
    expect(w.cw.names.pendingRename({ clientKey: 'key-target-Mallory' })).toBe(true);
  });

  it.each([
    ['rename alone', 'none'],
    ['rename plus a warning', 'warning'],
    ['rename plus a ban', 'ban'],
  ] as const)('%s', async (_name, plus) => {
    const w = await world({ role: 'senior' });
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const r = await open(w, f.id);
    await fair(r.user);
    // The pre-filled suggestion is the person's step; start from no actions and add what the case needs.
    await openEditor(r.user);
    for (const remove of within(bar()).queryAllByRole('button', { name: /^Remove action/ })) await r.user.click(remove);
    if (plus !== 'none') {
      await r.user.click(within(bar()).getByRole('button', { name: 'Add an action' }));
      const what = within(bar()).getAllByRole('combobox', { name: 'What happens' }).at(-1) as HTMLSelectElement;
      await r.user.selectOptions(what, plus === 'ban' ? 'ban:null' : 'warning:null');
      const rules = within(bar()).getAllByLabelText('Community Rule');
      await r.user.selectOptions(rules.at(-1) as HTMLSelectElement, '7');
    }
    await r.user.click(rename() as HTMLElement);
    await r.user.type(within(bar()).getByRole('textbox', { name: 'Reason' }), 'A name against the rules.');
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decide' }));
    await advance(5_300);
    const body = decides(w)[0]?.body as { rename?: unknown; actions: Array<{ kind: string }> };
    expect(body.rename).toEqual({ rule: 7 });
    expect(body.actions.map((a) => a.kind)).toEqual(plus === 'none' ? [] : [plus]);
  });
});

describe('each answer shows the right line and keeps the decision', () => {
  async function decided(w: AppealsHub, id: string, tick = true) {
    const r = await open(w, id);
    await fair(r.user);
    if (tick) await r.user.click(rename() as HTMLElement);
    await r.user.type(within(bar()).getByRole('textbox', { name: 'Reason' }), 'A name against the rules.');
    vi.useFakeTimers({ toFake: [...FAKE] });
    fireEvent.click(within(bar()).getByRole('button', { name: 'Decide' }));
    await advance(5_300);
    vi.useRealTimers();
    return r;
  }

  it('asked: "They have been asked to choose a new name."', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await decided(w, f.id);
    expect(await screen.findByText('They have been asked to choose a new name.')).toBeInTheDocument();
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('already: "They have already been asked to choose a new name."', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await w.client.rename(f.person, { reason: 'first', rule: 7 });
    await decided(w, f.id);
    expect(await screen.findByText('They have already been asked to choose a new name.')).toBeInTheDocument();
    expect(w.cw.reports.get(f.id)?.status).toBe('actioned');
  });

  it('failed: "Decision recorded, but asking for a new name did not go through." with a way to their page; the decision stands', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    // The setting is switched off between the form and the send, after the decision is written: the answer says failed.
    w.intercept.fn = (req) =>
      isDecide(req) ? { status: 200, headers: {}, body: { ok: true, replay: false, groups: [], rename: { status: 'failed', error: 'off' } } } : undefined;
    await decided(w, f.id);
    expect(await screen.findByText(/Decision recorded, but asking for a new name did not go through\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open their page to ask again.' })).toHaveAttribute('href', expect.stringContaining(f.person));
  });

  it('a 404 before any write (renames switched off since the form opened) returns the form with its error', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    w.intercept.fn = (req) => (isDecide(req) ? { status: 404, headers: {}, body: { error: 'not_found', message: 'x' } } : undefined);
    await decided(w, f.id);
    expect(await within(bar()).findByRole('alert')).toBeInTheDocument();
    expect(within(bar()).getByRole('radio', { name: 'Fair' })).toBeChecked();
    expect(rename()?.checked).toBe(true);
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
  });

  it('no rename line when none was asked', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    await decided(w, f.id, false);
    await screen.findAllByText('Decided. The report is closed.');
    expect(screen.queryByText(/choose a new name/)).toBeNull();
  });
});

describe('the headless controller does the same without the shell', () => {
  it('submits the rename and exposes the answer on the done entry', async () => {
    const w = await world();
    const f = await w.file({ target: 'Mallory', reason: 'name' });
    const controller = createHubController({ client: w.client, now: w.now });
    const outcome = await controller.decisions.submit(
      {
        reportId: f.id,
        person: f.person,
        name: 'Mallory',
        input: { verdict: 'upheld', reason: 'A name against the rules.', actions: [], rename: { rule: 7 } },
        snapshot: { verdict: 'fair', evidence: '', reason: 'A name against the rules.', actions: [], rename: { rule: '7' } },
      },
      { hold: false },
    );
    expect(outcome).toMatchObject({ status: 'done', rename: 'asked' });
    expect(controller.decisions.entry(f.id)?.state).toMatchObject({ status: 'done', rename: 'asked' });
    const again = await controller.decisions.submit(
      {
        reportId: f.id,
        person: f.person,
        name: 'Mallory',
        input: { verdict: 'upheld', reason: 'A name against the rules.', actions: [], rename: { rule: 7 } },
        snapshot: { verdict: 'fair', evidence: '', reason: 'A name against the rules.', actions: [], rename: { rule: '7' } },
      },
      { hold: false },
    );
    expect(again).toMatchObject({ status: 'done' });
    controller.dispose();
  });
});

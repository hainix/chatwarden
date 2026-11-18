import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The staff comment thread on a case (design 6): behind `desk.workflow`, plain text, names and times, a remove link on your own comments
// (and on any for a senior), a 500-character counter in code points, "Do not paste chat here.". Real routes, real kit.

const ON: WorldOptions = { overrides: { desk: { workflow: true } } };
type User = ReturnType<typeof renderHub>['user'];

async function caseOf(opts: WorldOptions = {}, reason = 'spam') {
  const w = await hubWorld({ ...ON, ...opts });
  const f = await w.file({ target: 'Mallory', reason });
  return { w, f };
}
async function open(w: HubWorld, id: string, extra: Parameters<typeof renderHub>[1] = {}) {
  const r = renderHub(w, { path: `/reports/${id}`, ...extra });
  await screen.findByRole('tablist');
  return r;
}
async function thread(user: User): Promise<HTMLElement> {
  await user.click(await screen.findByRole('tab', { name: /^Staff comments/ }));
  return screen.findByRole('region', { name: 'Staff comments' });
}
const box = (t: HTMLElement): HTMLTextAreaElement => within(t).getByRole('textbox', { name: 'Add a comment' }) as HTMLTextAreaElement;
const posts = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && r.path.endsWith('/comments'));

describe('with workflow off', () => {
  it('there is no tab, no thread and no comment request', async () => {
    const { w, f } = await caseOf({ overrides: {} });
    await open(w, f.id);
    expect(screen.queryByRole('tab', { name: /Staff comments/ })).toBeNull();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Evidence', 'Reports (1)', 'History']);
    expect(w.sent.filter((r) => r.path.includes('comments'))).toEqual([]);
  });
});

describe('with workflow on', () => {
  it('a tab counts the entries, and the thread is its own lazy part (the Do not paste chat here line is always there)', async () => {
    const { w, f } = await caseOf();
    await w.direct.addComment(f.id, 'first');
    const { user } = await open(w, f.id);
    expect(screen.getByRole('tab', { name: 'Staff comments (1)' })).toBeInTheDocument();
    const t = await thread(user);
    expect(within(t).getByText('Do not paste chat here.')).toBeInTheDocument();
    expect(within(t).getByText('first')).toBeInTheDocument();
  });

  it('shows who wrote it and when, and the role, in the order written; an empty thread says so', async () => {
    const { w, f } = await caseOf({ actor: 'ann@example.test' });
    const { user, unmount } = await open(w, f.id);
    const t = await thread(user);
    expect(within(t).getByText('No comments yet.')).toBeInTheDocument();
    unmount();
    await w.clientFor('bea@example.test', 'senior').addComment(f.id, 'Looks real to me');
    w.clock.t += 60_000;
    await w.direct.addComment(f.id, 'I will watch the room');
    const again = await open(w, f.id);
    const list = within(await thread(again.user)).getByRole('list', { name: 'Staff comments' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('bea');
    expect(items[0]).toHaveTextContent('Looks real to me');
    expect(items[0]).toHaveTextContent('Senior');
    expect(items[1]).toHaveTextContent('ann');
    expect(items[1]?.querySelector('time')).not.toBeNull();
  });

  it('adds a comment: sent as text, shown at once, the box emptied', async () => {
    const { w, f } = await caseOf();
    const { user } = await open(w, f.id);
    const t = await thread(user);
    await user.type(box(t), 'Checking the logs');
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(within(t).getByText('Checking the logs')).toBeInTheDocument());
    expect(posts(w)).toHaveLength(1);
    expect(posts(w)[0]?.body).toEqual({ text: 'Checking the logs' });
    expect(box(t).value).toBe('');
  });

  it('renders a script tag and a markdown link literally, and strips nothing the server kept', async () => {
    const { w, f } = await caseOf();
    await w.direct.addComment(f.id, '<script>alert(1)</script> [click](https://x.test) **bold** &amp;');
    const { user } = await open(w, f.id);
    const t = await thread(user);
    expect(t.textContent).toContain('<script>alert(1)</script> [click](https://x.test) **bold** &amp;');
    expect(t.querySelector('.cw-thread-text script, .cw-thread-text a, .cw-thread-text strong, .cw-thread-text em, .cw-thread-text img')).toBeNull();
  });

  it('counts in code points: 1000 emoji read as 1000 (not 2000), 501 are refused, 500 are sent', async () => {
    const { w, f } = await caseOf();
    const { user } = await open(w, f.id);
    const t = await thread(user);
    const emoji = '\u{1F600}';
    fireEvent.change(box(t), { target: { value: emoji.repeat(1000) } });
    expect(within(t).getByText('1,000 of 500 characters')).toBeInTheDocument();
    fireEvent.change(box(t), { target: { value: emoji.repeat(501) } });
    expect(within(t).getByText('501 of 500 characters')).toBeInTheDocument();
    expect(within(t).getByText('Keep a comment to 500 characters or fewer.')).toBeInTheDocument();
    expect(box(t)).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    expect(posts(w)).toHaveLength(0);
    fireEvent.change(box(t), { target: { value: emoji.repeat(500) } });
    expect(within(t).queryByText(/Keep a comment/)).toBeNull();
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(posts(w)).toHaveLength(1));
  });

  it('an empty comment is not sent, and the button says why', async () => {
    const { w, f } = await caseOf();
    const { user } = await open(w, f.id);
    const t = await thread(user);
    await user.type(box(t), '   ');
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    expect(posts(w)).toHaveLength(0);
  });

  it('a full thread (50 entries) says so in words', async () => {
    const { w, f } = await caseOf();
    for (let i = 0; i < 50; i += 1) await w.direct.addComment(f.id, `n${i}`);
    const { user } = await open(w, f.id);
    const t = await thread(user);
    await user.type(box(t), 'one more');
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    expect(await within(t).findByText('This thread is full (50 entries).')).toBeInTheDocument();
    expect(within(t).getByRole('alert')).toBeInTheDocument();
  });

  it('a failed send keeps what was typed and says so', async () => {
    const { w, f } = await caseOf();
    const { user } = await open(w, f.id);
    const t = await thread(user);
    w.intercept.fn = (req) => (req.method === 'POST' && req.path.endsWith('/comments') ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await user.type(box(t), 'keep me');
    await user.click(within(t).getByRole('button', { name: 'Add comment' }));
    expect(await within(t).findByRole('alert')).toBeInTheDocument();
    expect(box(t).value).toBe('keep me');
  });
});

describe('removing a comment', () => {
  it('a moderator sees Remove on their own comments only', async () => {
    const { w, f } = await caseOf({ actor: 'ann@example.test' });
    await w.direct.addComment(f.id, 'mine');
    w.clock.t += 1000;
    await w.clientFor('bea@example.test').addComment(f.id, 'theirs');
    const { user } = await open(w, f.id);
    const t = await thread(user);
    const items = within(t).getAllByRole('listitem');
    expect(within(items[0] as HTMLElement).getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('a senior sees Remove on every comment', async () => {
    const { w, f } = await caseOf({ role: 'senior', actor: 'sam@example.test' });
    await w.clientFor('ann@example.test').addComment(f.id, 'a');
    w.clock.t += 1000;
    await w.clientFor('bea@example.test').addComment(f.id, 'b');
    const { user } = await open(w, f.id);
    const t = await thread(user);
    expect(within(t).getAllByRole('button', { name: 'Remove' })).toHaveLength(2);
  });

  it('removes it for good, and the entry goes from the thread', async () => {
    const { w, f } = await caseOf({ actor: 'ann@example.test' });
    await w.direct.addComment(f.id, 'oops');
    const { user } = await open(w, f.id);
    const t = await thread(user);
    await user.click(within(t).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(within(t).queryByText('oops')).toBeNull());
    expect((await w.direct.getReport(f.id)).report.comments).toEqual([]);
  });

  it('the ask and the look entries have no Remove (they are the record of a second look)', async () => {
    const { w, f } = await caseOf({ actor: 'ann@example.test' });
    await w.direct.escalate(f.id, { to: 'senior', note: 'please look' });
    const { user } = await open(w, f.id);
    const t = await thread(user);
    expect(within(t).getByText('please look')).toBeInTheDocument();
    expect(within(t).queryByRole('button', { name: 'Remove' })).toBeNull();
  });
});

describe('a second look in the thread', () => {
  it('words the ask, the escalation and the look, with the note beside each', async () => {
    const { w, f } = await caseOf({ actor: 'ann@example.test' });
    await w.direct.escalate(f.id, { to: 'senior', note: 'new to me' });
    w.clock.t += 1000;
    await w.clientFor('sam@example.test', 'senior').clearEscalation(f.id);
    w.clock.t += 1000;
    await w.direct.escalate(f.id, { to: 'owner' });
    const { user } = await open(w, f.id);
    const t = await thread(user);
    const items = within(t).getAllByRole('listitem').map((i) => i.textContent ?? '');
    expect(items[0]).toContain('asked a senior to look');
    expect(items[0]).toContain('new to me');
    expect(items[1]).toContain('marked it as looked at');
    expect(items[2]).toContain('asked the owner to look');
  });
});

describe('Simple mode', () => {
  it('has the thread behind one disclosure on the card, only with workflow on', async () => {
    const { w, f } = await caseOf();
    await w.direct.addComment(f.id, 'a note');
    const { user } = renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    const toggle = await screen.findByRole('button', { name: 'Staff comments (1)' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(await screen.findByText('a note')).toBeInTheDocument();
  });

  it('with workflow off the card has no such button', async () => {
    const { w, f } = await caseOf({ overrides: {} });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple' });
    await screen.findByRole('region', { name: /Case against/ });
    expect(screen.queryByRole('button', { name: /Staff comments/ })).toBeNull();
  });
});

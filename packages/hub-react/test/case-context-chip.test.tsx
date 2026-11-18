import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { WorldOptions } from './world.js';
import type { HubWorld } from './world.js';

// M3: the context chip on a case. It appears only when the report's room had a context AND the server's list of contexts (`GET /policy/contexts`) is not empty; it shows the context's label (the
// name when it has none, or when the server does not declare it). A report with no context asks nothing, and a kit with none declared draws nothing. Real routes, real kit.

afterEach(() => cleanup());

const CONTEXTS: NonNullable<NonNullable<WorldOptions['overrides']>['contexts']> = { kids: { label: 'Kids rooms', pace: { slowModeMs: 3000 } }, ranked: { profanity: { mode: 'allow' } } };

const contextRequests = (w: HubWorld) => w.sent.filter((r) => r.method === 'GET' && r.path === '/policy/contexts');

async function openDetailed(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('tablist');
  return r;
}

describe('the chip, in the Detailed case', () => {
  it('shows the label of the context the room had, once the list of contexts has come', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    await openDetailed(w, f.id);
    const found = await screen.findByLabelText('Room type: Kids rooms');
    expect(found).toHaveTextContent('Kids rooms');
    expect(contextRequests(w)).toHaveLength(1);
  });

  it('shows the name when the context has no label', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'ranked' } });
    await openDetailed(w, f.id);
    expect(await screen.findByLabelText('Room type: ranked')).toHaveTextContent('ranked');
  });

  it('shows an undeclared name as written, when at least one context is declared (a typo in a game\'s code is visible)', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kidz' } });
    await openDetailed(w, f.id);
    expect(await screen.findByLabelText('Room type: kidz')).toHaveTextContent('kidz');
  });

  it('one context, declared and used in every room, still shows it (the kind of room is information)', async () => {
    const w = await hubWorld({ overrides: { contexts: { only: { label: 'The only kind' } } } });
    const a = await w.fileRich({ tags: { context: 'only' } });
    const b = await w.fileRich({ tags: { context: 'only' }, target: 'Quissel', reporter: 'Tarvo' });
    const first = await openDetailed(w, a.id);
    expect(await screen.findByLabelText('Room type: The only kind')).toBeInTheDocument();
    first.unmount();
    await openDetailed(w, b.id);
    expect(await screen.findByLabelText('Room type: The only kind')).toBeInTheDocument();
  });

  it('a report with no context asks nothing and draws no chip', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({});
    await openDetailed(w, f.id);
    await screen.findByText(/Filed/);
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
    expect(contextRequests(w)).toEqual([]);
  });

  it('with no context declared nothing renders, even for a report whose room carried a tag', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ tags: { context: 'kids' } });
    await openDetailed(w, f.id);
    await waitFor(() => expect(contextRequests(w)).toHaveLength(1));
    await screen.findByText(/Filed/);
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
  });

  it('a moderator who may not read the policy asks nothing and sees no chip', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS }, permissions: { 'policy.read': 'owner' } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    await openDetailed(w, f.id);
    await screen.findByText(/Filed/);
    expect(contextRequests(w)).toEqual([]);
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
  });

  it('a failed list leaves the case as it was: no chip, no error block', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    w.intercept.fn = (req) => (req.path === '/policy/contexts' ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await openDetailed(w, f.id);
    await waitFor(() => expect(contextRequests(w)).toHaveLength(1));
    await screen.findByText(/Filed/);
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a label is text: markup in it is never made into markup', async () => {
    const w = await hubWorld({ overrides: { contexts: { kids: { label: '<img src=x onerror=alert(1)>' } } } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    const { container } = await openDetailed(w, f.id);
    expect(await screen.findByLabelText('Room type: <img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });

  it('the chip is not a control: nothing to click or focus', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    await openDetailed(w, f.id);
    const found = await screen.findByLabelText('Room type: Kids rooms');
    expect(found.closest('button, a')).toBeNull();
    expect(found.getAttribute('tabindex')).toBeNull();
  });
});

describe('the chip, in the Simple case', () => {
  it('shows the label on the card and asks once', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({ tags: { context: 'kids' } });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    const card = await screen.findByRole('region', { name: /^Case against/ });
    expect(await within(card).findByLabelText('Room type: Kids rooms')).toBeInTheDocument();
    expect(contextRequests(w)).toHaveLength(1);
  });

  it('draws nothing for a report with no context', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS } });
    const f = await w.fileRich({});
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    await screen.findByRole('region', { name: /^Case against/ });
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
    expect(contextRequests(w)).toEqual([]);
  });
});

describe('a scoped moderator', () => {
  it('reads the report\'s context but asks for no list of contexts (the route is not theirs), so no chip', async () => {
    const w = await hubWorld({ overrides: { contexts: CONTEXTS }, role: 'senior', scope: ['creator:alice'] });
    const f = await w.fileRich({ tags: { context: 'kids', scope: 'creator:alice' } });
    await openDetailed(w, f.id);
    await screen.findByText(/Filed/);
    expect(contextRequests(w)).toEqual([]);
    expect(screen.queryByLabelText(/^Room type:/)).toBeNull();
  });
});

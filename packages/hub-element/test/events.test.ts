import { waitFor } from '@testing-library/dom';
import { describe, expect, it } from 'vitest';
import type { CwDecidedDetail, CwNavigateDetail } from '../src/index.js';
import { decides, goTo, hubShown, inside, mount, pageHides } from './helpers.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// cw-navigate and cw-decided: DOM events that bubble and cross the shadow root, so a page listens on the element, on body or on
// document.

function record<T>(target: EventTarget, type: string): CustomEvent<T>[] {
  const seen: CustomEvent<T>[] = [];
  target.addEventListener(type, (e) => seen.push(e as CustomEvent<T>));
  return seen;
}

async function decideRestrict(w: HubWorld) {
  const f = await w.fileRich();
  goTo(`/reports/${f.id}`);
  const el = mount({ mode: 'simple' }, { client: w.client });
  const q = inside(el);
  (await q.findByRole('button', { name: /^Restrict chat, 24 hours/ }, { timeout: 5000 })).click();
  await waitFor(() => expect(q.queryAllByRole('button', { name: /^Undo/ })).not.toHaveLength(0));
  return { el, f, q };
}

describe('cw-navigate', () => {
  it('fires when the hub first shows, with the route and the path', async () => {
    const w = await hubWorld();
    goTo('/blocked');
    const seen = record<CwNavigateDetail>(document.body, 'cw-navigate');
    const el = mount({}, { client: w.client });
    await hubShown(el);
    await waitFor(() => expect(seen.length).toBeGreaterThan(0));
    expect(seen[0]?.detail.path).toBe('/blocked');
    expect(seen[0]?.detail.route).toMatchObject({ name: 'blocked' });
  });

  it('fires again for each move, once per path', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    const seen = record<CwNavigateDetail>(el, 'cw-navigate');
    await hubShown(el);
    await waitFor(() => expect(seen.length).toBe(1));
    goTo('/audit');
    await waitFor(() => expect(seen.length).toBe(2));
    expect(seen[1]?.detail).toMatchObject({ path: '/audit', route: { name: 'audit' } });
    // The same path again is not a move.
    goTo('/audit');
    await new Promise((r) => setTimeout(r, 30));
    expect(seen).toHaveLength(2);
  });

  it('bubbles and is composed, so it crosses the shadow root to the document', async () => {
    const w = await hubWorld();
    const el = mount({}, { client: w.client });
    const onDocument: Event[] = [];
    document.addEventListener('cw-navigate', (e) => onDocument.push(e));
    await hubShown(el);
    await waitFor(() => expect(onDocument.length).toBeGreaterThan(0));
    const e = onDocument[0] as CustomEvent;
    expect(e.bubbles).toBe(true);
    expect(e.composed).toBe(true);
    // A page listener sees the host as the target (the shadow root hides what is inside).
    expect(e.target).toBe(el);
  });
});

describe('cw-decided', () => {
  it('fires once the server has taken the decision, with the report id and the verdict', async () => {
    const w = await hubWorld();
    const { el, f } = await decideRestrict(w);
    const seen = record<CwDecidedDetail>(el, 'cw-decided');
    // Held for Undo: nothing has been decided yet, so nothing is announced.
    expect(seen).toHaveLength(0);
    pageHides();
    await waitFor(() => expect(seen).toHaveLength(1));
    const sent = decides(w)[0]?.body as { verdict: string };
    expect(seen[0]?.detail).toEqual({ reportId: f.id, verdict: sent.verdict });
    expect(seen[0]?.bubbles).toBe(true);
    expect(seen[0]?.composed).toBe(true);
  });

  it('crosses the shadow root: the document hears it, with the element as the target', async () => {
    const w = await hubWorld();
    const { el } = await decideRestrict(w);
    const onDocument = record<CwDecidedDetail>(document, 'cw-decided');
    pageHides();
    await waitFor(() => expect(onDocument).toHaveLength(1));
    expect(onDocument[0]?.target).toBe(el);
  });

  it('a decision sent as the element is removed is announced too, on the element itself (it has left the page, so the page cannot hear it)', async () => {
    const w = await hubWorld();
    const { el, f } = await decideRestrict(w);
    const seen = record<CwDecidedDetail>(el, 'cw-decided');
    el.remove();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    await waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.detail.reportId).toBe(f.id);
  });

  it('is not fired for a decision the server refused (a 500) or one that was only replayed', async () => {
    const w = await hubWorld();
    w.intercept.fn = (req) => (req.method === 'POST' && req.path.endsWith('/decide') ? { status: 500, body: { error: 'boom' } } : undefined);
    const { el } = await decideRestrict(w);
    const seen = record<CwDecidedDetail>(el, 'cw-decided');
    pageHides();
    await waitFor(() => expect(decides(w)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen).toHaveLength(0);

    const w2 = await hubWorld();
    w2.intercept.fn = (req) => (req.method === 'POST' && req.path.endsWith('/decide') ? { status: 200, body: { ok: true, replay: true, groups: [] } } : undefined);
    const second = await decideRestrict(w2);
    const seen2 = record<CwDecidedDetail>(second.el, 'cw-decided');
    pageHides();
    await waitFor(() => expect(decides(w2)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(seen2).toHaveLength(0);
  });

  it('the client the page handed in is not changed: the element only watches it', async () => {
    const w = await hubWorld();
    const before = w.client.decide;
    const el = mount({}, { client: w.client });
    await hubShown(el);
    expect(w.client.decide).toBe(before);
    expect(el.client).toBe(w.client);
  });
});

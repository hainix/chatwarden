import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// Legal hold on the case (design 6): "Hold for legal..." for `legal.hold` (a senior's), "Release hold..." for the owner, each a short dialog; the hold takes one of the closed
// reasons and no free text; a held report shows a quiet line to everyone who can read it; a 409 reads in words.

afterEach(() => cleanup());

const world = (o: WorldOptions = {}) => hubWorld({ role: 'senior', actor: 'sen_gus', ...o });
const holds = (w: HubWorld) => w.sent.filter((r) => /\/hold$/.test(r.path));

async function openCase(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}`, stay: true });
  await screen.findAllByRole('heading', { level: 2 });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const more = () => screen.findByRole('button', { name: 'Legal hold' });

describe('the item shows for legal.hold', () => {
  it('a senior has "Hold for legal..." behind one `...`; a moderator has nothing; nobody has it drawn when closed', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openCase(w, f.id);
    const button = await more();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Hold for legal...' })).toBeNull();
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Hold for legal...' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Release hold...' })).toBeNull();
    cleanup();
    const m = await world({ role: 'moderator' });
    const g = await m.file();
    await openCase(m, g.id);
    expect(screen.queryByRole('button', { name: 'Legal hold' })).toBeNull();
    expect(m.sent.filter((r) => /hold|bundle|privacy/.test(r.path))).toEqual([]);
  });

  it('follows the permission: lowered to moderator a moderator has it, raised to owner a senior has not', async () => {
    const low = await world({ role: 'moderator', permissions: { 'legal.hold': 'moderator' } });
    const a = await low.file();
    await openCase(low, a.id);
    expect(await more()).toBeInTheDocument();
    cleanup();
    const high = await world({ permissions: { 'legal.hold': 'owner' } });
    const b = await high.file();
    await openCase(high, b.id);
    expect(screen.queryByRole('button', { name: 'Legal hold' })).toBeNull();
  });
});

describe('holding', () => {
  it('offers the closed list of reasons and no free text, sends the one chosen, and shows the quiet line after', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openCase(w, f.id);
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Hold for legal...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hold this report' });
    const picker = within(dialog).getByRole('combobox', { name: 'Reason' }) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.value)).toEqual(['law_enforcement_request', 'legal_proceeding', 'platform_request', 'safety_review', 'other']);
    expect([...picker.options].map((o) => o.textContent)).toEqual(['A law enforcement request', 'A legal proceeding', 'A request from the platform', 'A safety review', 'Another reason']);
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(dialog).toHaveTextContent('This is not a legal conclusion.');
    await user.selectOptions(picker, 'safety_review');
    await user.click(within(dialog).getByRole('button', { name: 'Hold report' }));
    await waitFor(() => expect(holds(w)).toHaveLength(1));
    expect(holds(w)[0]).toMatchObject({ method: 'PUT', path: `/reports/${f.id}/hold`, body: { code: 'safety_review' } });
    expect(await screen.findByText(/Held for legal reasons: a safety review\./)).toBeInTheDocument();
    expect(w.store.loadHold(f.id)).toMatchObject({ code: 'safety_review', heldBy: 'sen_gus' });
    expect(w.cw.audit.list({ limit: 50 }).items.some((a) => a.action === 'legal.hold' && a.actor === 'sen_gus')).toBe(true);
    // a senior who is not the owner has no release item on a held report
    expect(screen.queryByRole('button', { name: 'Legal hold' })).toBeNull();
  });

  it('a 409 reads in words and keeps the dialog open', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openCase(w, f.id);
    // another senior holds it between the page load and the click
    await w.cw.legal.hold(f.id, { code: 'other', actor: 'senior_bea' });
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Hold for legal...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hold this report' });
    await user.click(within(dialog).getByRole('button', { name: 'Hold report' }));
    expect(await within(dialog).findByText('This report is already held.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Hold this report' })).toBeInTheDocument();
    expect(w.store.loadHold(f.id)?.heldBy).toBe('senior_bea');
  });

  it('Cancel closes it and holds nothing', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openCase(w, f.id);
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Hold for legal...' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(holds(w)).toEqual([]);
  });
});

describe('a held report', () => {
  it('shows the quiet line to a moderator too, with no item and no word about who held it', async () => {
    const w = await world({ role: 'moderator' });
    const f = await w.file();
    await w.cw.legal.hold(f.id, { code: 'law_enforcement_request', actor: 'senior_secret_name' });
    await openCase(w, f.id);
    expect(await screen.findByText(/Held for legal reasons: a law enforcement request\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legal hold' })).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('senior_secret_name');
  });

  it('the owner has "Release hold..."; a senior who may hold has not; releasing reads in words and the line goes', async () => {
    const s = await world();
    const f = await s.file();
    await s.cw.legal.hold(f.id, { code: 'other', actor: 'senior_bea' });
    await openCase(s, f.id);
    expect(await screen.findByText(/Held for legal reasons: another reason\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Legal hold' })).toBeNull();
    cleanup();

    const o = await hubWorld({ role: 'owner', actor: 'owen@example.test' });
    const g = await o.file();
    await o.cw.legal.hold(g.id, { code: 'other', actor: 'senior_bea' });
    const { user } = await openCase(o, g.id);
    await user.click(await more());
    expect(screen.queryByRole('button', { name: 'Hold for legal...' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Release hold...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Release the hold' });
    expect(dialog).toHaveTextContent('the next retention pass removes it');
    await user.click(within(dialog).getByRole('button', { name: 'Release hold' }));
    await waitFor(() => expect(holds(o).filter((r) => r.method === 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Held for legal reasons/)).toBeNull());
    expect(o.store.loadHold(g.id)).toMatchObject({ releasedBy: 'owen@example.test' });
  });

  it('draws no raw id, hash or secret in the line or the dialogs', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openCase(w, f.id);
    await user.click(await more());
    await user.click(screen.getByRole('button', { name: 'Hold for legal...' }));
    const dialog = await screen.findByRole('dialog');
    for (const bad of [f.id, f.person, 'hub-react-test-secret', 'key-target']) expect(dialog.textContent ?? '', bad).not.toContain(bad);
  });
});

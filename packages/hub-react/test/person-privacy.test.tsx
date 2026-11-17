import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';

// The Person page's "Data requests" (privacy requests, design 5.2): "Export data..." and "Erase data..." behind one quiet `...` button, for the owner only. Export downloads
// at once; the server audits it first, so a failed audit shows an error and downloads nothing. Nothing of it is drawn for a moderator or a senior.

afterEach(() => cleanup());

const world = (o: WorldOptions = {}) => hubWorld({ role: 'owner', actor: 'owen@example.test', ...o });
const exports = (w: HubWorld) => w.sent.filter((r) => r.method === 'GET' && /^\/people\/[^/]+\/privacy\/export$/.test(r.path));

/** What the page hands to the browser as a file: the saved name, and the text of the blob. */
function stubDownloads() {
  const saved: Array<{ name: string; blob: Blob }> = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: (b: Blob) => {
      const url = `blob:test-${++n}`;
      blobs.set(url, b);
      return url;
    },
    revokeObjectURL: () => undefined,
  }));
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, blob: blobs.get(this.href) as Blob });
  });
  return { saved, restore: () => click.mockRestore() };
}

let downloads: ReturnType<typeof stubDownloads>;
beforeEach(() => {
  downloads = stubDownloads();
});
afterEach(() => {
  downloads.restore();
  vi.unstubAllGlobals();
});

async function openPerson(w: HubWorld, person: string) {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  return r;
}
const menu = () => screen.findByRole('button', { name: 'Data requests' });

describe('the Person items are absent for a moderator and a senior and present for the owner', () => {
  it('only the owner is offered "Data requests"; the page is otherwise the same', async () => {
    const o = await world();
    const f = await o.file();
    await openPerson(o, f.person);
    expect(await menu()).toBeInTheDocument();
    cleanup();
    for (const role of ['moderator', 'senior'] as const) {
      const w = await world({ role });
      const g = await w.file();
      await openPerson(w, g.person);
      expect(screen.queryByRole('button', { name: 'Data requests' }), role).toBeNull();
      expect(screen.queryByText('Export data...')).toBeNull();
      expect(screen.queryByText('Erase data...')).toBeNull();
      // the rest of the page is there, and no request was made for it
      expect(screen.getByRole('region', { name: 'Timeline' })).toBeInTheDocument();
      expect(w.sent.filter((r) => /privacy/.test(r.path))).toEqual([]);
      cleanup();
    }
  });

  it('a permission override cannot give a senior the items: the owner is compared in code', async () => {
    const w = await world({ role: 'senior', permissions: { 'policy.read': 'moderator', 'legal.hold': 'moderator', 'automation.write': 'moderator' } });
    const f = await w.file();
    await openPerson(w, f.person);
    expect(screen.queryByRole('button', { name: 'Data requests' })).toBeNull();
  });

  it('is behind a disclosure: closed it shows nothing else, open it shows a group with the two items', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    const button = await menu();
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'Data requests' })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const group = screen.getByRole('group', { name: 'Data requests' });
    expect(within(group).getByRole('button', { name: 'Export data...' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Erase data...' })).toBeInTheDocument();
    expect(exports(w)).toEqual([]);
  });

  it('the privacy code is fetched only when the owner opens a person (a moderator\'s page never asks for it)', async () => {
    const w = await world({ role: 'moderator' });
    const f = await w.file();
    await openPerson(w, f.person);
    expect(w.sent.some((r) => /privacy|legal/.test(r.path))).toBe(false);
  });
});

describe('export: one click downloads the file', () => {
  it('calls the route once, saves the JSON, and says so', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await menu());
    await user.click(screen.getByRole('button', { name: 'Export data...' }));
    await waitFor(() => expect(downloads.saved).toHaveLength(1));
    expect(exports(w)).toHaveLength(1);
    expect(exports(w)[0]?.path).toBe(`/people/${f.person}/privacy/export`);
    const saved = downloads.saved[0]!;
    expect(saved.name).toBe('chatwarden-privacy-export.json');
    const body = JSON.parse(await saved.blob.text()) as { format: string; person: { ref: string } };
    expect(body.format).toBe('chatwarden.privacy-export');
    expect(body.person.ref).toBe(f.person);
    expect(await screen.findByText('The export was downloaded.')).toBeInTheDocument();
    expect(w.cw.audit.list({ limit: 20 }).items.some((a) => a.action === 'privacy.export' && a.actor === 'owen@example.test')).toBe(true);
  });

  it('a double click sends once', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await menu());
    const item = screen.getByRole('button', { name: 'Export data...' });
    await user.dblClick(item);
    await waitFor(() => expect(downloads.saved).toHaveLength(1));
    expect(exports(w)).toHaveLength(1);
  });

  it('a failed audit shows the error and downloads nothing', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    // After the page has loaded (reading a person is itself audited): from here no audit row can be written.
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    await user.click(await menu());
    await user.click(screen.getByRole('button', { name: 'Export data...' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not export. Nothing was downloaded.');
    expect(downloads.saved).toEqual([]);
  });

  it('draws no raw id, key, hash or secret in the group', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await menu());
    const group = screen.getByRole('group', { name: 'Data requests' });
    for (const bad of [f.person, 'key-target', 'hub-react-test-secret']) expect(group.textContent ?? '', bad).not.toContain(bad);
  });
});

describe('the Erase item opens the dialog that counts first', () => {
  it('opens a dialog named for the erase and calls the dry run, not the erase', async () => {
    const w = await world();
    const f = await w.file();
    const { user } = await openPerson(w, f.person);
    await user.click(await menu());
    await user.click(screen.getByRole('button', { name: 'Erase data...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Erase the data about this person' });
    await within(dialog).findByText('Reports about them');
    const posts = w.sent.filter((r) => r.method === 'POST' && /privacy\/erase$/.test(r.path));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ keep: 'safety', confirm: f.person, dryRun: true });
  });
});

import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// "Erase data..." (design 5.3): the dialog opens by counting, in words, what would be removed and what stays; `safety` is preselected, `none` shows the stronger warning;
// the word ERASE is required; the receipt is shown at the end and can be downloaded; an error keeps the dialog open and the choice. It says it is not legal advice.

afterEach(() => cleanup());

const erases = (w: HubWorld) => w.sent.filter((r) => r.method === 'POST' && /privacy\/erase$/.test(r.path));
let saved: Array<{ name: string; text: Promise<string> }> = [];
let restore: () => void = () => undefined;
beforeEach(() => {
  saved = [];
  const blobs = new Map<string, Blob>();
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => (blobs.set(`blob:e-${++n}`, b), `blob:e-${n}`), revokeObjectURL: () => undefined }));
  const spy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, text: (blobs.get(this.href) as Blob).text() });
  });
  restore = () => spy.mockRestore();
});
afterEach(() => {
  restore();
  vi.unstubAllGlobals();
});

async function open(w: HubWorld, person: string) {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  await r.user.click(await screen.findByRole('button', { name: 'Data requests' }));
  await r.user.click(screen.getByRole('button', { name: 'Erase data...' }));
  const dialog = await screen.findByRole('dialog', { name: 'Erase the data about this person' });
  // The dry run has answered when its "counting" line is gone (a person with nothing to remove has no counts to wait for).
  await waitFor(() => expect(within(dialog).queryByText('Counting what would be removed.')).toBeNull());
  return { ...r, dialog };
}
const world = () => hubWorld({ role: 'owner', actor: 'owen@example.test' });

describe('the dry run is called on open and its counts are shown in words', () => {
  it('shows what would be removed, what stays, and says it is not legal advice and that the player is not told', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog } = await open(w, f.person);
    expect(erases(w)).toHaveLength(1);
    expect(erases(w)[0]?.body).toEqual({ keep: 'safety', confirm: f.person, dryRun: true });
    expect(within(dialog).getByText('The person (their id)')).toBeInTheDocument();
    expect(within(dialog).getByText('Reports about them').parentElement).toHaveTextContent('1');
    expect(within(dialog).getByText('Nothing is kept.')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('not legal advice');
    expect(dialog).toHaveTextContent('does not tell the player');
    // nothing was erased by opening it
    expect(w.cw.privacy.find({ clientKey: 'key-target-Mallory' })).toBe(f.person);
  });

  it('safety is preselected with its words; none says a ban will stop applying, and counts again', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    const safety = within(dialog).getByRole('radio', { name: 'Keep what is needed to enforce a ban or hold a report' });
    expect(safety).toBeChecked();
    expect(within(dialog).queryByText(/will stop applying/)).toBeNull();
    await user.click(within(dialog).getByRole('radio', { name: 'Keep only held reports' }));
    expect(await within(dialog).findByText(/A ban this person is under will stop applying/)).toBeInTheDocument();
    await waitFor(() => expect(erases(w)).toHaveLength(2));
    expect(erases(w)[1]?.body).toEqual({ keep: 'none', confirm: f.person, dryRun: true });
  });

  it('with a ban in force and safety, the remainder is shown: identifiers stay, the sanction rows are counted', async () => {
    const w = await world();
    const f = await w.file();
    await w.cw.sanctions.apply({ kind: 'ban', subject: f.person, includeIp: false, durationMs: null, reason: 'r', actor: 'mod_ann', source: 'moderator', automated: false, rule: 1 });
    const { dialog } = await open(w, f.person);
    expect(await within(dialog).findByText(/The account, key and address rows stay while a ban applies/)).toBeInTheDocument();
    expect(within(dialog).getByText('Sanction rows kept: 1')).toBeInTheDocument();
  });

  it('a held report is counted as kept whole', async () => {
    const w = await world();
    const f = await w.file();
    await w.cw.legal.hold(f.id, { code: 'legal_proceeding', actor: 'senior_gus' });
    const { dialog } = await open(w, f.person);
    expect(await within(dialog).findByText('Reports held for legal reasons, kept whole: 1')).toBeInTheDocument();
  });

  it('a dry run that fails says so in words and offers no erase', async () => {
    const w = await world();
    const f = await w.file();
    w.intercept.fn = (req) => (/privacy\/erase$/.test(req.path) ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    const r = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await r.user.click(await screen.findByRole('button', { name: 'Data requests' }));
    await r.user.click(screen.getByRole('button', { name: 'Erase data...' }));
    const dialog = await screen.findByRole('dialog', { name: 'Erase the data about this person' });
    expect(await within(dialog).findByText(/Could not count what would be removed/)).toBeInTheDocument();
    await r.user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    expect(within(dialog).getByRole('button', { name: 'Erase data' })).toBeDisabled();
  });
});

describe('the word ERASE is required', () => {
  it('the button stays off until the exact word is typed: case, spaces and extra letters count', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    const go = within(dialog).getByRole('button', { name: 'Erase data' });
    const box = within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' });
    expect(go).toBeDisabled();
    for (const wrong of ['erase', 'ERASE ', ' ERASE', 'ERAS', 'ERASEE', 'Erase']) {
      await user.clear(box);
      await user.type(box, wrong);
      expect(go, wrong).toBeDisabled();
    }
    await user.clear(box);
    await user.type(box, 'ERASE');
    expect(go).toBeEnabled();
    expect(erases(w).filter((r) => (r.body as { dryRun?: boolean }).dryRun !== true)).toEqual([]);
  });
});

describe('erasing', () => {
  it('sends the choice and the confirmation, shows the receipt with counts in words, and lets it be downloaded', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    await user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    const receipt = await screen.findByRole('dialog', { name: 'Erased' });
    const real = erases(w).filter((r) => (r.body as { dryRun?: boolean }).dryRun !== true);
    expect(real).toHaveLength(1);
    expect(real[0]?.body).toEqual({ keep: 'safety', confirm: f.person });
    expect(receipt).toHaveTextContent(/This receipt holds counts and words only/);
    expect(within(receipt).getByText('Reports about them').parentElement).toHaveTextContent('1');
    const id = within(receipt).getByText(/^e_/);
    await user.click(within(receipt).getByRole('button', { name: 'Download receipt (JSON)' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.name).toBe(`chatwarden-erasure-receipt-${id.textContent}.json`);
    const json = JSON.parse(await saved[0]!.text) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['at', 'id', 'kept', 'mode', 'removed']);
    // the person is really gone, and the receipt names no one
    expect(w.cw.privacy.find({ clientKey: 'key-target-Mallory' })).toBeNull();
    expect(JSON.stringify(json)).not.toContain(f.person);
    expect(receipt.textContent).not.toContain(f.person);
    await user.click(within(receipt).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('an error keeps the dialog open, the choice and the typed word, and says so', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    await user.click(within(dialog).getByRole('radio', { name: 'Keep only held reports' }));
    await waitFor(() => expect(erases(w)).toHaveLength(2));
    await user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    w.intercept.fn = (req) => (/privacy\/erase$/.test(req.path) && (req.body as { dryRun?: boolean }).dryRun !== true ? { status: 500, body: { error: 'internal', message: 'x' } } : undefined);
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    expect(await within(dialog).findByText(/Could not erase\. The choice is kept so you can try again\./)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Erase the data about this person' })).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: 'Keep only held reports' })).toBeChecked();
    expect(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' })).toHaveValue('ERASE');
    expect(w.cw.privacy.find({ clientKey: 'key-target-Mallory' })).toBe(f.person);
    // and trying again works
    w.intercept.fn = null;
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    await screen.findByRole('dialog', { name: 'Erased' });
  });

  it('Cancel closes it and erases nothing', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(erases(w).filter((r) => (r.body as { dryRun?: boolean }).dryRun !== true)).toEqual([]);
  });

  it('a receipt with auditFailed says the audit entry could not be written', async () => {
    const w = await world();
    const f = await w.file();
    const { dialog, user } = await open(w, f.person);
    w.store.insertAudit = () => {
      throw new Error('disk full');
    };
    await user.type(within(dialog).getByRole('textbox', { name: 'Type ERASE to confirm' }), 'ERASE');
    await user.click(within(dialog).getByRole('button', { name: 'Erase data' }));
    const receipt = await screen.findByRole('dialog', { name: 'Erased' });
    expect(within(receipt).getByRole('alert')).toHaveTextContent('The data is erased, but the audit entry could not be written.');
  });
});

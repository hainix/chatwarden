import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { appealsHub } from './appealsWorld.js';
import type { AppealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// M6: the entity row on a case (`Clan: {label}`), drawn only when the report names one, the label masked like a name when the server flags it, and the entity choice in the Person page's rename form (offered only while an
// open report names one). Real routes, real kit; synthetic names only (zorbak is a slur in this world).

afterEach(() => cleanup());

const ENTITY = { kind: 'clan', ref: 'clan-4711', label: 'Blue Wolves' };
const rowOf = (): HTMLElement | null => document.querySelector('.cw-entity');

async function openDetailed(w: HubWorld, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('tablist');
  return r;
}

describe('the entity row, in the Detailed case', () => {
  it('shows "Clan: {label}" when the report names a clan, and nothing else about it', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: ENTITY });
    await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(rowOf()).toHaveTextContent('Clan: Blue Wolves');
    expect(document.body.textContent).not.toContain('clan-4711');
  });

  it.each([
    ['clan', 'Clan'],
    ['guild', 'Guild'],
    ['team', 'Team'],
    ['deck', 'Deck'],
    ['pet', 'Pet'],
    ['item', 'Item'],
    ['banner', 'Entity'],
    ['pet_name', 'Entity'],
  ])('the kind %s reads as "%s" (a kind the hub has no word for is "Entity")', async (kind, word) => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: { ...ENTITY, kind } });
    await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(rowOf()).toHaveTextContent(`${word}: Blue Wolves`);
  });

  it('a report with no entity has no row, and the case is what it was', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({});
    await openDetailed(w, f.id);
    await screen.findByText(/Filed/);
    expect(rowOf()).toBeNull();
  });

  it('the label is text: markup in it is never made into markup', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: { ...ENTITY, label: '<img src=x onerror=alert(1)>' } });
    const { container } = await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(rowOf()).toHaveTextContent('Clan: <img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it('a label the word list flags is hidden until shown, with a Show control, and Hide puts it back', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: { ...ENTITY, label: 'Zorbak Clan' } });
    const { user } = await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(rowOf()).not.toHaveTextContent('Zorbak');
    expect(rowOf()).toHaveTextContent('Clan:');
    const show = within(rowOf() as HTMLElement).getByRole('button', { name: /Show/ });
    expect(show).toHaveAttribute('aria-pressed', 'false');
    await user.click(show);
    expect(rowOf()).toHaveTextContent('Clan: Zorbak Clan');
    await user.click(within(rowOf() as HTMLElement).getByRole('button', { name: /Hide/ }));
    expect(rowOf()).not.toHaveTextContent('Zorbak');
  });

  it('with names.maskInHub off a flagged label is plain text and there is no Show', async () => {
    const w = await hubWorld({ overrides: { names: { maskInHub: false } } });
    const f = await w.fileRich({ entity: { ...ENTITY, label: 'Zorbak Clan' } });
    await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(rowOf()).toHaveTextContent('Clan: Zorbak Clan');
    expect(within(rowOf() as HTMLElement).queryByRole('button')).toBeNull();
  });

  it('the row is not a control, and a plain label has no Show', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: ENTITY });
    await openDetailed(w, f.id);
    await waitFor(() => expect(rowOf()).not.toBeNull());
    expect(within(rowOf() as HTMLElement).queryByRole('button')).toBeNull();
    expect((rowOf() as HTMLElement).closest('button, a')).toBeNull();
  });

  it('has no axe violations in the light and the dark theme, flagged or not', async () => {
    for (const theme of ['light', 'dark'] as const) {
      cleanup();
      const w = await hubWorld();
      const f = await w.fileRich({ entity: { ...ENTITY, label: 'Zorbak Clan' } });
      const { container } = renderHub(w, { path: `/reports/${f.id}`, theme });
      await screen.findByRole('tablist');
      await waitFor(() => expect(rowOf()).not.toBeNull());
      const found = (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
      expect(found, theme).toEqual([]);
    }
  });
});

describe('the entity row, in the Simple case', () => {
  it('shows the row on the card', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({ entity: ENTITY });
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    const card = await screen.findByRole('region', { name: /^Case against/ });
    await waitFor(() => expect(card.querySelector('.cw-entity')).not.toBeNull());
    expect(card.querySelector('.cw-entity')).toHaveTextContent('Clan: Blue Wolves');
  });

  it('draws nothing for a report with no entity', async () => {
    const w = await hubWorld();
    const f = await w.fileRich({});
    renderHub(w, { path: `/reports/${f.id}`, mode: 'simple', stay: true });
    const card = await screen.findByRole('region', { name: /^Case against/ });
    expect(card.querySelector('.cw-entity')).toBeNull();
  });
});

// --- the rename form ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const renames = (w: AppealsHub) => w.sent.filter((r) => r.method === 'POST' && /^\/people\/[^/]+\/rename$/.test(r.path));
const what = (): HTMLSelectElement => screen.getByLabelText('What happens') as HTMLSelectElement;
const OPTION = 'Ask for a new name (no sanction)';

async function openRename(w: AppealsHub, person: string) {
  const r = renderHub(w, { path: `/people/${person}` });
  await screen.findByRole('region', { name: 'Timeline' });
  await waitFor(() => expect(screen.queryByText('Loading', { exact: false })).not.toBeInTheDocument());
  await r.user.click(screen.getByRole('button', { name: 'Sanction' }));
  await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
  await r.user.selectOptions(what(), OPTION);
  return r;
}
async function fileAbout(w: AppealsHub, entity: { kind: string; ref: string; label: string } | undefined, target = 'Mallory') {
  const f = await w.fileRich({ target, ...(entity === undefined ? {} : { entity }) });
  return f;
}
async function fill(user: ReturnType<typeof renderHub>['user'], rule = '2') {
  await user.selectOptions(screen.getByLabelText('Community Rule'), rule);
  await user.type(screen.getByLabelText('Reason'), 'The clan name pretends to be staff');
}

describe('the rename form offers the entity when the person has an open report that names one', () => {
  it('with no entity in sight the form is what it was: no choice, and the body has no entity', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, undefined);
    const { user } = await openRename(w, f.person);
    expect(screen.queryByLabelText('What to rename')).toBeNull();
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect(renames(w)[0]?.body).toEqual({ reason: 'The clan name pretends to be staff', rule: 2 });
  });

  it('with an open report naming a clan, a choice appears with the player\'s own name first and the clan after; it defaults to the player', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, ENTITY);
    const { user } = await openRename(w, f.person);
    const choice = (await screen.findByLabelText('What to rename')) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(['Their player name', 'Clan: Blue Wolves']);
    expect(choice.value).toBe('');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect(renames(w)[0]?.body).not.toHaveProperty('entity');
  });

  it('choosing the clan sends { kind, ref } and never the label', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, ENTITY);
    const { user } = await openRename(w, f.person);
    await user.selectOptions(await screen.findByLabelText('What to rename'), 'Clan: Blue Wolves');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect(renames(w)[0]?.body).toEqual({ reason: 'The clan name pretends to be staff', rule: 2, entity: { kind: 'clan', ref: 'clan-4711' } });
    expect(JSON.stringify(renames(w)[0])).not.toContain('Blue Wolves');
  });

  it('a flagged label is hidden in the choice (the hidden label stands in), and still sends its kind and ref', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, { ...ENTITY, label: 'Zorbak Clan' });
    const { user } = await openRename(w, f.person);
    const choice = (await screen.findByLabelText('What to rename')) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent).join('|')).not.toContain('Zorbak');
    expect(choice.options).toHaveLength(2);
    await user.selectOptions(choice, choice.options[1] as HTMLOptionElement);
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(renames(w)).toHaveLength(1));
    expect((renames(w)[0]?.body as { entity?: unknown }).entity).toEqual({ kind: 'clan', ref: 'clan-4711' });
  });

  it('two different entities in open reports are two choices, newest report first; the same one twice is one', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const a = await fileAbout(w, ENTITY);
    await w.fileRich({ target: 'Mallory', entity: ENTITY });
    await w.fileRich({ target: 'Mallory', entity: { kind: 'guild', ref: 'guild-9', label: 'Red Foxes' } });
    const { user } = await openRename(w, a.person);
    const choice = (await screen.findByLabelText('What to rename')) as HTMLSelectElement;
    expect([...choice.options].map((o) => o.textContent)).toEqual(['Their player name', 'Guild: Red Foxes', 'Clan: Blue Wolves']);
    expect(user).toBeDefined();
  });

  it('only on the rename choice of the Sanction form: a sanction never shows it, and with renames off there is no form for it', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, ENTITY);
    const r = renderHub(w, { path: `/people/${f.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    await r.user.click(await screen.findByRole('button', { name: 'Sanction' }));
    await waitFor(() => expect((screen.getByLabelText('Community Rule') as HTMLSelectElement).options.length).toBeGreaterThan(2));
    expect(screen.queryByLabelText('What to rename')).toBeNull();
    const off = await appealsHub();
    const g = await fileAbout(off, ENTITY);
    renderHub(off, { path: `/people/${g.person}` });
    await screen.findByRole('region', { name: 'Timeline' });
    expect(screen.queryByLabelText('What to rename')).toBeNull();
  });

  it('the server\'s history carries the entities of open reports, label flagged when the word list flags it, and nothing when there are none', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await fileAbout(w, { ...ENTITY, label: 'Zorbak Clan' });
    const h = await w.client.personHistory(f.person);
    expect(h.entities).toEqual([{ kind: 'clan', ref: 'clan-4711', label: 'Zorbak Clan', labelFlagged: true }]);
    const none = await appealsHub({ names: { renames: true } });
    const g = await none.file({});
    expect(Object.hasOwn(await none.client.personHistory(g.person), 'entities')).toBe(false);
  });
});

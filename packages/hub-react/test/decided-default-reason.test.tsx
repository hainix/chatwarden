import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';

// A report dismissed with no typed reason has the kit's standard reason stored. The Decided view shows it in the moderator's language,
// and a reason a person typed is shown as typed (even one that happens to read the same in another language).

const de = createT({ ...en, 'hub.decided.reason.default': 'Kein Grund angegeben' }, 'de');

describe('the Decided view and the standard reason', () => {
  it('shows "No reason given" for the standard reason', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    renderHub(w, { path: `/reports/${f.id}` });
    const decided = await screen.findByText('Reason');
    expect(within(decided.closest('dl') as HTMLElement).getByText('No reason given')).toBeInTheDocument();
    expect(screen.queryByText('No action needed')).toBeNull();
  });

  it('says it in the viewer\'s language', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.client.decide(f.id, { verdict: 'no_action', actions: [] });
    renderHub(w, { path: `/reports/${f.id}`, t: de, locale: 'de' });
    expect(await screen.findByText('Kein Grund angegeben')).toBeInTheDocument();
  });

  it('shows a typed reason as typed', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'Friends joking.', actions: [] });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByText('Friends joking.')).toBeInTheDocument();
    expect(screen.queryByText('No reason given')).toBeNull();
  });

  it('a typed reason that is the standard text word for word is the standard reason (the kit cannot tell them apart)', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.client.decide(f.id, { verdict: 'no_action', reason: 'No action needed', actions: [] });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByText('No reason given')).toBeInTheDocument();
  });

  it('a reason on a decision that acted is never replaced, whatever it says', async () => {
    const w = await hubWorld();
    const f = await w.file({ target: 'Alpha' });
    await w.client.decide(f.id, { verdict: 'upheld', reason: 'Clear case.', actions: [{ subject: f.person, kind: 'warning', durationMs: null, rule: 1 }] });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByText('Clear case.')).toBeInTheDocument();
  });
});

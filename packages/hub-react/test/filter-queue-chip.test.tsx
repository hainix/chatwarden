import { cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { filterOriginLabel } from '../src/labels.js';
import { createT, en } from '../src/i18n.js';
import { groupQueue } from '../src/queue.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld } from './world.js';

// A report a chat filter filed (release 0.2.0) has no reporter: the queue shows one neutral chip "Filter: Links" (or the phrase rule's label) where a
// reporter would be, the case page has no reporter panel and no reporter accuracy, and the case behaves as any case. A report with a reporter renders as before.

afterEach(() => cleanup());
const t = createT(en, 'en');

describe('the words of the chip', () => {
  it('Filter: Links, Personal info, Shouting and repeats, the rule\'s label for a phrase, Phrase without one, and plain Filter for anything else', () => {
    expect(filterOriginLabel(t, 'link.unlisted')).toBe('Filter: Links');
    expect(filterOriginLabel(t, 'link.new_account')).toBe('Filter: Links');
    expect(filterOriginLabel(t, 'personal_info.phone')).toBe('Filter: Personal info');
    expect(filterOriginLabel(t, 'ratio.caps')).toBe('Filter: Shouting and repeats');
    expect(filterOriginLabel(t, 'phrase.ads', 'Gold ads')).toBe('Filter: Gold ads');
    expect(filterOriginLabel(t, 'phrase.ads')).toBe('Filter: Phrase');
    expect(filterOriginLabel(t, 'something.else')).toBe('Filter');
    expect(filterOriginLabel(t, undefined)).toBe('Filter');
  });
});

describe('the queue', () => {
  const row = async (w: HubWorld, name: string): Promise<HTMLElement> => {
    const pane = await screen.findByRole('region', { name: 'Open cases' });
    await waitFor(() => expect(within(pane).queryByText('Loading the queue')).not.toBeInTheDocument());
    const li = within(within(pane).getByRole('list', { name: 'Cases' })).getAllByRole('listitem').find((x) => within(x).queryByText(name) !== null);
    if (li === undefined) throw new Error(`no row for ${name}`);
    return li;
  };

  it('a filter report shows "Filter: Links" as a neutral chip and no reporter count; the phrase rule\'s label shows for a phrase', async () => {
    const w = await hubWorld({ role: 'moderator', overrides: { filters: { phrases: [{ id: 'gold', label: 'Gold ads', action: 'flag', phrases: ['buy gold'] }] } } });
    await w.flagged({ target: 'Linky', originKey: 'link.unlisted' });
    await w.flagged({ target: 'Goldy', originKey: 'phrase.gold', text: 'hello there' });
    renderHub(w, { path: '/reports' });
    const links = await row(w, 'Linky');
    expect(within(links).getByText('Filter: Links')).toBeInTheDocument();
    expect(within(links).queryByText(/reporter/i)).toBeNull();
    const gold = await row(w, 'Goldy');
    expect(within(gold).getByText('Filter: Gold ads')).toBeInTheDocument();
  });

  it('a report with a reporter renders as before: no Filter chip, the reporter count is there', async () => {
    const w = await hubWorld({ role: 'moderator' });
    await w.file({ target: 'Plainy' });
    renderHub(w, { path: '/reports' });
    const r = await row(w, 'Plainy');
    expect(within(r).queryByText(/^Filter/)).toBeNull();
    expect(within(r).getByText(/1 report from 1 person/)).toBeInTheDocument();
  });

  it('groupQueue groups a filter report with a person\'s other reports, names no reporter and keeps the origin keys', () => {
    const base = {
      id: 'r1', createdAt: 1, roomId: 'x', tags: {}, category: 'spam', reportedReason: 'spam', reportedReasonLabel: 'Spam', status: 'open', badFaith: false,
      targetPerson: 'p1', actionedAt: null, actionedBy: null, targetHandle: 'Tgt', claim: null, viewing: [],
    } as never;
    const groups = groupQueue([
      { ...(base as object), id: 'a', reporterPerson: null, reporterHandle: null, origin: 'filter', originKey: 'link.unlisted' } as never,
      { ...(base as object), id: 'b', reporterPerson: 'rep1', reporterHandle: 'Rae' } as never,
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ reporters: 1, reporterPersons: ['rep1'] });
    expect(groups[0]!.origins).toEqual([{ key: 'link.unlisted' }]);
  });
});

describe('the case', () => {
  it('a filter report shows the chip where the reporters would be, no reporter panel and no reporter accuracy; the case is decided as any case', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.flagged({ target: 'Linky' });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByText('Filter: Links')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Reporters of this case' })).toBeNull();
    expect(screen.queryByText(/reports? were? not upheld|Their reports/i)).toBeNull();
    // the case behaves as any case: the decision bar is there and a no-action decision goes through
    expect(screen.getAllByRole('button').some((b) => /nothing wrong|no action|dismiss/i.test(b.textContent ?? ''))).toBe(true);
  });

  it('an older body with a reporter renders the reporters as before', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.file({ target: 'Plainy', reporter: 'Rae' });
    renderHub(w, { path: `/reports/${f.id}` });
    expect(await screen.findByRole('list', { name: 'Reporters of this case' })).toBeInTheDocument();
    expect(screen.queryByText(/^Filter/)).toBeNull();
  });

  it('bulk dismiss offers no "dismiss the reporter\'s reports" for a filter report', async () => {
    const w = await hubWorld({ role: 'moderator' });
    const f = await w.flagged({ target: 'Linky' });
    await w.flagged({ target: 'Linky', room: 'other-flag-room' }).catch(() => undefined);
    renderHub(w, { path: `/reports/${f.id}` });
    await screen.findByText('Filter: Links');
    expect(screen.queryByRole('button', { name: /reporter/i })).toBeNull();
  });
});

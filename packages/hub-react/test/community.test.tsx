import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';
import { COMMUNITY_ACTOR, COMMUNITY_WORDS, OWN_WORD } from './communityWorld.js';
import type { CommunityOptions } from './communityWorld.js';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import type { TransportRequest } from '../src/transport.js';

// The shared term list in the hub (design 14): the Terms screen is unchanged, one disclosure in the term editor, one Settings section, the
// Changed cell, and the hand-over of a hidden row. The routes are the real ones; the loader and the share object are fakes. Invented words only.

const SYNTHETIC = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];
const ALL_WORDS = [...SYNTHETIC, ...COMMUNITY_WORDS, OWN_WORD];
const sent = (w: HubWorld, method: string, path: string): TransportRequest[] => w.sent.filter((r) => r.method === method && r.path === path);
const audits = (w: HubWorld, action: string): unknown[] => w.cw.audit.list({ limit: 200 }).items.filter((r) => r.action === action);
const region = (name: string | RegExp): HTMLElement => screen.getByRole('region', { name });
const showWords = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Show words' });
const noWordsIn = (html: string): void => {
  const lower = html.toLowerCase();
  for (const word of ALL_WORDS) expect(lower, `the word ${word} is in the page`).not.toContain(word);
};

async function openTerms(options: WorldOptions = {}, prepare?: (w: HubWorld) => unknown) {
  const w = await hubWorld(options);
  await prepare?.(w);
  const r = renderHub(w, { path: '/terms' });
  await screen.findByRole('heading', { level: 2, name: 'Terms' });
  await screen.findByRole('region', { name: /^English/ });
  return { w, ...r };
}

/** What a person sees of the Terms screen without opening anything: its buttons, tags, columns, regions and checkboxes, in order. */
function shapeOf(container: HTMLElement): unknown {
  const name = (e: Element): string => e.getAttribute('aria-label') ?? e.textContent ?? '';
  return {
    buttons: [...container.querySelectorAll('button')].map(name),
    links: [...container.querySelectorAll('a')].map(name),
    tags: [...container.querySelectorAll('.cw-tag')].map(name),
    columns: [...container.querySelectorAll('th')].map(name),
    regions: [...container.querySelectorAll('[role="region"]')].map(name),
    checks: [...container.querySelectorAll('input[type="checkbox"]')].map(name),
    headings: [...container.querySelectorAll('h2, h3')].map(name),
  };
}

describe('Terms: the screen the person sees', () => {
  it('no new always-visible control, badge or counter with community wired or not (a structural snapshot of buttons, tags, columns and checks)', async () => {
    const base = await openTerms();
    const baseline = shapeOf(base.container);
    base.unmount();
    for (const community of [{ share: true }, { share: false }, { share: true, seed: false }] satisfies CommunityOptions[]) {
      const wired = await openTerms({ community });
      expect(shapeOf(wired.container), JSON.stringify(community)).toEqual(baseline);
      // No number or word about the community list on the screen: the hidden rows are neither listed nor counted.
      expect(wired.container.textContent ?? '').not.toMatch(/community/i);
      noWordsIn(wired.container.innerHTML);
      wired.unmount();
    }
  });

  it('with the hidden rows listed (exposeCommunityRows) the screen still has the same controls', async () => {
    const base = await openTerms();
    const baseline = shapeOf(base.container) as { buttons: string[]; checks: string[] };
    base.unmount();
    const wired = await openTerms({ community: { exposeCommunityRows: true } });
    const shape = shapeOf(wired.container) as { buttons: string[]; checks: string[] };
    // More rows means more row buttons and switches; every other control is the same.
    expect(shape.buttons.filter((b) => !/^Edit /.test(b))).toEqual(baseline.buttons.filter((b) => !/^Edit /.test(b)));
    expect(shape.checks.filter((c) => !/^Active: /.test(c))).toEqual(baseline.checks.filter((c) => !/^Active: /.test(c)));
  });

  it('the Changed cell reads "Community list 2026.12" for a community row, a person and a time for any other', async () => {
    const { user } = await openTerms({ community: { exposeCommunityRows: true } }, async (x) => {
      await x.direct.updateTerm('syn:snerp', { note: 'a made-up pest' });
      // The next release switches one word off (the list changed it, so it is still the list's); a person edits another.
      const pack = x.community!.rig.pack!;
      const next = { ...pack, version: '2027.01.1', terms: pack.terms.map((t) => (t.term === 'tarvox' ? { ...t, active: false } : t)) };
      expect(x.live.syncPack(next, { actor: 'corpus:2027.01.1' }).ok).toBe(true);
      await x.direct.updateTerm('CWT-2026-00003', { note: 'seen in play' });
    });
    await user.click(showWords());
    const terms = within(region('English (en)')).getByRole('region', { name: 'Terms in English (en)' });
    const changed = (word: string): string => {
      const row = within(terms).getAllByRole('row').find((r) => within(r).queryByText(word) !== null) as HTMLElement;
      return within(row).getAllByRole('cell')[2]?.textContent ?? '';
    };
    expect(changed('glarn')).toBe('Community list 2026.12');
    // A patch release keeps its patch number.
    expect(changed('tarvox')).toBe('Community list 2027.01.1');
    // A person who edited a community row is shown as the person, with the time.
    expect(changed('quisselo')).toContain('ann');
    expect(changed('quisselo')).not.toContain('Community');
    expect(changed('snerp')).toContain('ann');
    expect(changed('quissel')).not.toContain('Community');
  });
});

describe('the Share disclosure in the term editor', () => {
  /** Adds one row of the adopter's own, opens Terms with words shown and the editor on that row. */
  async function editOwn(options: WorldOptions = {}, prepare?: (w: HubWorld, id: string) => unknown) {
    let id = '';
    const { w, user, container, unmount } = await openTerms(options, async (x) => {
      id = (await x.direct.addTerm({ term: OWN_WORD, language: 'en' })).id;
      await prepare?.(x, id);
    });
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: `Edit ${OWN_WORD}` }));
    await screen.findByRole('form', { name: 'Edit a term' });
    return { w, user, container, unmount, id };
  }
  const CONSENT = en['hub.community.share.consent'];

  it('is absent without sharing: true, without community at all, and for a community row and an exception', async () => {
    for (const options of [{}, { community: { share: false } }] as WorldOptions[]) {
      const { w, unmount } = await editOwn(options);
      // A server that did not wire the list is never asked; one that wired it without sharing is asked once.
      await waitFor(() => expect(sent(w, 'GET', '/community')).toHaveLength(options.community === undefined ? 0 : 1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(sent(w, 'GET', '/community')).toHaveLength(options.community === undefined ? 0 : 1);
      expect(screen.queryByRole('button', { name: /community list/i })).toBeNull();
      unmount();
    }
    // A community row (listed here because exposeCommunityRows is on) is already shared; so is nothing else.
    const { user } = await openTerms({ community: { exposeCommunityRows: true } });
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: 'Edit glarn' }));
    await screen.findByRole('form', { name: 'Edit a term' });
    expect(screen.queryByRole('button', { name: 'Share with the community list' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Edit glarn zorbak' }));
    await screen.findByRole('form', { name: 'Edit an exception' });
    expect(screen.queryByRole('button', { name: 'Share with the community list' })).toBeNull();
  });

  it('is closed by default; opening shows the exact payload and the consent text; Send posts one term; the draft is lost on close', async () => {
    const { w, user } = await editOwn({ community: {} });
    const button = await screen.findByRole('button', { name: 'Share with the community list' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(CONSENT)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(CONSENT)).toBeInTheDocument();
    const payload = screen.getByRole('group', { name: 'What will be sent' });
    expect(within(payload).getByText(OWN_WORD)).toBeInTheDocument();
    expect(payload).toHaveTextContent('Language');
    expect(payload).toHaveTextContent('en');
    expect(payload).toHaveTextContent('Category');
    // The draft: a note and a category.
    await user.selectOptions(screen.getByLabelText('Category'), 'Abuse');
    await user.type(screen.getByLabelText(/^Note for reviewers/), 'used against newcomers');
    expect(payload).toHaveTextContent('Abuse');
    expect(payload).toHaveTextContent('used against newcomers');
    // Close and reopen: the draft is gone.
    await user.click(button);
    expect(screen.queryByText(CONSENT)).toBeNull();
    await user.click(button);
    expect(screen.getByLabelText(/^Note for reviewers/)).toHaveValue('');
    // Send: one request, one term, the closed list of keys.
    await user.selectOptions(screen.getByLabelText('Category'), 'Other');
    await user.type(screen.getByLabelText(/^Note for reviewers/), 'a note');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent. Status: waiting for review')).toBeInTheDocument();
    const posts = w.sent.filter((r) => r.method === 'POST' && /\/share$/.test(r.path));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({ category: 'other', note: 'a note' });
    expect(w.community?.rig.shareCalls).toEqual([{ term: OWN_WORD, language: 'en', category: 'other', note: 'a note' }]);
    expect(audits(w, 'term.share')).toHaveLength(1);
    // The path carries the row id, never the word.
    expect(posts[0]?.path).not.toContain(OWN_WORD);
  });

  it('the preview lists everything that is sent, the calendar day and the kit version included, and says no time of day is sent', async () => {
    const { user } = await editOwn({ community: {} });
    await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
    const payload = screen.getByRole('group', { name: 'What will be sent' });
    const labels = [...payload.querySelectorAll('dt')].map((e) => e.textContent);
    expect(labels).toEqual(['Word', 'Language', 'Category', 'Note', 'Day', 'Chatwarden version', 'Sent with']);
    expect(payload).toHaveTextContent("today's date, never the time");
    expect(payload).toHaveTextContent('the version of Chatwarden on this server');
    await user.selectOptions(screen.getByLabelText('Category'), 'Slur');
    expect([...payload.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['Word', 'Language', 'Category', 'Aimed at', 'Note', 'Day', 'Chatwarden version', 'Sent with']);
  });

  it('a slur needs a target: the select appears for it, and the payload names it; a note has a limit and a warning about chat lines', async () => {
    const { w, user } = await editOwn({ community: {} });
    await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
    expect(screen.queryByLabelText('Aimed at')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Category'), 'Slur');
    const target = screen.getByLabelText('Aimed at');
    await user.selectOptions(target, 'Religion');
    expect(screen.getByRole('group', { name: 'What will be sent' })).toHaveTextContent('Religion');
    expect(screen.getByText(/Do not paste chat lines/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Note for reviewers/)).toHaveAttribute('maxlength', '200');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText(/^Sent\. Status:/);
    expect(w.community?.rig.shareCalls).toEqual([{ term: OWN_WORD, language: 'en', category: 'slur', target: 'religion' }]);
  });

  it('a slur with no target is not sent: the person is told to pick one, and nothing goes out', async () => {
    const { w, user } = await editOwn({ community: {} });
    await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
    await user.selectOptions(screen.getByLabelText('Category'), 'Slur');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Pick who it is aimed at.')).toBeInTheDocument();
    expect(w.community?.rig.shareCalls).toEqual([]);
    expect(w.sent.filter((r) => r.method === 'POST' && /\/share$/.test(r.path))).toEqual([]);
  });

  it('opens with Enter on the toggle, Escape closes it and puts the focus back on the toggle', async () => {
    const { user } = await editOwn({ community: {} });
    const button = await screen.findByRole('button', { name: 'Share with the community list' });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    screen.getByLabelText('Category').focus();
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    // The form around it is still there: Escape closed the disclosure, not the editor.
    expect(screen.getByRole('form', { name: 'Edit a term' })).toBeInTheDocument();
  });

  it('the payload preview masks the word until Show words is on; the words in the dialog contain no term', async () => {
    const { user, container } = await openTerms({ community: {} }, async (x) => void (await x.direct.addTerm({ term: OWN_WORD, language: 'en' })));
    // Words are hidden: the editor is opened by its place, and the preview shows the word masked.
    const edit = screen.getAllByRole('button', { name: /^Edit term \d+$/ });
    await user.click(edit[edit.length - 1] as HTMLElement);
    await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
    const payload = screen.getByRole('group', { name: 'What will be sent' });
    expect(within(payload).getByText('Blocked words, hidden')).toBeInTheDocument();
    expect(payload.textContent).not.toContain(OWN_WORD);
    noWordsIn(container.innerHTML.replace(/<input[^>]*>/g, ''));
    // Show words: the preview shows it.
    await user.click(showWords());
    expect(within(screen.getByRole('group', { name: 'What will be sent' })).getByText(OWN_WORD)).toBeInTheDocument();
    // Whatever the catalogue says, it says no term.
    for (const [key, text] of Object.entries(en)) {
      if (!/^hub\.(community|terms)\./.test(key)) continue;
      for (const word of ALL_WORDS) expect(text.toLowerCase(), `${key} holds ${word}`).not.toContain(word);
    }
  });

  it('each share status has words, and none shows service text', async () => {
    const table: Array<[unknown, string]> = [
      [{ status: 'received' }, 'Status: waiting for review'],
      [{ status: 'in_review' }, 'Status: being reviewed'],
      [{ status: 'accepted' }, 'Status: on the community list'],
      [{ status: 'merged' }, 'Status: on the community list'],
      [{ status: 'declined' }, 'Status: not added'],
      [{ status: 'declined', reason: 'known_innocent' }, 'Status: not added: it is an ordinary word'],
      [{ status: 'declined', reason: 'not_a_term' }, 'Status: not added: it does not look like a term'],
      [{ status: 'declined', reason: 'duplicate' }, 'Status: not added: it is already on the list'],
      [{ status: 'declined', reason: 'needs_context' }, 'Status: not added: reviewers could not tell what it means'],
      [{ status: 'declined', reason: 'other' }, 'Status: not added: no reason given'],
      [{ status: 'declined', reason: 'service text: vlemmo is fine' }, 'Status: not added'],
      [{ status: 'surprise', message: 'service text' }, 'Status: waiting for review'],
    ];
    for (const [answer, words] of table) {
      const { unmount } = await editOwn({ community: {} }, async (x, id) => {
        x.community!.rig.statusResult = { ...(answer as object), message: 'SERVICE-SECRET' };
        await x.direct.shareTerm(id, { category: 'other' });
      });
      expect(await screen.findByText(words, { exact: true }), JSON.stringify(answer)).toBeInTheDocument();
      expect(document.body.textContent).not.toContain('SERVICE-SECRET');
      expect(document.body.textContent).not.toContain('service text');
      // A row that was already shared opens closed.
      expect(screen.getByRole('button', { name: 'Share with the community list' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
      unmount();
    }
    // Already known or duplicated when it was sent.
    for (const [result, words] of [
      [{ ok: true, status: 'known', termId: 'CWT-2026-00001' }, 'Status: already on the community list'],
      [{ ok: true, status: 'duplicate' }, 'Status: already waiting for review'],
    ] as const) {
      const { unmount } = await editOwn({ community: {} }, async (x, id) => {
        x.community!.rig.shareResult = result;
        await x.direct.shareTerm(id, { category: 'other' });
      });
      expect(await screen.findByText(words)).toBeInTheDocument();
      unmount();
    }
  });

  it('a share that fails says why in words: offline, rate limited, refused, an unacceptable note; never the service text', async () => {
    const table: Array<[unknown, string]> = [
      [{ ok: false, code: 'offline', message: 'SERVICE-SECRET' }, 'The community list could not be reached. Try again later.'],
      [{ ok: false, code: 'rate_limited', retryAfterMs: 60_000, message: 'SERVICE-SECRET' }, 'You have shared too many words today. Try again tomorrow.'],
      [{ ok: false, code: 'rejected', message: 'SERVICE-SECRET' }, 'The community list did not take this word.'],
      [{ ok: false, code: 'invalid', message: 'SERVICE-SECRET' }, 'The note is not allowed. Take out links, addresses and long numbers.'],
    ];
    for (const [result, words] of table) {
      const { w, user, unmount } = await editOwn({ community: {} }, (x) => {
        x.community!.rig.shareResult = result;
      });
      await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(words);
      expect(document.body.textContent).not.toContain('SERVICE-SECRET');
      // The word was sent to the service, so the attempt is on the audit trail even though it failed.
      expect(audits(w, 'term.share')).toHaveLength(1);
      // The draft is kept, so the person can fix it and try again.
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      unmount();
    }
  });

  it('a double click sends once', async () => {
    const { w, user } = await editOwn({ community: {} });
    await user.click(await screen.findByRole('button', { name: 'Share with the community list' }));
    const send = screen.getByRole('button', { name: 'Send' });
    fireEvent.click(send);
    fireEvent.click(send);
    await screen.findByText(/^Sent\. Status:/);
    expect(w.sent.filter((r) => r.method === 'POST' && /\/share$/.test(r.path))).toHaveLength(1);
  });

  it('a GET /community that failed once is not remembered: the next editor that opens asks again and offers Share', async () => {
    let failed = 0;
    const { w, user } = await editOwn({ community: {} }, (x) => {
      x.intercept.fn = (req) => {
        if (req.method !== 'GET' || req.path !== '/community' || failed > 0) return undefined;
        failed += 1;
        return { status: 500, body: { error: 'internal', message: 'x' } };
      };
    });
    await waitFor(() => expect(sent(w, 'GET', '/community')).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole('button', { name: 'Share with the community list' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: `Edit ${OWN_WORD}` }));
    expect(await screen.findByRole('button', { name: 'Share with the community list' })).toBeInTheDocument();
    expect(sent(w, 'GET', '/community')).toHaveLength(2);
  });

  it('a GET /community that answered is asked only once per page, however many editors open', async () => {
    const { w, user } = await editOwn({ community: {} });
    await screen.findByRole('button', { name: 'Share with the community list' });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: `Edit ${OWN_WORD}` }));
    await screen.findByRole('button', { name: 'Share with the community list' });
    expect(sent(w, 'GET', '/community')).toHaveLength(1);
  });

  it('a person without terms.write is not offered it', async () => {
    const w = await hubWorld({ community: {}, permissions: { 'terms.write': 'owner' }, role: 'moderator' });
    await w.direct.addTerm({ term: OWN_WORD, language: 'en' }).catch(() => undefined);
    renderHub(w, { path: '/terms' });
    await screen.findByRole('region', { name: /^English/ });
    expect(screen.queryByRole('button', { name: /^Edit /u })).toBeNull();
    expect(screen.queryByRole('button', { name: /community list/i })).toBeNull();
  });
});

describe('the Report disclosure in the term editor (a community term)', () => {
  /** Opens Terms with the community rows listed and the editor on the community row `word`. */
  async function editCommunity(options: WorldOptions = { community: { exposeCommunityRows: true } }, word = 'glarn') {
    const { w, user, container, unmount } = await openTerms(options);
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: `Edit ${word}` }));
    await screen.findByRole('form', { name: 'Edit a term' });
    return { w, user, container, unmount };
  }
  const TOGGLE = 'Report a problem with this community term';
  const NOTE = en['hub.community.report.note'];

  it("is offered for a community row only when the server can report: not for the adopter's own row, not without reporting, not with the list off", async () => {
    for (const community of [
      { exposeCommunityRows: true, report: false },
      { exposeCommunityRows: true, share: false },
    ] as const) {
      const { w, unmount } = await editCommunity({ community });
      await waitFor(() => expect(sent(w, 'GET', '/community')).toHaveLength(1));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByRole('button', { name: TOGGLE })).toBeNull();
      unmount();
    }
    // The adopter's own row is shared, never reported.
    const { user } = await openTerms({ community: {} }, async (x) => {
      await x.direct.addTerm({ term: OWN_WORD, language: 'en' });
    });
    await user.click(showWords());
    await user.click(screen.getByRole('button', { name: `Edit ${OWN_WORD}` }));
    await screen.findByRole('form', { name: 'Edit a term' });
    await screen.findByRole('button', { name: 'Share with the community list' });
    expect(screen.queryByRole('button', { name: TOGGLE })).toBeNull();
  });

  it('is closed by default; opening shows what will be sent (the list number and the problem, never the word); Send posts one report', async () => {
    const { w, user } = await editCommunity();
    const button = await screen.findByRole('button', { name: TOGGLE });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Share with the community list' })).toBeNull();
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(NOTE)).toBeInTheDocument();
    const payload = screen.getByRole('group', { name: 'What will be sent' });
    expect([...payload.querySelectorAll('dt')].map((e) => e.textContent)).toEqual(['List number', 'Problem', 'Day', 'Chatwarden version', 'Sent with']);
    expect(payload).toHaveTextContent('CWT-2026-00001');
    expect(payload.textContent).not.toContain('glarn');
    // The default problem is the commonest one; the choice shows in the preview.
    expect(payload).toHaveTextContent('It blocks ordinary words');
    await user.selectOptions(screen.getByLabelText('What is the problem?'), 'It is in the wrong category');
    expect(payload).toHaveTextContent('It is in the wrong category');
    await user.selectOptions(screen.getByLabelText('What is the problem?'), 'It should not be on the list');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Sent. A reviewer will look at it.')).toBeInTheDocument();
    const posts = w.sent.filter((r) => r.method === 'POST' && /\/report$/.test(r.path));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe('/terms/CWT-2026-00001/report');
    expect(posts[0]?.body).toEqual({ kind: 'removal' });
    expect(w.community?.rig.reportCalls).toEqual([{ termId: 'CWT-2026-00001', kind: 'removal' }]);
    expect(w.community?.rig.shareCalls).toEqual([]);
    expect(audits(w, 'term.report')).toHaveLength(1);
    expect(audits(w, 'term.share')).toHaveLength(0);
    // The panel is closed again, and the toggle keeps the focus.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(button).toHaveFocus();
  });

  it('each problem sends its closed kind', async () => {
    for (const [words, kind] of [
      ['It blocks ordinary words', 'innocent_sense'],
      ['It is in the wrong category', 'wrong_category'],
      ['It should not be on the list', 'removal'],
    ] as const) {
      const { w, user, unmount } = await editCommunity();
      await user.click(await screen.findByRole('button', { name: TOGGLE }));
      await user.selectOptions(screen.getByLabelText('What is the problem?'), words);
      await user.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Sent. A reviewer will look at it.');
      expect(w.community?.rig.reportCalls.map((c) => c.kind)).toEqual([kind]);
      unmount();
    }
  });

  it('opens with Enter on the toggle, Escape closes it and puts the focus back on the toggle; the draft is lost on close', async () => {
    const { user } = await editCommunity();
    const button = await screen.findByRole('button', { name: TOGGLE });
    button.focus();
    await user.keyboard('{Enter}');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    await user.selectOptions(screen.getByLabelText('What is the problem?'), 'It should not be on the list');
    await user.keyboard('{Escape}');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).toHaveFocus();
    expect(screen.getByRole('form', { name: 'Edit a term' })).toBeInTheDocument();
    await user.click(button);
    expect(screen.getByLabelText('What is the problem?')).toHaveValue('innocent_sense');
  });

  it('a report that fails says why in words, keeps the draft and never shows the service text; a double click sends once', async () => {
    const table: Array<[unknown, string]> = [
      [{ ok: false, code: 'offline', message: 'SERVICE-SECRET' }, 'The community list could not be reached. Try again later.'],
      [{ ok: false, code: 'rate_limited', retryAfterMs: 60_000, message: 'SERVICE-SECRET' }, 'You have sent too many today. Try again tomorrow.'],
      [{ ok: false, code: 'rejected', message: 'SERVICE-SECRET' }, 'The community list did not take this report.'],
    ];
    for (const [result, words] of table) {
      const { w, user, unmount } = await editCommunity();
      w.community!.rig.reportResult = result;
      await user.click(await screen.findByRole('button', { name: TOGGLE }));
      const send = screen.getByRole('button', { name: 'Send' });
      fireEvent.click(send);
      fireEvent.click(send);
      expect(await screen.findByRole('alert')).toHaveTextContent(words);
      expect(document.body.textContent).not.toContain('SERVICE-SECRET');
      expect(w.sent.filter((r) => r.method === 'POST' && /\/report$/.test(r.path))).toHaveLength(1);
      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      unmount();
    }
  });

  it('shows no term anywhere: the preview and the catalogue', async () => {
    const { user } = await editCommunity();
    await user.click(await screen.findByRole('button', { name: TOGGLE }));
    const panel = screen.getByRole('group', { name: 'What will be sent' }).parentElement as HTMLElement;
    for (const word of ALL_WORDS) expect(panel.textContent?.toLowerCase(), word).not.toContain(word);
    for (const [key, text] of Object.entries(en)) {
      if (!/^hub\.community\./.test(key)) continue;
      for (const word of ALL_WORDS) expect(text.toLowerCase(), `${key} holds ${word}`).not.toContain(word);
    }
  });

  it('is not offered to a person who cannot write terms (the editor itself is not offered)', async () => {
    const w = await hubWorld({ community: { exposeCommunityRows: true }, permissions: { 'terms.write': 'owner' }, role: 'moderator' });
    renderHub(w, { path: '/terms' });
    await screen.findByRole('region', { name: /^English/ });
    expect(screen.queryByRole('button', { name: /^Edit /u })).toBeNull();
    expect(screen.queryByRole('button', { name: TOGGLE })).toBeNull();
  });
});

describe('Settings > Community list', () => {
  async function openCommunity(options: WorldOptions = { community: { seed: false } }, role: WorldOptions['role'] = 'owner') {
    const w = await hubWorld({ role, ...options });
    const r = renderHub(w, { path: '/settings/community' });
    await screen.findByRole('heading', { level: 2, name: 'Community list' });
    return { w, ...r };
  }

  it('is shown only when /community exists: a link in the section list with it, none without, and a direct address falls back to the first section', async () => {
    const without = await hubWorld({ role: 'owner' });
    const a = renderHub(without, { path: '/settings' });
    await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(screen.queryByRole('link', { name: 'Community list' })).toBeNull();
    a.unmount();
    const bare = await hubWorld({ role: 'owner' });
    const b = renderHub(bare, { path: '/settings/community' });
    await screen.findByRole('navigation', { name: 'Settings sections' });
    expect(screen.queryByRole('heading', { name: 'Community list' })).toBeNull();
    b.unmount();
    const w = await hubWorld({ role: 'owner', community: { seed: false } });
    renderHub(w, { path: '/settings' });
    expect(await screen.findByRole('link', { name: 'Community list' })).toBeInTheDocument();
  });

  it('shows the version in use or none, what is waiting, the licence, and per language counts (never a word)', async () => {
    const { w, container } = await openCommunity();
    expect(await screen.findByText('No community list is in use yet.')).toBeInTheDocument();
    expect(screen.getByText('Version 2026.12.0 is waiting to be applied.')).toBeInTheDocument();
    expect(screen.getByText('Licence: CC-BY-4.0.')).toBeInTheDocument();
    expect(screen.getByText('Contains the Chatwarden community term list (chatwarden.dev), CC BY 4.0.')).toBeInTheDocument();
    const counts = screen.getByRole('list', { name: 'What is in the list' });
    expect(within(counts).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['English (en): 3 terms and 1 exception', 'Spanish (es): 2 terms and 0 exceptions']);
    noWordsIn(container.innerHTML);
    expect(sent(w, 'GET', '/community')).toHaveLength(1);
    // Applied: the version in use.
    const done = await hubWorld({ role: 'owner', community: {} });
    renderHub(done, { path: '/settings/community' });
    expect(await screen.findByText('In use: version 2026.12.0.')).toBeInTheDocument();
    expect(screen.getByText('You have the newest version.')).toBeInTheDocument();
  });

  it('Check now asks the loader once and shows when; a failed check shows the code in words and a role that may not write cannot press it', async () => {
    const { w, user } = await openCommunity();
    expect(screen.getByText('Last checked 1 minute ago.')).toBeInTheDocument();
    w.community!.rig.onRefresh = () => {
      w.community!.rig.current = { ...w.community!.rig.current, state: 'failed', lastError: { code: 'bad_signature', stage: 'verify', at: 1 } };
    };
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('The last check had a problem: the signature did not verify.')).toBeInTheDocument();
    expect(w.community!.rig.refreshes).toBe(1);
    expect(sent(w, 'POST', '/community/refresh')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('the signature did not verify');
    // A stale list is a warning, not an error.
    cleanup();
    const stale = await hubWorld({ role: 'owner', community: { status: { state: 'stale', lastError: { code: 'index_expired', stage: 'index', at: 1 } } } });
    renderHub(stale, { path: '/settings/community' });
    expect(await screen.findByText('The list of releases has expired. The version in use stays in force.')).toBeInTheDocument();
    cleanup();
    // A moderator may check but not apply; a role below terms.write may not check.
    const reader = await hubWorld({ role: 'moderator', permissions: { 'terms.write': 'senior' }, community: { seed: false } });
    renderHub(reader, { path: '/settings/community' });
    await screen.findAllByRole('heading', { level: 2, name: 'Community list' });
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('each problem code has words, and none is the code', async () => {
    const codes = ['offline', 'timeout', 'too_large', 'bad_index', 'unknown_key', 'revoked_key', 'bad_signature', 'rollback', 'index_expired', 'no_such_version', 'revoked_release', 'kit_too_old', 'hash_mismatch', 'bad_zip', 'bad_manifest', 'bad_pack', 'cache_failed', 'no_trusted_keys', 'something_new'];
    for (const code of codes) {
      const w = await hubWorld({ role: 'owner', community: { seed: false, status: { state: 'failed', lastError: { code, stage: 'index', at: 1 } } } });
      const r = renderHub(w, { path: '/settings/community' });
      const line = await screen.findByText(/^The last check had a problem: /);
      expect(line.textContent, code).not.toContain(code.replaceAll('_', ' '));
      expect(line.textContent, code).not.toMatch(/_/);
      expect(line.textContent!.length).toBeGreaterThan(40);
      r.unmount();
    }
  });

  it('Apply is owner-only and shows the summary before it acts; confirming applies with no staff name on the rows', async () => {
    const { w, user } = await openCommunity();
    const apply = screen.getByRole('button', { name: 'Apply version 2026.12.0' });
    await user.click(apply);
    // The summary and the question come first; nothing has been sent.
    expect(screen.getByText('Add 3, switch off 0, switch on 0, change 0. Your changes kept: 0. Skipped as duplicates: 0.')).toBeInTheDocument();
    expect(screen.getByText('Apply this version now? It cannot be undone from here.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/community/apply')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Apply this version now? It cannot be undone from here.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apply version 2026.12.0' }));
    await user.click(screen.getByRole('button', { name: 'Apply now' }));
    expect(await screen.findByText('In use: version 2026.12.0.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/community/apply')).toHaveLength(1);
    expect(w.community!.rig.applies).toEqual([undefined]);
    const rows = w.live.records?.().terms.filter((t) => (COMMUNITY_WORDS as readonly string[]).includes(t.term)) ?? [];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ addedBy: COMMUNITY_ACTOR, updatedBy: null });
    expect(audits(w, 'community.apply')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /^Apply version/ })).toBeNull();
  });

  it('a person who is not an owner reads that only an owner can apply, and has no Apply button', async () => {
    const { w } = await openCommunity({ community: { seed: false } }, 'senior');
    expect(await screen.findByText('Only an owner can apply a version.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Apply version/ })).toBeNull();
    expect(sent(w, 'POST', '/community/apply')).toHaveLength(0);
  });

  it('an apply the server refuses is said in words, and nothing is claimed', async () => {
    const { w, user } = await openCommunity();
    w.community!.rig.pack = null;
    await user.click(screen.getByRole('button', { name: 'Apply version 2026.12.0' }));
    await user.click(screen.getByRole('button', { name: 'Apply now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('There is no verified version to apply.');
    expect(screen.queryByText('In use: version 2026.12.0.')).toBeNull();
  });

  it('Find a word looks it up with the word in the body only, and opens that one row in Terms; a miss says so', async () => {
    const { w, user, router } = await openCommunity({ community: {} });
    await user.type(screen.getByLabelText('Word to find'), 'tarvox');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Terms' })).toBeInTheDocument();
    expect(router.path).toBe('/terms');
    const lookups = sent(w, 'POST', '/terms/lookup');
    expect(lookups).toHaveLength(1);
    expect(lookups[0]?.body).toEqual({ word: 'tarvox' });
    for (const r of w.sent) expect(r.path + JSON.stringify(r.query ?? {}), r.path).not.toContain('tarvox');
    expect(await screen.findByText('Found by word')).toBeInTheDocument();
    // A word that is not in the list.
    router.navigate('/settings/community');
    await user.type(await screen.findByLabelText('Word to find'), 'nothingatall');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    expect(await screen.findByText('That word is not in your list.')).toBeInTheDocument();
    expect(router.path).toBe('/settings/community');
  });

  it('the section offers no list of words and no export', async () => {
    const { container } = await openCommunity({ community: {} });
    await screen.findByText('In use: version 2026.12.0.');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: /export|download|browse/i })).toBeNull();
    noWordsIn(container.innerHTML);
  });
});

describe('a hand-over to a hidden community row', () => {
  it('a Blocked-screen handoff to a hidden community row fetches that one row and marks it; switching it off makes it a touched row', async () => {
    const w = await hubWorld({ community: {} });
    w.blockLine('Vantablob', 'you glarn');
    const { user } = renderHub(w, { path: '/blocked' });
    await screen.findByRole('region', { name: 'Blocked lines' });
    await user.click(await screen.findByRole('button', { name: /^View the term for the line from/ }));
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    const tag = await screen.findByText('From the blocked list');
    const row = tag.closest('tr') as HTMLElement;
    // That one row was fetched by id; the list never held it.
    expect(sent(w, 'GET', '/terms/CWT-2026-00001')).toHaveLength(1);
    expect(sent(w, 'GET', '/terms')).toHaveLength(1);
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(within(row).getByText('Blocked words, hidden')).toBeInTheDocument();
    expect(within(row).getAllByRole('cell')[2]).toHaveTextContent('Community list 2026.12');
    expect(within(row).getAllByRole('cell')[3]).toHaveTextContent('1');
    expect(screen.getAllByText('From the blocked list')).toHaveLength(1);
    // Switching it off writes the person's name on it.
    await user.click(within(row).getByRole('checkbox', { name: /^Active: / }));
    await waitFor(() => expect(sent(w, 'POST', '/terms/CWT-2026-00001/active')).toHaveLength(1));
    await waitFor(() => expect(w.live.records?.().terms.find((t) => t.term === 'glarn')).toMatchObject({ active: false, updatedBy: 'ann@example.test' }));
    // The row is now the adopter's: the list shows it as a person's change, and the row is still the marked one.
    const after = (await screen.findByText('From the blocked list')).closest('tr') as HTMLElement;
    await waitFor(() => expect(within(after).getAllByRole('cell')[2]).toHaveTextContent('ann'));
    expect(within(after).getByRole('checkbox', { name: /^Active: / })).not.toBeChecked();
    expect(w.sent.filter((r) => r.method === 'GET' && r.path === '/terms').length).toBeGreaterThanOrEqual(2);
  });

  it('with the community list off, a hand-over to a row that is not listed asks for nothing (no GET /terms/:id, so no 404 in the console)', async () => {
    const w = await hubWorld();
    renderHub(w, { path: '/terms', onController: (c) => c.session.handoff.set({ kind: 'term', id: 'CWT-2026-99999' }) });
    await screen.findByRole('region', { name: /^English/ });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(w.sent.filter((r) => /^\/terms\/[^/]+$/.test(r.path))).toEqual([]);
    expect(sent(w, 'GET', '/community')).toHaveLength(0);
  });

  it('with the community list on, the same hand-over still asks once', async () => {
    const w = await hubWorld({ community: {} });
    renderHub(w, { path: '/terms', onController: (c) => c.session.handoff.set({ kind: 'term', id: 'CWT-2026-00001' }) });
    await screen.findByRole('region', { name: /^English/ });
    await waitFor(() => expect(sent(w, 'GET', '/terms/CWT-2026-00001')).toHaveLength(1));
  });

  it('the Tester names a hidden community term by fetching that one row', async () => {
    const { w, user } = await openTerms({ community: {} });
    await user.type(screen.getByLabelText('Message to test'), 'you glarn');
    await user.click(screen.getByRole('button', { name: 'Test' }));
    expect(await screen.findByText('This message would be blocked.')).toBeInTheDocument();
    await waitFor(() => expect(sent(w, 'GET', '/terms/CWT-2026-00001')).toHaveLength(1));
    expect(await screen.findByText('It matches a term in English (en).')).toBeInTheDocument();
    expect(document.querySelector('.cw-tester-result')?.textContent).not.toContain('glarn');
    // With words shown, the term is named, still without listing the community.
    await user.click(showWords());
    expect(await screen.findByText(/^It matches glarn in English/)).toBeInTheDocument();
  });
});

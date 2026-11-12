import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PlayerNotice } from '@chatwarden/core';
import { MyRecord } from '../src/MyRecord.js';
import type { MyRecordProps } from '../src/MyRecord.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import type { NoticeQueueProps } from '../src/NoticeQueue.js';
import { en } from '../src/i18n.js';
import { bodyKey, isSanction, kindKey, titleKey } from '../src/ui.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, BOB, DAY, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const URL_OK = 'https://game.test/appeal';
const SENT = 'Appeal sent. You will get a message here when it has been decided.';
const queue = (w: PlayerWorld, more: Partial<NoticeQueueProps> = {}): NoticeQueueProps => ({ client: w.client, now: w.now, ...FIXED, ...more });
const record = (w: PlayerWorld, more: Partial<MyRecordProps> = {}): MyRecordProps => ({ client: w.client, now: w.now, ...FIXED, ...more });
const dialog = () => screen.findByRole('dialog');
const mistake = (scope: HTMLElement | Document = document) => within(scope as HTMLElement).queryByRole('button', { name: 'Think this is a mistake?' });
const day = (at: number) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
const answer = (status: number, body: unknown) => () => ({ status, body, headers: {} });
const calls = (w: PlayerWorld, method: string, path: string) => w.sent.filter((r) => r.method === method && r.path === path);

async function warned(appeals: Record<string, unknown> | undefined = {}) {
  const w = await playerWorld(appeals === undefined ? {} : { appeals });
  await w.warn(ALICE, { rule: 2 });
  return w;
}

/** A notice as the server sends it, for the kinds the real routes make only through other tasks' flows. */
const notice = (over: Omit<Partial<PlayerNotice>, 'kind'> & { kind: string; id: string }): PlayerNotice =>
  ({ rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: 1, mustAcknowledge: false, ...over }) as PlayerNotice;
const listOf = (...n: PlayerNotice[]) => (req: { path: string }) => (req.path === '/notices' ? { status: 200, body: { notices: n }, headers: {} } : undefined);

describe('without the appeals prop NoticeQueue and MyRecord render exactly the appealUrl link of 0.1.7; with it a button opens the dialog and appealUrl is unused', () => {
  it('NoticeQueue: no prop, or false, is the old link, character for character, and never asks GET /appeals', async () => {
    const w = await warned();
    const html: string[] = [];
    for (const more of [{ appealUrl: URL_OK }, { appealUrl: URL_OK, appeals: false }]) {
      const r = renderUi(<NoticeQueue {...queue(w, more)} />);
      const d = await dialog();
      const slot = d.querySelector('.cw-appeal') as HTMLElement;
      html.push(slot.outerHTML);
      expect(within(slot).getByRole('link', { name: 'Think this is a mistake?' })).toHaveAttribute('href', URL_OK);
      expect(mistake(d)).toBeNull();
      r.unmount();
    }
    expect(html[0]).toBe('<p class="cw-appeal"><a class="cw-link" href="https://game.test/appeal" target="_blank" rel="noopener noreferrer">Think this is a mistake?</a></p>');
    expect(html[1]).toBe(html[0]);
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /notices', 'GET /notices']);
  });

  it('MyRecord: no prop, or false, is the old link above the list, and never asks GET /appeals', async () => {
    const w = await warned();
    for (const more of [{ appealUrl: URL_OK }, { appealUrl: URL_OK, appeals: false }]) {
      const r = renderUi(<MyRecord {...record(w, more)} />);
      await screen.findByRole('list', { name: 'Your record' });
      const slots = [...document.querySelectorAll('.cw-appeal')];
      expect(slots).toHaveLength(1);
      expect(slots[0]?.outerHTML).toBe('<p class="cw-appeal"><a class="cw-link" href="https://game.test/appeal" target="_blank" rel="noopener noreferrer">Think this is a mistake?</a></p>');
      expect(screen.queryByRole('button', { name: 'Think this is a mistake?' })).toBeNull();
      r.unmount();
    }
    expect(w.sent.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /record', 'GET /record']);
  });

  it('with neither the prop nor an address there is nothing at all, as before', async () => {
    const w = await warned();
    renderUi(<NoticeQueue {...queue(w)} />);
    const d = await dialog();
    expect(d.querySelector('.cw-appeal')).toBeNull();
    expect(mistake(d)).toBeNull();
  });

  it('NoticeQueue with appeals: a button, not a link; appealUrl is not used (not even when it is safe)', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    const button = await within(d).findByRole('button', { name: 'Think this is a mistake?' });
    expect(within(d).queryByRole('link')).toBeNull();
    expect(d.innerHTML).not.toContain('game.test');
    expect(calls(w, 'GET', '/appeals')).toHaveLength(1);
    expect(button).toHaveAttribute('type', 'button');
    // A press opens the dialog, in place: still one dialog, now the appeal form.
    await user.click(button);
    expect(await screen.findByRole('heading', { name: 'Ask for a second look' })).toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });

  it('MyRecord with appeals: a button on the sanction, no link anywhere, appealUrl unused; it opens the dialog', async () => {
    const w = await warned();
    const { user } = renderUi(<MyRecord {...record(w, { appeals: true, appealUrl: URL_OK })} />);
    const list = await screen.findByRole('list', { name: 'Your record' });
    const button = await within(list).findByRole('button', { name: 'Think this is a mistake?' });
    expect(screen.queryByRole('link')).toBeNull();
    expect(document.body.innerHTML).not.toContain('game.test');
    await user.click(button);
    expect(await dialog()).toHaveAccessibleName('Ask for a second look');
  });

  it('appeals with no appealUrl still shows the button (the address was only ever the fallback)', async () => {
    const w = await warned();
    renderUi(<MyRecord {...record(w, { appeals: true })} />);
    expect(await screen.findByRole('button', { name: 'Think this is a mistake?' })).toBeInTheDocument();
  });

  it('a failed or refused GET /appeals does not take the button away (a filing says what is wrong in words)', async () => {
    for (const status of [404, 500]) {
      const w = await warned();
      w.intercept.fn = (req) => (req.path === '/appeals' ? { status, body: { error: 'x', message: 'x' }, headers: {} } : undefined);
      const r = renderUi(<MyRecord {...record(w, { appeals: true })} />);
      expect(await screen.findByRole('button', { name: 'Think this is a mistake?' })).toBeInTheDocument();
      r.unmount();
    }
  });

  it('the button is not drawn until the appeals are known, so a sent appeal never flickers as a button first', async () => {
    const w = await warned();
    await w.client.fileAppeal(w.noticeOf(ALICE), 'already sent');
    let release: () => void = () => undefined;
    w.intercept.fn = (req) => (req.path === '/appeals' ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined);
    renderUi(<MyRecord {...record(w, { appeals: true })} />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(mistake()).toBeNull();
    release();
    expect(await screen.findByText(/^Appeal sent /)).toBeInTheDocument();
    expect(mistake()).toBeNull();
  });

  it('only a sanction can be appealed: a report outcome has no button even with appeals on', async () => {
    const w = await playerWorld({ appeals: {} });
    await w.warn(ALICE);
    w.caller.key = BOB.key;
    renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Thanks for your report' })).toBeInTheDocument();
    expect(mistake(d)).toBeNull();
    expect(d.querySelector('.cw-appeal')).toBeNull();
  });
});

describe('after a sent appeal the button is replaced by "Appeal sent <date>" and then the outcome in words', () => {
  it('NoticeQueue: send, close, and the notice shows "Appeal sent <date>" in place of the button, with focus on it', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'It was a joke.');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(SENT);
    // The notice is not acknowledged by appealing, and nothing is acknowledged while the form is open.
    expect(calls(w, 'POST', `/notices/${w.noticeOf(ALICE)}/ack`)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
    const at = (await w.client.appeals())[0]?.createdAt as number;
    const status = within(d).getByText(`Appeal sent ${day(at)}`);
    expect(status).toHaveFocus();
    expect(mistake(d)).toBeNull();
    // The player can still acknowledge the notice.
    expect(within(d).getByRole('button', { name: 'Acknowledge' })).toBeInTheDocument();
  });

  it('NoticeQueue: Cancel or Escape in the form goes back to the notice, focus on the button, and acknowledges nothing', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    for (const how of ['cancel', 'escape'] as const) {
      await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
      expect(screen.queryByRole('heading', { name: 'You have a warning' })).toBeNull();
      if (how === 'cancel') await user.click(screen.getByRole('button', { name: 'Cancel' }));
      else await user.keyboard('{Escape}');
      expect(await screen.findByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Think this is a mistake?' })).toHaveFocus();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
    }
    expect(w.sent.filter((r) => r.method === 'POST')).toEqual([]);
  });

  it('NoticeQueue: Escape on the plain notice still does nothing (a notice has to be acknowledged)', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    await screen.findByRole('button', { name: 'Think this is a mistake?' });
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
  });

  it('NoticeQueue: an appeal already sent (from an earlier visit) shows its status straight away, not the button', async () => {
    const w = await warned();
    await w.client.fileAppeal(w.noticeOf(ALICE), 'earlier');
    renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(await within(d).findByText(/^Appeal sent /)).toBeInTheDocument();
    expect(mistake(d)).toBeNull();
    expect(within(d).queryByRole('link')).toBeNull();
  });

  it('MyRecord: send from the dialog, and the item says "Appeal sent <date>" with focus on it', async () => {
    const w = await warned();
    const { user } = renderUi(<MyRecord {...record(w, { appeals: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'It was a joke.');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(SENT);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    const at = (await w.client.appeals())[0]?.createdAt as number;
    expect(screen.getByText(`Appeal sent ${day(at)}`)).toHaveFocus();
    expect(mistake()).toBeNull();
  });

  it('MyRecord: Cancel returns focus to the button that opened the dialog', async () => {
    const w = await warned();
    const { user } = renderUi(<MyRecord {...record(w, { appeals: true })} />);
    const button = await screen.findByRole('button', { name: 'Think this is a mistake?' });
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('an appeal is per sanction: appealing one leaves the other\'s button', async () => {
    const w = await playerWorld({ appeals: {} });
    await w.warn(ALICE, { rule: 2 });
    w.clock.t += DAY;
    await w.sanction(ALICE, 'chat', { rule: 1, durationMs: DAY });
    await w.client.fileAppeal(w.noticeOf(ALICE, 0), 'the warning');
    renderUi(<MyRecord {...record(w, { appeals: true })} />);
    const list = await screen.findByRole('list', { name: 'Your record' });
    await within(list).findAllByText(/./, { selector: 'h3' });
    await waitFor(() => expect(within(list).getAllByRole('button', { name: 'Think this is a mistake?' })).toHaveLength(1));
    expect(within(list).getAllByText(/^Appeal sent /)).toHaveLength(1);
    const items = [...list.children] as HTMLElement[];
    const chat = items.find((i) => within(i).queryByRole('heading', { name: 'Chat restriction' }) !== null) as HTMLElement;
    const warning = items.find((i) => within(i).queryByRole('heading', { name: 'Warning' }) !== null) as HTMLElement;
    expect(mistake(chat)).not.toBeNull();
    expect(within(warning).getByText(/^Appeal sent /)).toBeInTheDocument();
  });

  it.each([
    ['upheld', 'We kept the decision'],
    ['reduced', 'We made it lighter'],
    ['revoked', 'We removed it'],
  ])('a %s appeal reads "%s", with no button and no link, in NoticeQueue and MyRecord', async (status, words) => {
    const w = await warned();
    const id = w.noticeOf(ALICE);
    const row = { id: 'ap1', noticeId: id, status, createdAt: 1_800_000_000_000, decidedAt: 1_800_000_100_000 };
    w.intercept.fn = (req) => (req.path === '/appeals' ? { status: 200, body: { appeals: [row] }, headers: {} } : undefined);
    const q = renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(await within(d).findByText(words)).toBeInTheDocument();
    expect(mistake(d)).toBeNull();
    expect(within(d).queryByRole('link')).toBeNull();
    expect(d).not.toHaveTextContent('Appeal sent');
    q.unmount();
    renderUi(<MyRecord {...record(w, { appeals: true, appealUrl: URL_OK })} />);
    expect(await screen.findByText(words)).toBeInTheDocument();
    expect(mistake()).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('a real upheld appeal: asked again with a new refreshKey, the notice reads "We kept the decision"', async () => {
    const w = await warned();
    await w.client.fileAppeal(w.noticeOf(ALICE), 'please');
    const view = renderUi(<MyRecord {...record(w, { appeals: true, refreshKey: 1 })} />);
    expect(await screen.findByText(/^Appeal sent /)).toBeInTheDocument();
    await w.decideAppeal(ALICE, 'uphold');
    view.rerender(<MyRecord {...record(w, { appeals: true, refreshKey: 2 })} />);
    expect(await screen.findByText('We kept the decision')).toBeInTheDocument();
    expect(screen.queryByText(/^Appeal sent /)).toBeNull();
  });

  it('a moot or unknown status never reaches the words: the button is back (the client drops the row)', async () => {
    const w = await warned();
    const id = w.noticeOf(ALICE);
    w.intercept.fn = (req) =>
      req.path === '/appeals' ? { status: 200, body: { appeals: [{ id: 'ap1', noticeId: id, status: 'moot', createdAt: 1, decidedAt: null }] }, headers: {} } : undefined;
    renderUi(<MyRecord {...record(w, { appeals: true })} />);
    expect(await screen.findByRole('button', { name: 'Think this is a mistake?' })).toBeInTheDocument();
  });

  it('the refusal "already appealed" from a stale list is shown in the dialog in words', async () => {
    const w = await warned();
    w.intercept.fn = (req) => (req.path === '/appeals' && req.method === 'GET' ? { status: 200, body: { appeals: [] }, headers: {} } : undefined);
    await w.client.fileAppeal(w.noticeOf(ALICE), 'first, from another device');
    const { user } = renderUi(<MyRecord {...record(w, { appeals: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'again');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This has already been looked at again.');
  });
});

/** A promise a test settles by hand, to hold a request on its way. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('NoticeQueue: the hold lifting while the appeal form is open', () => {
  it('typed text is kept: the hold hides the dialog, and the same words are in the box when it is released', async () => {
    const w = await warned();
    const { user, rerender } = renderUi(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'It was a joke, honestly.');
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: false })} />);
    expect(screen.queryByRole('dialog')).toBeNull();
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    const box = (await screen.findByRole('textbox', { name: 'What should we know?' })) as HTMLTextAreaElement;
    expect(box.value).toBe('It was a joke, honestly.');
    expect(screen.getByRole('heading', { name: 'Ask for a second look' })).toHaveFocus();
    // and it can still be sent
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(SENT);
    expect(calls(w, 'POST', '/appeals')).toHaveLength(1);
    expect((calls(w, 'POST', '/appeals')[0]?.body as { statement: string }).statement).toBe('It was a joke, honestly.');
  });

  it('a send that finishes while the dialog is held is recorded: the sent screen is there on release, and later the notice says "Appeal sent"', async () => {
    const w = await warned();
    const hold = deferred<void>();
    w.intercept.fn = async (req) => {
      if (req.method === 'POST' && req.path === '/appeals') await hold.promise;
      return undefined;
    };
    const { user, rerender } = renderUi(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'Please look again.');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await waitFor(() => expect(calls(w, 'POST', '/appeals')).toHaveLength(1));
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: false })} />);
    hold.resolve();
    await waitFor(async () => expect(await w.client.appeals()).toHaveLength(1));
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    await screen.findByText(SENT);
    // no blank form that would file a second appeal, and no second request
    expect(screen.queryByRole('textbox', { name: 'What should we know?' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    const d = await dialog();
    const at = (await w.client.appeals())[0]?.createdAt as number;
    expect(within(d).getByText(`Appeal sent ${day(at)}`)).toBeInTheDocument();
    expect(mistake(d)).toBeNull();
    expect(calls(w, 'POST', '/appeals')).toHaveLength(1);
  });

  it('a send still on its way when the hold lifts shows busy and ends with the sent screen', async () => {
    const w = await warned();
    const hold = deferred<void>();
    w.intercept.fn = async (req) => {
      if (req.method === 'POST' && req.path === '/appeals') await hold.promise;
      return undefined;
    };
    const { user, rerender } = renderUi(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'Please look again.');
    await user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await waitFor(() => expect(calls(w, 'POST', '/appeals')).toHaveLength(1));
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: false })} />);
    rerender(<NoticeQueue {...queue(w, { appeals: true, canShow: true })} />);
    const send = await screen.findByRole('button', { name: 'Send appeal' });
    expect(send).toHaveAttribute('aria-disabled', 'true');
    await user.click(send);
    expect(calls(w, 'POST', '/appeals')).toHaveLength(1);
    hold.resolve();
    await screen.findByText(SENT);
  });

  it('a draft belongs to one opening: Cancel drops it, and the next opening starts empty', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    await user.type(screen.getByRole('textbox', { name: 'What should we know?' }), 'draft');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    expect((screen.getByRole('textbox', { name: 'What should we know?' }) as HTMLTextAreaElement).value).toBe('');
  });
});

describe('NoticeQueue: the appeal button while an acknowledge is on its way', () => {
  it('is inert: pressing it does not swap the card for the form, and it works again if the acknowledge fails', async () => {
    const w = await warned();
    const hold = deferred<void>();
    w.intercept.fn = async (req) => {
      if (req.method === 'POST' && /\/ack$/.test(req.path)) {
        await hold.promise;
        return { status: 500, body: { error: 'internal', message: 'x' }, headers: {} };
      }
      return undefined;
    };
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    const button = await screen.findByRole('button', { name: 'Think this is a mistake?' });
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    await waitFor(() => expect(calls(w, 'POST', `/notices/${w.noticeOf(ALICE)}/ack`)).toHaveLength(1));
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await user.click(button);
    expect(screen.queryByRole('textbox', { name: 'What should we know?' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'You have a warning' })).toBeInTheDocument();
    hold.resolve();
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Think this is a mistake?' })).not.toHaveAttribute('aria-disabled');
    await user.click(screen.getByRole('button', { name: 'Think this is a mistake?' }));
    expect(await screen.findByRole('textbox', { name: 'What should we know?' })).toBeInTheDocument();
  });

  it('control: with nothing in flight the button is not marked and opens the form', async () => {
    const w = await warned();
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    const button = await screen.findByRole('button', { name: 'Think this is a mistake?' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(await screen.findByRole('textbox', { name: 'What should we know?' })).toBeInTheDocument();
  });
});

describe('the four new notice kinds render with their titles and one "Got it", no referee card and no appeal link; an unknown kind falls back to the generic title; rename_required shows', () => {
  const KINDS: Array<[string, string, string]> = [
    ['rename_required', 'Please choose a new name', 'A moderator asked you to change your name because it breaks the community rules. Choose a new name to keep playing.'],
    ['appeal_upheld', 'We looked again and kept the decision', 'A moderator read your appeal. The original decision stands.'],
    ['appeal_reduced', 'We looked again and changed the decision', 'A moderator read your appeal and made the decision lighter. The new decision is on your record.'],
    ['appeal_revoked', 'We looked again and removed the decision', 'A moderator read your appeal and took the decision off your record.'],
  ];

  it.each(KINDS)('%s: its title and its words, one "Got it", no card, no appeal, and "Got it" acknowledges it', async (kind, title, body) => {
    const w = await playerWorld({ appeals: {} });
    w.intercept.fn = listOf(notice({ id: 'm1', kind }));
    const { user } = renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    expect(d).toHaveAccessibleName(title);
    expect(d).toHaveTextContent(body);
    expect(within(d).getAllByRole('button')).toHaveLength(1);
    expect(within(d).getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(within(d).queryByRole('button', { name: 'Acknowledge' })).toBeNull();
    expect(d.querySelector('.cw-card')).toBeNull();
    expect(within(d).queryByRole('link')).toBeNull();
    expect(d.querySelector('.cw-appeal')).toBeNull();
    expect(d).not.toHaveTextContent('Press Acknowledge');
    w.intercept.fn = answer(200, { ok: true });
    await user.click(within(d).getByRole('button', { name: 'Got it' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(w.sent.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/notices/m1/ack']);
  });

  it('the same without the appeals prop and with a link configured: still no link', async () => {
    const w = await playerWorld();
    w.intercept.fn = listOf(notice({ id: 'm1', kind: 'appeal_upheld' }));
    renderUi(<NoticeQueue {...queue(w, { appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(within(d).queryByRole('link')).toBeNull();
    expect(w.sent.map((r) => r.path)).toEqual(['/notices']);
  });

  it('an unknown kind (a newer server) falls back to the generic title and body, one "Got it", no card, no appeal', async () => {
    const w = await playerWorld({ appeals: {} });
    w.intercept.fn = listOf(notice({ id: 'u1', kind: 'something_new' }));
    renderUi(<NoticeQueue {...queue(w, { appeals: true, appealUrl: URL_OK })} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'A message from the moderators' })).toBeInTheDocument();
    expect(d).toHaveTextContent('There is a new message about your account.');
    expect(within(d).getAllByRole('button')).toHaveLength(1);
    expect(d.querySelector('.cw-card')).toBeNull();
    expect(within(d).queryByRole('link')).toBeNull();
  });

  it('a message kind that arrives with a rule still has no appeal and no card (it names no sanction)', async () => {
    const w = await playerWorld({ appeals: {} });
    w.intercept.fn = listOf(notice({ id: 'm1', kind: 'rename_required', rule: 1, ruleLabel: 'Be respectful', refCode: null }));
    renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    const d = await dialog();
    expect(within(d).queryByRole('button', { name: 'Think this is a mistake?' })).toBeNull();
    expect(d.querySelector('.cw-card')).toBeNull();
  });

  it('they queue with everything else, oldest first, each with its own title', async () => {
    const w = await playerWorld({ appeals: {} });
    w.intercept.fn = listOf(notice({ id: 'b', kind: 'appeal_revoked', createdAt: 20 }), notice({ id: 'a', kind: 'rename_required', createdAt: 10 }));
    const { user } = renderUi(<NoticeQueue {...queue(w)} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'Please choose a new name' })).toBeInTheDocument();
    expect(d).toHaveTextContent('Notice 1 of 2');
    w.intercept.fn = (req) => (req.method === 'POST' ? { status: 200, body: { ok: true }, headers: {} } : listOf(notice({ id: 'b', kind: 'appeal_revoked', createdAt: 20 }))(req));
    await user.click(within(d).getByRole('button', { name: 'Got it' }));
    expect(await screen.findByRole('heading', { name: 'We looked again and removed the decision' })).toBeInTheDocument();
  });

  it('a real appeal decided by a moderator: the player gets the notice for the outcome, with no reason in it', async () => {
    const w = await warned();
    await w.client.fileAppeal(w.noticeOf(ALICE), 'please');
    await w.cw.notices.ack({ clientKey: ALICE.key }, w.noticeOf(ALICE));
    await w.decideAppeal(ALICE, 'uphold');
    renderUi(<NoticeQueue {...queue(w, { appeals: true })} />);
    const d = await dialog();
    expect(within(d).getByRole('heading', { name: 'We looked again and kept the decision' })).toBeInTheDocument();
    expect(within(d).getAllByRole('button')).toHaveLength(1);
    expect(d).not.toHaveTextContent('private appeal reason');
  });

  it('a record never lists them and a MyRecord that is handed one shows the generic kind, not a sanction', async () => {
    const w = await playerWorld({ appeals: {} });
    w.intercept.fn = (req) => (req.path === '/record' ? { status: 200, body: { record: [notice({ id: 'm1', kind: 'appeal_upheld' })] }, headers: {} } : undefined);
    renderUi(<MyRecord {...record(w, { appeals: true })} />);
    const list = await screen.findByRole('list', { name: 'Your record' });
    expect(within(list).getByRole('heading', { name: 'Notice' })).toBeInTheDocument();
    expect(within(list).queryByRole('button')).toBeNull();
    expect(list.querySelector('.cw-card')).toBeNull();
  });
});

describe('the words for the four kinds', () => {
  it.each(['rename_required', 'appeal_upheld', 'appeal_reduced', 'appeal_revoked'])('%s has its own title and body key, and is not a sanction', (kind) => {
    expect(titleKey(kind)).toBe(`player.notice.title.${kind}`);
    expect(bodyKey(kind)).toBe(`player.notice.body.${kind}`);
    expect(isSanction(kind)).toBe(false);
    expect(kindKey(kind)).toBe('player.record.kind.fallback');
    expect(Object.keys(en)).toContain(`player.notice.title.${kind}`);
    expect(Object.keys(en)).toContain(`player.notice.body.${kind}`);
  });

  it('the sanctions are still sanctions and the generic fallback is unchanged (control)', () => {
    for (const kind of ['warning', 'chat', 'area', 'ban']) expect(isSanction(kind)).toBe(true);
    for (const kind of ['report_outcome', 'note', '', 'constructor', '__proto__']) expect(isSanction(kind)).toBe(false);
    expect(titleKey('constructor')).toBe('player.notice.title.fallback');
    expect(bodyKey('__proto__')).toBe('player.notice.body.fallback');
  });

  it('the spec\'s appeal words are in the catalog, verbatim', () => {
    const want: Record<string, string> = {
      'player.appeal.title': 'Ask for a second look',
      'player.appeal.intro': 'Tell us what you think we got wrong. A moderator will read it and decide again.',
      'player.appeal.label': 'What should we know?',
      'player.appeal.hint': 'Up to {max} characters. Do not include passwords or personal details.',
      'player.appeal.send': 'Send appeal',
      'player.appeal.cancel': 'Cancel',
      'player.appeal.count': '{n} of {max}',
      'player.appeal.sent': SENT,
      'player.appeal.status.open': 'Appeal sent {when}',
      'player.appeal.status.upheld': 'We kept the decision',
      'player.appeal.status.reduced': 'We made it lighter',
      'player.appeal.status.revoked': 'We removed it',
      'player.appeal.refused.already_appealed': 'This has already been looked at again.',
      'player.appeal.refused.rate': 'You have sent as many appeals as are allowed for now. Try again later.',
      'player.appeal.refused.not_found': 'This can no longer be appealed.',
      'player.appeal.refused.invalid': 'Write a few words, up to {max} characters.',
      'player.appeal.failed': 'We could not send your appeal. Try again.',
      'player.notice.title.appeal_upheld': 'We looked again and kept the decision',
      'player.notice.body.appeal_upheld': 'A moderator read your appeal. The original decision stands.',
      'player.notice.title.appeal_reduced': 'We looked again and changed the decision',
      'player.notice.body.appeal_reduced': 'A moderator read your appeal and made the decision lighter. The new decision is on your record.',
      'player.notice.title.appeal_revoked': 'We looked again and removed the decision',
      'player.notice.body.appeal_revoked': 'A moderator read your appeal and took the decision off your record.',
    };
    const have = en as Record<string, string>;
    for (const [key, words] of Object.entries(want)) expect(have[key], key).toBe(words);
  });
});

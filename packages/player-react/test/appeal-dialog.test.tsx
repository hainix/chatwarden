import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerAppeal } from '@chatwarden/core';
import { AppealDialog } from '../src/AppealDialog.js';
import type { AppealDialogProps } from '../src/AppealDialog.js';
import { PlayerError } from '../src/client.js';
import type { FileAppealOutcome, PlayerClient } from '../src/client.js';
import { createT, en } from '../src/i18n.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

const SENT = 'Appeal sent. You will get a message here when it has been decided.';
const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => () => ({ status, body, headers });

async function world(appeals: Record<string, unknown> = {}) {
  const w = await playerWorld({ appeals });
  await w.warn(ALICE);
  return { w, noticeId: w.noticeOf(ALICE) };
}
const props = (w: PlayerWorld, noticeId: string, more: Partial<AppealDialogProps> = {}): AppealDialogProps => ({ client: w.client, noticeId, onClose: () => undefined, ...FIXED, ...more });
const box = () => screen.getByRole('textbox', { name: 'What should we know?' }) as HTMLTextAreaElement;
const sendButton = () => screen.getByRole('button', { name: 'Send appeal' });
const cancelButton = () => screen.getByRole('button', { name: 'Cancel' });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const posts = (w: PlayerWorld) => w.sent.filter((r) => r.method === 'POST');

/** A client that answers `fileAppeal` as the test says, for the answers the real routes never give (every refusal word on its own). */
function fake(result: FileAppealOutcome | Error, calls: Array<[string, string]> = []): PlayerClient {
  return {
    notices: () => Promise.resolve([]),
    ack: () => Promise.resolve(true),
    record: () => Promise.resolve([]),
    rules: () => Promise.resolve({ summary: '', rules: [] }),
    appeals: () => Promise.resolve([]),
    fileAppeal: (id, text) => {
      calls.push([id, text]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

describe('the form', () => {
  it('is a labelled modal dialog: the heading names it, one textarea, a live count, Send and Cancel', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    const d = screen.getByRole('dialog');
    expect(d).toHaveAttribute('aria-modal', 'true');
    expect(d).toHaveAccessibleName('Ask for a second look');
    const heading = within(d).getByRole('heading', { level: 2, name: 'Ask for a second look' });
    expect(d).toHaveAttribute('aria-labelledby', heading.id);
    expect(d).toHaveTextContent('Tell us what you think we got wrong. A moderator will read it and decide again.');
    expect(within(d).getAllByRole('textbox')).toHaveLength(1);
    expect(box().tagName).toBe('TEXTAREA');
    expect(d).toHaveTextContent('Up to 1,000 characters. Do not include passwords or personal details.');
    expect(d).toHaveTextContent('0 of 1,000');
    expect(sendButton()).toBeInTheDocument();
    expect(cancelButton()).toBeInTheDocument();
    // Nothing was asked of the server just by opening it.
    expect(w.sent).toEqual([]);
  });

  it('the heading has focus when it opens (the dialog reads first)', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    expect(screen.getByRole('heading', { name: 'Ask for a second look' })).toHaveFocus();
  });

  it('the hint and the count describe the field', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    const described = (box().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toContain('Up to 1,000 characters');
    expect(described.join(' ')).toContain('0 of 1,000');
  });

  it('shows no refusal and no error before anything was sent', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(box()).not.toHaveAttribute('aria-invalid', 'true');
  });
});

describe('the count and the Send button', () => {
  it('Send is disabled while the field is empty or only white space, and sends nothing then', async () => {
    const { w, noticeId } = await world();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    expect(sendButton()).toBeDisabled();
    type('   \n\t  ');
    expect(sendButton()).toBeDisabled();
    await user.click(sendButton());
    expect(posts(w)).toEqual([]);
    type('a');
    expect(sendButton()).toBeEnabled();
    type('');
    expect(sendButton()).toBeDisabled();
  });

  it('counts code points, not UTF-16 units: an emoji is one', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    type('\u{1F600}\u{1F600}\u{1F600}');
    expect(screen.getByText('3 of 1,000')).toBeInTheDocument();
    type('é');
    expect(screen.getByText('2 of 1,000')).toBeInTheDocument();
  });

  it('counts the text without the white space around it (the server trims), and live as the player types', async () => {
    const { w, noticeId } = await world();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    await user.type(box(), '  hello ');
    expect(screen.getByText('5 of 1,000')).toBeInTheDocument();
    await user.type(box(), 'x');
    expect(screen.getByText('7 of 1,000')).toBeInTheDocument();
  });

  it('1,000 is allowed; 1,001 is refused in words and cannot be sent (refused, not cut: the text stays)', async () => {
    const { w, noticeId } = await world();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    type('a'.repeat(1000));
    expect(screen.getByText('1,000 of 1,000')).toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByRole('alert')).toBeNull();
    type('a'.repeat(1001));
    expect(box().value).toHaveLength(1001);
    expect(screen.getByText('1,001 of 1,000')).toBeInTheDocument();
    expect(sendButton()).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Write a few words, up to 1,000 characters.');
    expect(box()).toHaveAttribute('aria-invalid', 'true');
    await user.click(sendButton());
    expect(posts(w)).toEqual([]);
    type('a'.repeat(1000));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('1,000 emoji is 1,000 characters (2,000 units): allowed', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    type('\u{1F600}'.repeat(1000));
    expect(sendButton()).toBeEnabled();
    type('\u{1F600}'.repeat(1001));
    expect(sendButton()).toBeDisabled();
  });

  it('the textarea has no maxlength (a long paste is counted and refused, never silently cut)', async () => {
    const { w, noticeId } = await world();
    renderUi(<AppealDialog {...props(w, noticeId)} />);
    expect(box()).not.toHaveAttribute('maxlength');
  });
});

describe('sending', () => {
  it('sends the notice id and the text exactly as typed, then says it was sent and moves focus to the heading', async () => {
    const { w, noticeId } = await world();
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    const typed = '  It was a joke.\n\n\n  Ask Bea. ';
    type(typed);
    await user.click(sendButton());
    await screen.findByText(SENT);
    expect(posts(w)).toHaveLength(1);
    expect(posts(w)[0]).toMatchObject({ path: '/appeals', body: { noticeId, statement: typed } });
    expect(screen.getByRole('heading', { level: 2, name: 'Ask for a second look' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent(SENT);
    // The form is gone and the statement is not echoed back.
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('Ask Bea');
    expect(onClose).not.toHaveBeenCalled();
    // What the server holds now is an open appeal.
    expect((await w.client.appeals())[0]).toMatchObject({ noticeId, status: 'open' });
  });

  it('Close hands the filed appeal to onClose', async () => {
    const { w, noticeId } = await world();
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    type('please look again');
    await user.click(sendButton());
    await screen.findByText(SENT);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    const sent = onClose.mock.calls[0]?.[0] as PlayerAppeal;
    expect(Object.keys(sent).sort()).toEqual(['createdAt', 'decidedAt', 'id', 'noticeId', 'status']);
    expect(sent).toMatchObject({ noticeId, status: 'open', decidedAt: null });
  });

  it('Cancel and Escape close it with no appeal, and send nothing', async () => {
    const { w, noticeId } = await world();
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    await user.click(cancelButton());
    expect(onClose).toHaveBeenLastCalledWith();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenLastCalledWith();
    expect(w.sent).toEqual([]);
  });

  it('Escape works from the text field, and from the sent screen it closes with the appeal', async () => {
    const { w, noticeId } = await world();
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    await user.click(box());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    type('hello');
    await user.click(sendButton());
    await screen.findByText(SENT);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect((onClose.mock.calls[1]?.[0] as PlayerAppeal).status).toBe('open');
  });

  it('one request at a time: a second click or Enter while one is on its way sends nothing more, and Cancel and Escape wait', async () => {
    const { w, noticeId } = await world();
    let release: () => void = () => undefined;
    w.intercept.fn = (req) => (req.method === 'POST' ? new Promise((resolve) => (release = () => resolve(undefined))) : undefined);
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    type('hello');
    await user.click(sendButton());
    await waitFor(() => expect(sendButton()).toHaveAttribute('aria-busy', 'true'));
    expect(sendButton()).toHaveAttribute('aria-disabled', 'true');
    await user.click(sendButton());
    fireEvent.submit(box().closest('form') as HTMLFormElement);
    await user.click(cancelButton());
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    release();
    await screen.findByText(SENT);
    expect(posts(w)).toHaveLength(1);
  });

  it('Enter in the field is a line break, not a send; the form submits only through Send', async () => {
    const { w, noticeId } = await world();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    await user.type(box(), 'one{Enter}two');
    expect(box().value).toBe('one\ntwo');
    expect(posts(w)).toEqual([]);
  });
});

describe('each refusal in words, with the statement kept and the way out open', () => {
  const CASES: Array<[string, FileAppealOutcome, string]> = [
    ['already_appealed', { ok: false, refused: 'already_appealed' }, 'This has already been looked at again.'],
    ['rate', { ok: false, refused: 'rate' }, 'You have sent as many appeals as are allowed for now. Try again later.'],
    ['rate with a wait', { ok: false, refused: 'rate', retryAfter: 90 }, 'You have sent as many appeals as are allowed for now. Try again later.'],
    ['not_found', { ok: false, refused: 'not_found' }, 'This can no longer be appealed.'],
    ['off', { ok: false, refused: 'off' }, 'This can no longer be appealed.'],
    ['not_appealable', { ok: false, refused: 'not_appealable' }, 'This can no longer be appealed.'],
    ['statement_invalid', { ok: false, refused: 'statement_invalid' }, 'Write a few words, up to 1,000 characters.'],
  ];

  it.each(CASES)('%s', async (_name, outcome, words) => {
    const calls: Array<[string, string]> = [];
    const onClose = vi.fn();
    const { user } = renderUi(<AppealDialog client={fake(outcome, calls)} noticeId="n1" onClose={onClose} {...FIXED} />);
    type('my words');
    await user.click(sendButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(words);
    expect(alert).not.toHaveTextContent(/already_appealed|not_found|statement_invalid|not_appealable|rate\b/);
    expect(calls).toEqual([['n1', 'my words']]);
    // Still the form, with the text; the dialog did not close and did not claim a send.
    expect(box().value).toBe('my words');
    expect(screen.queryByText(SENT)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(sendButton()).not.toHaveAttribute('aria-busy');
    await user.click(cancelButton());
    expect(onClose).toHaveBeenCalledWith();
  });

  it('a refusal from the real routes: already appealed (409), not found (404), too many (429), empty (400 from the server)', async () => {
    const { w, noticeId } = await world({ perPlayerPerWeek: 1 });
    await w.warn(ALICE, { rule: 2 });
    const second = w.noticeOf(ALICE, 1);
    const { user, rerender } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    type('first');
    await user.click(sendButton());
    await screen.findByText(SENT);
    rerender(<AppealDialog key="b" {...props(w, noticeId)} />);
    type('again');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('This has already been looked at again.');
    rerender(<AppealDialog key="c" {...props(w, second)} />);
    type('another');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('You have sent as many appeals as are allowed for now. Try again later.');
    rerender(<AppealDialog key="d" {...props(w, 'gone')} />);
    type('anything');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('This can no longer be appealed.');
    // The server refusing an empty statement the dialog let through (a statement of only a control character).
    rerender(<AppealDialog key="e" {...props(w, second)} />);
    w.intercept.fn = answer(400, { error: 'invalid_statement', message: 'x' });
    type('x');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Write a few words, up to 1,000 characters.');
  });

  it('the refusal replaces the last one rather than piling up, and clears when the player types', async () => {
    const outcomes: FileAppealOutcome[] = [{ ok: false, refused: 'rate' }, { ok: false, refused: 'not_found' }];
    let i = 0;
    const client = { ...fake({ ok: false, refused: 'rate' }), fileAppeal: () => Promise.resolve(outcomes[i++] as FileAppealOutcome) };
    const { user } = renderUi(<AppealDialog client={client} noticeId="n" onClose={() => undefined} {...FIXED} />);
    type('x');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('as many appeals');
    await user.click(sendButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('can no longer be appealed'));
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    type('xy');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('a failure to send is not a refusal', () => {
  it.each([
    ['a dropped connection', new PlayerError({ status: 0, code: 'network', message: 'x' }), 'Could not reach the server. Check your connection and try again.'],
    ['a 500', new PlayerError({ status: 500, code: 'internal', message: 'x' }), 'The server had a problem. Try again in a moment.'],
    ['a 401', new PlayerError({ status: 401, code: 'unauthorized', message: 'x' }), 'You are signed out. Sign in again, then try again.'],
    ['an error that is not a PlayerError', new Error('boom'), 'Something went wrong.'],
  ])('%s: "We could not send your appeal. Try again." and the reason, with the text kept and a second try possible', async (_n, error, reason) => {
    const calls: Array<[string, string]> = [];
    const { user } = renderUi(<AppealDialog client={fake(error, calls)} noticeId="n1" onClose={() => undefined} {...FIXED} />);
    type('my words');
    await user.click(sendButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(`We could not send your appeal. Try again. ${reason}`);
    expect(alert).not.toHaveTextContent('boom');
    expect(box().value).toBe('my words');
    await user.click(sendButton());
    await waitFor(() => expect(calls).toHaveLength(2));
  });

  it('a real 500 from the route, then a success on the second try', async () => {
    const { w, noticeId } = await world();
    w.intercept.fn = answer(500, { error: 'internal', message: 'x' });
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    type('please');
    await user.click(sendButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('We could not send your appeal. Try again.');
    w.intercept.fn = null;
    await user.click(sendButton());
    await screen.findByText(SENT);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('words, themes and where it is drawn', () => {
  it('every word comes from the catalog: a translation changes all of it', async () => {
    const { w, noticeId } = await world();
    const t = createT({ ...en, 'player.appeal.title': 'Zweite Pruefung', 'player.appeal.send': 'Abschicken', 'player.appeal.count': '{n} von {max}' }, 'de');
    renderUi(<AppealDialog {...props(w, noticeId, { t, locale: 'de' })} />);
    expect(screen.getByRole('heading', { name: 'Zweite Pruefung' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abschicken' })).toBeInTheDocument();
    expect(screen.getByText('0 von 1.000')).toBeInTheDocument();
  });

  it('takes the theme and the class like the other dialogs, and draws into a container when asked', async () => {
    const { w, noticeId } = await world();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { container } = renderUi(<AppealDialog {...props(w, noticeId, { theme: 'dark', className: 'mine', container: host })} />);
    expect(container).toBeEmptyDOMElement();
    const root = host.querySelector('.cw-player');
    expect(root).toHaveClass('mine');
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(within(host).getByRole('dialog')).toBeInTheDocument();
    host.remove();
  });
});

describe('focus', () => {
  function Page({ w, noticeId }: { w: PlayerWorld; noticeId: string }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Think this is a mistake?
        </button>
        {open && <AppealDialog {...props(w, noticeId, { onClose: () => setOpen(false) })} />}
      </>
    );
  }

  it('returns to the button that opened it, on Cancel, on Escape and after a send', async () => {
    const { w, noticeId } = await world({ perPlayerPerWeek: 5 });
    const { user } = renderUi(<Page w={w} noticeId={noticeId} />);
    const opener = screen.getByRole('button', { name: 'Think this is a mistake?' });
    await user.click(opener);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.click(cancelButton());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    await user.click(opener);
    await user.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    await user.click(opener);
    type('ok');
    await user.click(sendButton());
    await screen.findByText(SENT);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside: Shift+Tab from the heading reaches Cancel, Tab from Cancel wraps to the field', async () => {
    const { w, noticeId } = await world();
    const { user } = renderUi(<AppealDialog {...props(w, noticeId)} />);
    await user.tab({ shift: true });
    expect(cancelButton()).toHaveFocus();
    await user.tab();
    expect(box()).toHaveFocus();
    // Send is disabled while empty: Tab from the field goes straight to Cancel.
    await user.tab();
    expect(cancelButton()).toHaveFocus();
  });

  it('a click on the backdrop does not close it', async () => {
    const { w, noticeId } = await world();
    const onClose = vi.fn();
    renderUi(<AppealDialog {...props(w, noticeId, { onClose })} />);
    await act(async () => {
      fireEvent.mouseDown(document.querySelector('.cw-scrim') as Element);
      fireEvent.click(document.querySelector('.cw-scrim') as Element);
    });
    expect(onClose).not.toHaveBeenCalled();
  });
});

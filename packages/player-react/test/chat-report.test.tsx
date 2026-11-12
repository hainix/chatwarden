import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReportResult } from '@chatwarden/core';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld, LocalTransport } from './chat-world.js';
import { FIXED, renderUi, SIX_REASONS } from './render.js';

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => w.close());

const box = (transport: ChatTransport, props: Partial<ChatBoxProps> = {}) => <ChatBox transport={transport} room="lobby" {...FIXED} now={w.clock.now} {...props} />;
const log = (): HTMLElement => screen.getByRole('log', { name: 'Chat' });
const optionsOf = (name: string): HTMLElement => within(log()).getByRole('button', { name: `Options for this message from ${name}` });

async function join(props: Partial<ChatBoxProps> = {}, transport: ChatTransport | LocalTransport = w.transportFor('snerp')) {
  const local = transport as LocalTransport;
  const view = renderUi(box(transport, props));
  await screen.findByRole('textbox', { name: 'Message' });
  return { ...view, transport: local };
}

/** A transport whose report answers with `result` (the real kit cannot be made to say every refusal on demand). */
function reportsWith(result: ReportResult | Error): ChatTransport {
  const inner = w.transportFor('snerp');
  return {
    open: (room, events) => {
      const conn = inner.open(room, events);
      return { ...conn, report: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) };
    },
  };
}

describe('the options control', () => {
  it('there is none on the player\'s own lines', async () => {
    w.say('lobby', 'tarvo', 'hello there');
    const { user } = await join();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'my own line{Enter}');
    const mine = (await within(log()).findByText('my own line')).closest('li') as HTMLElement;
    expect(within(mine).queryByRole('button')).toBeNull();
    const theirs = within(log()).getByText('hello there').closest('li') as HTMLElement;
    expect(within(theirs).getAllByRole('button')).toHaveLength(1);
  });

  it('is reachable by keyboard, and its label names the author', async () => {
    w.say('lobby', 'tarvo', 'one');
    w.say('lobby', 'vlemmo', 'two');
    const { user } = await join();
    await user.tab();
    expect(log()).toHaveFocus();
    await user.tab();
    expect(optionsOf('tarvo')).toHaveFocus();
    await user.tab();
    expect(optionsOf('vlemmo')).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveFocus();
    expect(optionsOf('tarvo')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens an inline row with Report and Mute {name}, and a second press closes it', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    expect(optionsOf('tarvo')).toHaveAttribute('aria-expanded', 'true');
    expect(within(log()).getByRole('button', { name: 'Report' })).toBeInTheDocument();
    expect(within(log()).getByRole('button', { name: 'Mute tarvo' })).toBeInTheDocument();
    await user.click(optionsOf('tarvo'));
    expect(within(log()).queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('only one row is open at a time', async () => {
    w.say('lobby', 'tarvo', 'one');
    w.say('lobby', 'vlemmo', 'two');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    await user.click(optionsOf('vlemmo'));
    expect(optionsOf('tarvo')).toHaveAttribute('aria-expanded', 'false');
    expect(within(log()).getAllByRole('button', { name: 'Report' })).toHaveLength(1);
    expect(within(log()).getByRole('button', { name: 'Mute vlemmo' })).toBeInTheDocument();
  });

  it('Escape closes the row and returns focus to the control', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    within(log()).getByRole('button', { name: 'Report' }).focus();
    await user.keyboard('{Escape}');
    expect(within(log()).queryByRole('button', { name: 'Report' })).toBeNull();
    expect(optionsOf('tarvo')).toHaveFocus();
  });

  it('a long name does not hide the control: the label is the name', async () => {
    const long = 'N'.repeat(32);
    w.say('lobby', long, 'one');
    await join();
    expect(optionsOf(long)).toBeInTheDocument();
  });
});

describe('report', () => {
  it('Report opens ReportDialog with the author\'s message quoted', async () => {
    w.say('lobby', 'tarvo', 'you play like a snerp');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'Report this message?' })).toBeInTheDocument();
    expect(within(dialog).getByText('“you play like a snerp”')).toBeInTheDocument();
    // the row is closed behind it
    expect(within(log()).queryByRole('button', { name: 'Report' })).toBeNull();
  });

  it('a successful report shows the dialog\'s thank-you and the remaining-reports line', async () => {
    w.say('lobby', 'tarvo', 'you play like a snerp');
    const { user, transport } = await join();
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/Thanks\. We got your report\./)).toBeInTheDocument();
    expect(screen.getByText(/You can send 9 more reports today\./)).toBeInTheDocument();
    expect(transport.reports).toHaveLength(1);
  });

  it('the thank-you from GET /rules is shown when reporting is given', async () => {
    w.say('lobby', 'tarvo', 'x');
    const reporting = { flow: 'one_tap' as const, thanks: 'A moderator will look.', reasons: [] };
    const { user } = await join({ reporting });
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/A moderator will look\./)).toBeInTheDocument();
  });

  it('filing the same line twice is refused as a duplicate, with the existing word', async () => {
    w.say('lobby', 'tarvo', 'you play like a snerp');
    const { user } = await join();
    for (let i = 0; i < 2; i += 1) {
      await user.click(optionsOf('tarvo'));
      await user.click(within(log()).getByRole('button', { name: 'Report' }));
      await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
      if (i === 0) await user.click(await screen.findByRole('button', { name: 'Close' }));
    }
    expect(await screen.findByText('You already reported this player here. We have your report.')).toBeInTheDocument();
  });

  it.each([
    ['rate', 'You have sent as many reports as you can today. You can send more tomorrow.'],
    ['suspended', 'You cannot send reports from this account for now.'],
    ['off', 'Reports are not available right now. Try again later.'],
    ['not_player', 'We cannot find that player any more. They may have left.'],
    ['reason_required', 'This report needs a reason. Close this and report again to choose one.'],
    ['duplicate', 'You already reported this player here. We have your report.'],
  ] as const)('a %s refusal shows its existing word', async (refused, words) => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join({}, reportsWith({ ok: false, refused }));
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(words)).toBeInTheDocument();
  });

  it('a not_found answer (the line aged out) is worded as the player having left', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join({}, reportsWith({ ok: false, refused: 'not_found' as never }));
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText('We cannot find that player any more. They may have left.')).toBeInTheDocument();
  });

  it('a dropped connection shows the dialog\'s failure and keeps it open', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join({}, reportsWith(new Error('Failed to fetch')));
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/Your report was not sent\./)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('the report call carries the line id and never a seat', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user, transport } = await join({ reporting: SIX_REASONS });
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByRole('combobox'), 'harassment');
    await user.click(within(dialog).getByRole('button', { name: 'Report' }));
    await screen.findByText(/Thanks/);
    expect(transport.reports).toHaveLength(1);
    const call = transport.reports[0] as { lineId: string; draft: unknown };
    expect(Object.keys(call).sort()).toEqual(['draft', 'lineId']);
    expect(call.draft).toEqual({ reason: 'harassment' });
    const line = within(log()).getByText('one').closest('li');
    expect(line).not.toBeNull();
    expect(call.lineId).toMatch(/^\d+$/);
    expect(JSON.stringify(call)).not.toMatch(/seat|subject|clientKey|raw-client-key/i);
  });

  it('closing returns focus to the options control', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(optionsOf('tarvo')).toHaveFocus();
  });

  it('Escape closes the dialog and returns focus too', async () => {
    w.say('lobby', 'tarvo', 'one');
    const { user } = await join();
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(optionsOf('tarvo')).toHaveFocus();
  });

  it('with reporting from GET /rules the reasons are offered; without it one press files', async () => {
    w.say('lobby', 'tarvo', 'one');
    const first = await join({ reporting: SIX_REASONS });
    await first.user.click(optionsOf('tarvo'));
    await first.user.click(within(log()).getByRole('button', { name: 'Report' }));
    expect(within(await screen.findByRole('dialog')).getByRole('combobox')).toBeInTheDocument();
    first.unmount();
    const second = await join();
    await second.user.click(optionsOf('tarvo'));
    await second.user.click(within(log()).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('combobox')).toBeNull();
    await second.user.click(within(dialog).getByRole('button', { name: 'Report' }));
    expect(await screen.findByText(/Thanks\. We got your report\./)).toBeInTheDocument();
  });

  it('draws the dialog into a container when one is given', async () => {
    w.say('lobby', 'tarvo', 'one');
    const layer = document.createElement('div');
    document.body.append(layer);
    const { user } = await join({ container: layer });
    await user.click(optionsOf('tarvo'));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    expect(layer.contains(dialog)).toBe(true);
    layer.remove();
  });

  it('a hostile name and text are shown as text in the dialog', async () => {
    w.say('lobby', '<b>tarvo</b>', '<img src=x onerror=alert(1)>');
    const { user } = await join();
    await user.click(within(log()).getByRole('button', { name: 'Options for this message from <b>tarvo</b>' }));
    await user.click(within(log()).getByRole('button', { name: 'Report' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('“<img src=x onerror=alert(1)>”')).toBeInTheDocument();
    expect(dialog.querySelector('img, b')).toBeNull();
  });
});

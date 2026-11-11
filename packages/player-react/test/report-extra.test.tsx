import { useState } from 'react';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlayerReporting, ReportResult } from '@chatwarden/core';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { FIXED, findStatus, renderUi } from './render.js';
import axe from 'axe-core';

// jsdom paints no colours, so color-contrast is computed from the tokens in static.test.ts; every other rule runs here.
const axeViolations = async (container: HTMLElement): Promise<string[]> =>
  (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);

// `extra` (@experimental): the host's own controls, placed inside the form under the reason select and the note, above Report and
// Cancel. The host owns their state; the dialog only places them. Hidden once the report is sent.

const reporting: PlayerReporting = {
  flow: 'one_tap',
  thanks: 'Thanks.',
  reasons: [
    { id: 'spam', label: 'Spam', hint: '', group: '', asksNote: false },
    { id: 'other', label: 'Something else', hint: '', group: '', asksNote: true },
  ],
};
const ok = (): ReportResult => ({ ok: true, reportId: 'r1', remaining: 3 });

/** A host that owns the checkbox state, as Moxgate does. */
function Host(props: { onSubmit: ReportDialogProps['onSubmit']; seen?: { mute: boolean } }) {
  const [mute, setMute] = useState(false);
  if (props.seen !== undefined) props.seen.mute = mute;
  return (
    <ReportDialog
      {...FIXED}
      reporting={reporting}
      line="a line"
      onClose={() => undefined}
      onSubmit={props.onSubmit}
      extra={
        <div className="host-extra">
          <label>
            <input type="checkbox" checked={mute} onChange={(e) => setMute(e.target.checked)} /> Also mute this player
          </label>
          <p>False reports can cost you your reporting.</p>
        </div>
      }
    />
  );
}

describe('the extra node (experimental)', () => {
  it('renders inside the form, under the select and the note and above Report and Cancel', async () => {
    const { user } = renderUi(<Host onSubmit={() => Promise.resolve(ok())} />);
    await user.selectOptions(screen.getByRole('combobox'), 'other');
    const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
    const extra = form.querySelector('.host-extra') as HTMLElement;
    expect(extra).not.toBeNull();
    const select = screen.getByRole('combobox');
    const note = screen.getByRole('textbox');
    const report = screen.getByRole('button', { name: 'Report' });
    const follows = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(follows(select, extra)).toBe(true);
    expect(follows(note, extra)).toBe(true);
    expect(follows(extra, report)).toBe(true);
    expect(within(form).getByText('False reports can cost you your reporting.')).toBeInTheDocument();
  });

  it('is placed above Report even with no note open and the "Add a note" door showing', () => {
    renderUi(<Host onSubmit={() => Promise.resolve(ok())} />);
    const form = screen.getByRole('dialog').querySelector('form') as HTMLFormElement;
    const extra = form.querySelector('.host-extra') as HTMLElement;
    const report = screen.getByRole('button', { name: 'Report' });
    expect(Boolean(extra.compareDocumentPosition(report) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it('Tab order is reason, note, extra, Report, Cancel, and the trap wraps through it', async () => {
    const { user } = renderUi(<Host onSubmit={() => Promise.resolve(ok())} />);
    await user.selectOptions(screen.getByRole('combobox'), 'other');
    screen.getByRole('combobox').focus();
    const order: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const el = document.activeElement as HTMLElement;
      order.push(el.tagName === 'BUTTON' ? (el.textContent ?? '') : (el.getAttribute('type') ?? el.tagName.toLowerCase()));
      await user.tab();
    }
    expect(order).toEqual(['select', 'textarea', 'checkbox', 'Report', 'Cancel']);
    // Forward from Cancel wraps to the select, never out of the dialog.
    expect(screen.getByRole('combobox')).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.tab({ shift: true });
    await user.tab({ shift: true });
    expect(screen.getByRole('checkbox')).toHaveFocus();
  });

  it('the host owns the state: the dialog never touches it, and sending does not read it', async () => {
    const seen = { mute: false };
    const onSubmit = vi.fn<ReportDialogProps['onSubmit']>(() => Promise.resolve(ok()));
    const { user } = renderUi(<Host onSubmit={onSubmit} seen={seen} />);
    await user.click(screen.getByRole('checkbox', { name: 'Also mute this player' }));
    expect(seen.mute).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await findStatus();
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({});
  });

  it('is absent once the report is sent, and after a refusal', async () => {
    const { user, unmount } = renderUi(<Host onSubmit={() => Promise.resolve(ok())} />);
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await findStatus();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText('False reports can cost you your reporting.')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Close']);
    unmount();
    const refused = renderUi(<Host onSubmit={() => Promise.resolve({ ok: false, refused: 'duplicate' })} />);
    await refused.user.click(screen.getByRole('button', { name: 'Report' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('stays on screen after a failed send (the form is kept)', async () => {
    const { user } = renderUi(<Host onSubmit={() => Promise.reject(new TypeError('x'))} />);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('with no extra there is nothing extra: the form is as before', () => {
    renderUi(<ReportDialog {...FIXED} reporting={reporting} onClose={() => undefined} onSubmit={() => Promise.resolve(ok())} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Add a note', 'Report', 'Cancel']);
  });

  it('is also shown in reason_required, and when there are no reasons to offer', () => {
    renderUi(<ReportDialog {...FIXED} reporting={{ ...reporting, flow: 'reason_required' }} onClose={() => undefined} onSubmit={() => Promise.resolve(ok())} extra={<input type="checkbox" aria-label="mine" />} />);
    expect(screen.getByRole('checkbox', { name: 'mine' })).toBeInTheDocument();
  });

  it('is shown when the dialog has no reasons at all (one press files it)', () => {
    renderUi(<ReportDialog {...FIXED} onClose={() => undefined} onSubmit={() => Promise.resolve(ok())} extra={<input type="checkbox" aria-label="mine" />} />);
    expect(screen.getByRole('checkbox', { name: 'mine' })).toBeInTheDocument();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Report', 'Cancel']);
  });

  it('nothing (null, false, undefined) leaves no empty wrapper behind', () => {
    for (const extra of [null, undefined, false]) {
      const { container, unmount } = renderUi(<ReportDialog {...FIXED} onClose={() => undefined} onSubmit={() => Promise.resolve(ok())} extra={extra} />);
      expect(container.querySelector('.cw-extra')).toBeNull();
      unmount();
    }
  });

  it.each(['light', 'dark'] as const)('axe passes with an extra checkbox (%s theme), empty, with an error, and sent', async (theme) => {
    const required = { ...reporting, flow: 'reason_required' as const };
    const { container, user } = renderUi(
      <ReportDialog
        {...FIXED}
        theme={theme}
        reporting={required}
        line="a line"
        onClose={() => undefined}
        onSubmit={() => Promise.resolve(ok())}
        extra={
          <label>
            <input type="checkbox" /> Also mute this player
          </label>
        }
      />,
    );
    expect(await axeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await screen.findByText('Choose a reason.');
    expect(await axeViolations(container)).toEqual([]);
    await user.selectOptions(screen.getByRole('combobox'), 'spam');
    await user.click(screen.getByRole('button', { name: 'Report' }));
    await findStatus();
    expect(await axeViolations(container)).toEqual([]);
  });
});

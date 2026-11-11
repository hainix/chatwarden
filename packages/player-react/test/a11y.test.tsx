import { screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { MyRecord } from '../src/MyRecord.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import { ReportDialog } from '../src/ReportDialog.js';
import type { ReportDialogProps } from '../src/ReportDialog.js';
import { RestrictedChatLine } from '../src/RestrictedChatLine.js';
import { RulesPage } from '../src/RulesPage.js';
import { FIXED, findStatus, renderUi, SIX_REASONS } from './render.js';
import { ALICE, DAY, HOUR, playerWorld } from './world.js';
import type { PlayerWorld } from './world.js';

// axe runs in jsdom, which has no layout or painted colours, so `color-contrast` cannot be computed here and is switched off.
// Contrast is computed from the stylesheet tokens in static.test.ts (every text and line pair, light and dark) and checked in a
// browser by the preview run. Every other rule runs, and any violation fails: the plan's bar is "no serious or critical"; this
// holds the components to none at all.
const RULES = { 'color-contrast': { enabled: false } } as const;

async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

const fail = (status: number) => () => ({ status, body: { error: 'x', message: 'x' } });

async function crowd(w: PlayerWorld) {
  await w.warn(ALICE, { rule: 2, lines: ['you play like a snerp', 'honestly tarvo'] });
  w.clock.t += 60_000;
  await w.sanction(ALICE, 'chat', { rule: 1, durationMs: DAY });
  await w.sanction(ALICE, 'area', { rule: 1, durationMs: 3 * DAY });
  await w.sanction(ALICE, 'ban', { rule: 3, durationMs: null });
}

describe.each(['light', 'dark'] as const)('axe, %s theme', (theme) => {
  const base = (w: PlayerWorld) => ({ client: w.client, now: w.now, theme, ...FIXED });

  it('NoticeQueue: a warning with lines and an appeal link', async () => {
    const w = await playerWorld();
    await crowd(w);
    const { container } = renderUi(<NoticeQueue {...base(w)} appealUrl="https://game.test/appeal" />);
    await screen.findByRole('dialog');
    expect(container.querySelector('.cw-player')).toHaveAttribute('data-cw-theme', theme);
    expect(await violations(container)).toEqual([]);
  });

  it.each(['chat', 'area', 'ban'] as const)('NoticeQueue: a %s notice', async (kind) => {
    const w = await playerWorld();
    await w.sanction(ALICE, kind, { durationMs: kind === 'ban' ? null : DAY });
    const { container } = renderUi(<NoticeQueue {...base(w)} appealUrl="/appeal" />);
    await screen.findByRole('dialog');
    expect(await violations(container)).toEqual([]);
  });

  it('NoticeQueue: a report outcome', async () => {
    const w = await playerWorld();
    await w.warn();
    w.caller.key = 'key-bob-0002-secret';
    const { container } = renderUi(<NoticeQueue {...base(w)} />);
    await screen.findByRole('dialog');
    expect(await violations(container)).toEqual([]);
  });

  it('NoticeQueue: the inline error after a failed acknowledge, and while it is busy', async () => {
    const w = await playerWorld();
    await w.warn();
    const { container, user } = renderUi(<NoticeQueue {...base(w)} />);
    await screen.findByRole('dialog');
    let release: () => void = () => undefined;
    w.intercept.fn = (req) => (req.method === 'POST' ? new Promise((resolve) => (release = () => resolve(fail(500)()))) : undefined);
    await user.click(screen.getByRole('button', { name: 'Acknowledge' }));
    expect(screen.getByRole('button', { name: 'Acknowledge' })).toHaveAttribute('aria-busy', 'true');
    expect(await violations(container)).toEqual([]);
    release();
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('NoticeQueue: the small alert when the list cannot be loaded', async () => {
    const w = await playerWorld();
    w.intercept.fn = fail(500);
    const { container } = renderUi(<NoticeQueue {...base(w)} />);
    await screen.findByRole('alert');
    expect(await violations(container)).toEqual([]);
  });

  it('MyRecord: loading, empty, a full record and a failed load', async () => {
    const w = await playerWorld();
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    const a = renderUi(<MyRecord {...base(w)} />);
    expect(await violations(a.container)).toEqual([]);
    release();
    await screen.findByText('Your record is clear. Nothing is on it right now.');
    expect(await violations(a.container)).toEqual([]);
    a.unmount();

    w.intercept.fn = null;
    await crowd(w);
    const b = renderUi(<MyRecord {...base(w)} appealUrl="https://game.test/appeal" />);
    await screen.findByRole('list', { name: 'Your record' });
    expect(await violations(b.container)).toEqual([]);
    b.unmount();

    w.intercept.fn = fail(500);
    const c = renderUi(<MyRecord {...base(w)} />);
    await screen.findByRole('alert');
    expect(await violations(c.container)).toEqual([]);
  });

  it('RulesPage: loading, the rules, no rules and a failed load', async () => {
    const w = await playerWorld();
    let release: () => void = () => undefined;
    w.intercept.fn = () => new Promise((resolve) => (release = () => resolve(undefined)));
    const a = renderUi(<RulesPage {...base(w)} />);
    expect(await violations(a.container)).toEqual([]);
    release();
    await screen.findByRole('list', { name: 'Community rules' });
    expect(await violations(a.container)).toEqual([]);
    a.unmount();

    w.intercept.fn = () => ({ status: 200, body: { summary: 'Play nicely.', rules: [] } });
    const b = renderUi(<RulesPage {...base(w)} />);
    await screen.findByText('No rules are published yet.');
    expect(await violations(b.container)).toEqual([]);
    b.unmount();

    w.intercept.fn = fail(404);
    const c = renderUi(<RulesPage {...base(w)} />);
    await screen.findByRole('alert');
    expect(await violations(c.container)).toEqual([]);
  });

  it('RestrictedChatLine: with and without an end, by a moderator and by the filter', async () => {
    const now = () => 1_800_000_000_000;
    for (const [until, byModerator, refCode] of [
      [1_800_000_000_000 + HOUR, true, 'M-4K7QW'],
      [null, true, undefined],
      [1_800_000_000_000 + HOUR, false, undefined],
      [1_800_000_000_000 - HOUR, true, undefined],
    ] as const) {
      const { container, unmount } = renderUi(<RestrictedChatLine {...FIXED} theme={theme} now={now} until={until} byModerator={byModerator} {...(refCode === undefined ? {} : { refCode })} />);
      expect(await violations(container)).toEqual([]);
      unmount();
    }
  });

  describe('ReportDialog', () => {
    const ok: ReportDialogProps['onSubmit'] = () => Promise.resolve({ ok: true, reportId: 'r', remaining: 3 });

    it('the form, its validation error and the note', async () => {
      const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={ok} onClose={() => undefined} targetName="Cara" />);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Send report' }));
      await screen.findByText('Choose a reason.');
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('radio', { name: 'Cheating' }));
      await user.type(screen.getByLabelText('Add a note (optional)'), 'a note');
      expect(await violations(container)).toEqual([]);
    });

    describe('the configurable flows (the payload comes from the real GET /rules)', () => {
      const reporting = async (flow: 'one_tap' | 'reason_first' | 'reason_required') => {
        const w = await playerWorld({ reporting: { flow } });
        const r = (await w.client.rules()).reporting;
        if (r === undefined) throw new Error('no reporting');
        return r;
      };
      const added: ReportDialogProps['onAddDetail'] = () => Promise.resolve({ ok: true });

      it('one tap: the question with the quoted line, the thank-you, and the follow-up open, with its error and its refusal', async () => {
        const r = await reporting('one_tap');
        const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} line="you play like a snerp" targetName="Cara" onSubmit={ok} onAddDetail={added} onClose={() => undefined} />);
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Report' }));
        await findStatus();
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Add a reason' }));
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Add to my report' }));
        await screen.findByText('Choose a reason or write a note.');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('radio', { name: 'Cheating' }));
        await user.type(screen.getByLabelText('Add a note (optional)'), 'a note');
        expect(await violations(container)).toEqual([]);
      });

      it('one tap: the follow-up added, refused and failed', async () => {
        const r = await reporting('one_tap');
        for (const [onAddDetail, expectedRole] of [
          [added, 'status'],
          [() => Promise.resolve({ ok: false, refused: 'too_late' }), 'alert'],
          [() => Promise.reject(new TypeError('x')), 'alert'],
        ] as const) {
          const { container, user, unmount } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} onSubmit={ok} onAddDetail={onAddDetail as ReportDialogProps['onAddDetail']} onClose={() => undefined} />);
          await user.click(screen.getByRole('button', { name: 'Report' }));
          await findStatus();
          await user.click(screen.getByRole('button', { name: 'Add a reason' }));
          await user.click(screen.getByRole('radio', { name: 'Hate' }));
          await user.click(screen.getByRole('button', { name: 'Add to my report' }));
          await waitFor(() => expect(expectedRole === 'status' ? screen.getByRole('status').textContent : screen.getAllByRole(expectedRole).map((e) => e.textContent).join()).toMatch(expectedRole === 'status' ? /Added. Thanks./ : /./));
          expect(await violations(container)).toEqual([]);
          unmount();
        }
      });

      it.each(['reason_first', 'reason_required'] as const)('%s: the grouped reasons, the note, the missing-reason error and a refusal', async (flow) => {
        const r = await reporting(flow);
        const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} line="a line" onSubmit={() => Promise.resolve({ ok: false, refused: 'reason_unknown' })} onClose={() => undefined} />);
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Send report' }));
        await screen.findByRole('alert');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('radio', { name: 'Something else' }));
        await user.type(screen.getByLabelText('Add a note (optional)'), 'a note');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Send report' }));
        await screen.findByText('That reason is not available any more. Close this and report again.');
        expect(await violations(container)).toEqual([]);
      });
    });

    it('the thank-you, a refusal and a failed send', async () => {
      const a = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={ok} onClose={() => undefined} />);
      await a.user.click(screen.getByRole('radio', { name: 'Spam' }));
      await a.user.click(screen.getByRole('button', { name: 'Send report' }));
      await findStatus();
      expect(await violations(a.container)).toEqual([]);
      a.unmount();

      const b = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={() => Promise.resolve({ ok: false, refused: 'rate', remaining: 0 })} onClose={() => undefined} />);
      await b.user.click(screen.getByRole('radio', { name: 'Spam' }));
      await b.user.click(screen.getByRole('button', { name: 'Send report' }));
      await screen.findByRole('alert');
      expect(await violations(b.container)).toEqual([]);
      b.unmount();

      const c = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={() => Promise.reject(new TypeError('x'))} onClose={() => undefined} />);
      await c.user.click(screen.getByRole('radio', { name: 'Spam' }));
      await c.user.click(screen.getByRole('button', { name: 'Send report' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(await violations(c.container)).toEqual([]);
    });
  });
});

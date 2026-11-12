import { fireEvent, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { AppealDialog } from '../src/AppealDialog.js';
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
    const why = (name: string) => screen.getByRole('combobox', { name });

    it('the form (a required select), its validation error and the note', async () => {
      const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={ok} onClose={() => undefined} targetName="Cara" />);
      expect(await violations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Report' }));
      await screen.findByText('Choose a reason.');
      expect(await violations(container)).toEqual([]);
      await user.selectOptions(why('Why?'), 'Cheating');
      await user.type(screen.getByLabelText('Note (optional)'), 'a note');
      expect(await violations(container)).toEqual([]);
    });

    describe('the configurable flows (the payload comes from the real GET /rules)', () => {
      const reporting = async (flow: 'one_tap' | 'reason_first' | 'reason_required') => {
        const w = await playerWorld({ reporting: { flow } });
        const r = (await w.client.rules()).reporting;
        if (r === undefined) throw new Error('no reporting');
        return r;
      };

      it('the one step: the question with the quoted line, the select with its hint, "Add a note", the note, the thank-you', async () => {
        const r = await reporting('one_tap');
        const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} line="you play like a snerp" targetName="Cara" onSubmit={ok} onClose={() => undefined} />);
        expect(await violations(container)).toEqual([]);
        await user.selectOptions(why('Why? (optional)'), 'harassment');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Add a note' }));
        await user.type(screen.getByLabelText('Note (optional)'), 'a note');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Report' }));
        await findStatus();
        expect(await violations(container)).toEqual([]);
      });

      it('the one step with a note shown by the reason, a refusal and a failed send', async () => {
        const r = await reporting('one_tap');
        for (const [onSubmit, role] of [
          [() => Promise.resolve({ ok: false, refused: 'too_late' }), 'alert'],
          [() => Promise.reject(new TypeError('x')), 'alert'],
        ] as const) {
          const { container, user, unmount } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} onSubmit={onSubmit as ReportDialogProps['onSubmit']} onClose={() => undefined} />);
          await user.selectOptions(why('Why? (optional)'), 'other');
          await user.type(screen.getByLabelText('Note (optional)'), 'x');
          await user.click(screen.getByRole('button', { name: 'Report' }));
          await screen.findByRole(role);
          expect(await violations(container)).toEqual([]);
          unmount();
        }
      });

      it.each(['reason_first', 'reason_required'] as const)('%s: the grouped select, the note, the missing-reason error and a refusal', async (flow) => {
        const r = await reporting(flow);
        const label = flow === 'reason_required' ? 'Why?' : 'Why? (optional)';
        const { container, user } = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={r} line="a line" onSubmit={() => Promise.resolve({ ok: false, refused: 'reason_unknown' })} onClose={() => undefined} />);
        expect(await violations(container)).toEqual([]);
        if (flow === 'reason_required') {
          await user.click(screen.getByRole('button', { name: 'Report' }));
          await screen.findByRole('alert');
          expect(await violations(container)).toEqual([]);
        }
        await user.selectOptions(why(label), 'other');
        await user.type(screen.getByLabelText('Note (optional)'), 'a note');
        expect(await violations(container)).toEqual([]);
        await user.click(screen.getByRole('button', { name: 'Report' }));
        await screen.findByText('That reason is not available any more. Close this and report again.');
        expect(await violations(container)).toEqual([]);
      });

      it('no reasons at all: the question and one button', async () => {
        const { container } = renderUi(<ReportDialog {...FIXED} theme={theme} onSubmit={ok} onClose={() => undefined} line="a line" />);
        expect(await violations(container)).toEqual([]);
      });
    });

    it('the thank-you, a refusal and a failed send', async () => {
      const a = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={ok} onClose={() => undefined} />);
      await a.user.selectOptions(why('Why?'), 'Spam');
      await a.user.click(screen.getByRole('button', { name: 'Report' }));
      await findStatus();
      expect(await violations(a.container)).toEqual([]);
      a.unmount();

      const b = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={() => Promise.resolve({ ok: false, refused: 'rate', remaining: 0 })} onClose={() => undefined} />);
      await b.user.selectOptions(why('Why?'), 'Spam');
      await b.user.click(screen.getByRole('button', { name: 'Report' }));
      await screen.findByRole('alert');
      expect(await violations(b.container)).toEqual([]);
      b.unmount();

      const c = renderUi(<ReportDialog {...FIXED} theme={theme} reporting={SIX_REASONS} onSubmit={() => Promise.reject(new TypeError('x'))} onClose={() => undefined} />);
      await c.user.selectOptions(why('Why?'), 'Spam');
      await c.user.click(screen.getByRole('button', { name: 'Report' }));
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(await violations(c.container)).toEqual([]);
    });
  });
});

describe.each(['light', 'dark'] as const)('axe, appeals, %s theme', (theme) => {
  const base = (w: PlayerWorld) => ({ client: w.client, now: w.now, theme, ...FIXED });
  const asked = async () => {
    const w = await playerWorld({ appeals: {} });
    await w.warn(ALICE, { rule: 2 });
    return w;
  };

  it('AppealDialog: the form, with a count over the limit, after a refusal, and after a send', async () => {
    const w = await asked();
    const noticeId = w.noticeOf(ALICE);
    const a = renderUi(<AppealDialog {...base(w)} noticeId={noticeId} onClose={() => undefined} />);
    expect(await violations(a.container)).toEqual([]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a'.repeat(1001) } });
    await screen.findByRole('alert');
    expect(await violations(a.container)).toEqual([]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'it was a joke' } });
    w.intercept.fn = fail(404);
    await a.user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByRole('alert');
    expect(await violations(a.container)).toEqual([]);
    w.intercept.fn = null;
    await a.user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(/^Appeal sent\./);
    expect(await violations(a.container)).toEqual([]);
  });

  it('NoticeQueue with appeals: the button, the form in place of the notice, and "Appeal sent"', async () => {
    const w = await asked();
    const q = renderUi(<NoticeQueue {...base(w)} appeals />);
    await q.user.click(await screen.findByRole('button', { name: 'Think this is a mistake?' }));
    expect(await violations(q.container)).toEqual([]);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'it was a joke' } });
    await q.user.click(screen.getByRole('button', { name: 'Send appeal' }));
    await screen.findByText(/^Appeal sent\./);
    await q.user.click(screen.getByRole('button', { name: 'Close' }));
    await screen.findByText(/^Appeal sent /);
    expect(await violations(q.container)).toEqual([]);
  });

  it('MyRecord with appeals: the button and the outcome words', async () => {
    const w = await asked();
    const r = renderUi(<MyRecord {...base(w)} appeals />);
    await screen.findByRole('button', { name: 'Think this is a mistake?' });
    expect(await violations(r.container)).toEqual([]);
    await w.client.fileAppeal(w.noticeOf(ALICE), 'please');
    await w.decideAppeal(ALICE, 'uphold');
    r.rerender(<MyRecord {...base(w)} appeals refreshKey={2} />);
    await screen.findByText('We kept the decision');
    expect(await violations(r.container)).toEqual([]);
  });

  it('NoticeQueue: an outcome notice and a rename notice', async () => {
    const w = await asked();
    for (const kind of ['appeal_revoked', 'rename_required']) {
      w.intercept.fn = (req) =>
        req.path === '/notices'
          ? { status: 200, body: { notices: [{ id: 'm1', kind, rule: null, ruleLabel: null, until: null, refCode: null, excerpt: [], createdAt: 1, mustAcknowledge: false }] }, headers: {} }
          : undefined;
      const q = renderUi(<NoticeQueue {...base(w)} appeals />);
      await screen.findByRole('dialog');
      expect(await violations(q.container)).toEqual([]);
      q.unmount();
    }
  });
});

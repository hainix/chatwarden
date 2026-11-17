import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { emptyForm, newDraft } from '../src/decision.js';
import type { DecisionForm, Draft } from '../src/decision.js';
import { decideOp } from '../src/preview/ops.js';
import { appealsHub } from './appealsWorld.js';
import { renderHub } from './render.js';
import type { RichLine } from './world.js';

// "What the player sees" in the case decision (0.2.0): the plan built from the form (pure), then the panel in the real decision bar. Synthetic terms only.

const TARGET = 'P-target';
const REPORTER = 'P-reporter';
const lines: Record<string, { text: string; day: string }> = {
  L1: { text: 'you play like a *****', day: '2027-01-15' },
  L2: { text: 'honestly tarvo', day: '2027-01-16' },
};
const lineOf = (id: string) => lines[id] ?? null;
// The report's own order of lines (the panel shows the player's lines in this order, as the notice does).
const o = { target: TARGET, reporter: REPORTER, lineOf, order: ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] };
const draft = (over: Partial<Draft> = {}): Draft => ({ ...newDraft('a1', TARGET, 2), what: 'chat:86400000', lineIds: ['L1'], ...over });
const form = (over: Partial<DecisionForm> = {}): DecisionForm => ({ ...emptyForm(), verdict: 'fair', reason: 'PRIVATE-REASON', actions: [draft()], ...over });

describe('decideOp: the plan input from the form', () => {
  it('nothing chosen is no op; a verdict alone is one with nothing in it', () => {
    expect(decideOp(emptyForm(), o)).toBeNull();
    expect(decideOp({ ...emptyForm(), verdict: 'fair' }, o)).toMatchObject({ op: 'decide', verdict: 'upheld', actions: [], rename: null });
  });

  it('fair with a chat restriction: its kind, length, rule and the lines the server masked', () => {
    expect(decideOp(form(), o)).toEqual({
      op: 'decide',
      verdict: 'upheld',
      target: TARGET,
      reporter: REPORTER,
      actions: [{ person: TARGET, kind: 'chat', durationMs: 86_400_000, rule: 2, lines: [lines.L1] }],
      rename: null,
    });
  });

  it.each([
    ['warning:null', 'warning', null],
    ['chat:3600000', 'chat', 3_600_000],
    ['area:86400000', 'area', 86_400_000],
    ['ban:null', 'ban', null],
    ['ban:604800000', 'ban', 604_800_000],
  ] as const)('%s', (what, kind, durationMs) => {
    const op = decideOp(form({ actions: [draft({ what })] }), o);
    expect(op).toMatchObject({ actions: [{ kind, durationMs }] });
  });

  it('a note shows no lines and is the "noted" verdict when it stands alone', () => {
    const op = decideOp(form({ actions: [draft({ what: 'note:null', lineIds: ['L1'] })] }), o);
    expect(op).toMatchObject({ verdict: 'noted', actions: [{ kind: 'note', durationMs: null, lines: [] }] });
  });

  it('a line with no masked text is left out, never shown as it was typed', () => {
    const op = decideOp(form({ actions: [draft({ lineIds: ['L1', 'L-RAW-ONLY', 'L2'] })] }), o);
    expect(op).toMatchObject({ actions: [{ lines: [lines.L1, lines.L2] }] });
    expect(JSON.stringify(op)).not.toContain('L-RAW-ONLY');
  });

  it('lines present and absent', () => {
    expect(decideOp(form({ actions: [draft({ lineIds: [] })] }), o)).toMatchObject({ actions: [{ lines: [] }] });
    expect(decideOp(form({ actions: [draft({ lineIds: ['L1', 'L2'] })] }), o)).toMatchObject({ actions: [{ lines: [lines.L1, lines.L2] }] });
  });

  it('lines are in the report\'s order, not the order they were ticked in; a repeat counts once', () => {
    const many: Record<string, { text: string; day: string }> = Object.fromEntries(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'].map((id) => [id, { text: `text ${id}`, day: '2027-01-15' }]));
    const op = (ids: string[]) => decideOp(form({ actions: [draft({ lineIds: ids })] }), { ...o, lineOf: (id: string) => many[id] ?? null }) as { actions: Array<{ lines: Array<{ text: string }> }> };
    expect(op(['L5', 'L2']).actions[0]?.lines.map((l) => l.text)).toEqual(['text L2', 'text L5']);
    expect(op(['L2', 'L5']).actions[0]?.lines.map((l) => l.text)).toEqual(['text L2', 'text L5']);
    expect(op(['L7', 'L1', 'L4', 'L1']).actions[0]?.lines.map((l) => l.text)).toEqual(['text L1', 'text L4', 'text L7']);
    // At most five, taken from the report's order.
    expect(op(['L7', 'L6', 'L5', 'L4', 'L3', 'L2']).actions[0]?.lines.map((l) => l.text)).toEqual(['text L2', 'text L3', 'text L4', 'text L5', 'text L6']);
    // A line the excerpt does not hold is left out, not placed first.
    expect(op(['L9', 'L3']).actions[0]?.lines.map((l) => l.text)).toEqual(['text L3']);
  });

  it('two people and two actions on one person keep each as given (the plan sorts them)', () => {
    const op = decideOp(form({ actions: [draft({ uid: 'a1', person: REPORTER, what: 'warning:null', lineIds: [] }), draft({ uid: 'a2', what: 'ban:null' }), draft({ uid: 'a3', what: 'warning:null' })], verdict: 'fair' }), o);
    expect(op).toMatchObject({ actions: [{ person: REPORTER, kind: 'warning' }, { person: TARGET, kind: 'ban' }, { person: TARGET, kind: 'warning' }] });
  });

  it('an uncovered rule is carried as "uncovered" (its gap note is not an input)', () => {
    const op = decideOp(form({ actions: [draft({ rule: 'uncovered', gapNote: 'PRIVATE-GAP' })] }), o);
    expect(op).toMatchObject({ actions: [{ rule: 'uncovered' }] });
    expect(JSON.stringify(op)).not.toContain('PRIVATE-GAP');
  });

  it('a problem never blanks it: an action with no kind chosen, no rule or a bad length is left out, the valid part stays', () => {
    const op = decideOp(form({ actions: [draft({ uid: 'a1', what: '' }), draft({ uid: 'a2', rule: '' }), draft({ uid: 'a3', what: 'other', customKind: 'chat', customDuration: 'custom', customAmount: 'x' }), draft({ uid: 'a4', what: 'warning:null' })] }), o);
    expect(op).toMatchObject({ actions: [{ kind: 'warning' }] });
    expect((op as { actions: unknown[] }).actions).toHaveLength(1);
  });

  it('a rename is carried when its rule is chosen; not while it is empty; never with a dismissal verdict', () => {
    expect(decideOp(form({ rename: { rule: '7' } }), o)).toMatchObject({ rename: { rule: 7 } });
    expect(decideOp(form({ rename: { rule: '' } }), o)).toMatchObject({ rename: null });
    expect(decideOp(form({ rename: { rule: '7' }, verdict: 'not_a_problem', actions: [] }), o)).toMatchObject({ verdict: 'no_action', rename: null });
    expect(decideOp(form({ rename: { rule: '7' }, actions: [] }), o)).toMatchObject({ verdict: 'upheld', actions: [], rename: { rule: 7 } });
  });

  it('the verdicts: not a problem and bad faith', () => {
    expect(decideOp(form({ verdict: 'not_a_problem', actions: [] }), o)).toMatchObject({ verdict: 'no_action' });
    expect(decideOp(form({ verdict: 'bad_faith', actions: [draft({ person: REPORTER, what: 'chat:3600000' })] }), o)).toMatchObject({ verdict: 'bad_faith', actions: [{ person: REPORTER }] });
  });

  it('no moderator-only field is in it: the reason, the evidence and the gap note never leave the form', () => {
    const op = decideOp(form({ evidence: 'PRIVATE-EVIDENCE', rename: { rule: '7' } }), o);
    const text = JSON.stringify(op);
    for (const secret of ['PRIVATE-REASON', 'PRIVATE-EVIDENCE', 'a1']) expect(text).not.toContain(secret);
  });
});

const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'you play like a zorbak' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'good game' },
];

async function open(w: Awaited<ReturnType<typeof appealsHub>>, id: string) {
  const r = renderHub(w, { path: `/reports/${id}` });
  await screen.findByRole('heading', { level: 2, name: /report against/ });
  await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  const bar = screen.getByRole('region', { name: 'Decision' });
  return { ...r, bar, panel: await within(bar).findByRole('region', { name: 'What the player sees' }) };
}

describe('the panel in the decision bar', () => {
  it('is the last thing above the submit row, and opens on the suggestion with the rule and the person\'s own lines', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK });
    const { bar, panel } = await open(w, f.id);
    const submit = bar.querySelector('.cw-submit') as HTMLElement;
    expect(panel.nextElementSibling).toBe(submit);
    await waitFor(() => expect(panel).toHaveTextContent('Your chat is turned off'));
    expect(panel).toHaveTextContent('Community Rule 2: No insulting, threatening or targeting another player');
    expect(panel).toHaveTextContent('Your messages that led to this');
  });

  it('lines ticked out of order are listed in the report\'s order, the order the player\'s notice has', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({
      lines: [
        { who: 'reporter', text: 'hello there' },
        { who: 'target', text: 'alpha first' },
        { who: 'target', text: 'bravo second' },
        { who: 'target', text: 'charlie third' },
      ],
    });
    const { user, panel } = await open(w, f.id);
    await waitFor(() => expect(panel).toHaveTextContent('Your messages that led to this'));
    const boxes = () => within(screen.getByRole('list', { name: 'Chat lines' })).getAllByRole('checkbox', { name: /^Show the line at/ });
    for (const box of boxes()) await user.click(box);
    // The third line first, then the first.
    await user.click(boxes()[2] as HTMLElement);
    await user.click(boxes()[0] as HTMLElement);
    const shown = () => [...panel.querySelectorAll('.cw-pv-line-text')].map((n) => n.textContent);
    await waitFor(() => expect(shown()).toEqual(['alpha first', 'charlie third']));
    // The notice the real decide writes lists them the same way.
    const res = await w.cw.decide({
      reportId: f.id,
      verdict: 'upheld',
      actor: 'mod_ann',
      reason: 'checked',
      actions: [{ subject: f.person, kind: 'chat', durationMs: 86_400_000, rule: 2, lineIds: [f.lineIds[3] as string, f.lineIds[1] as string] }],
    } as never);
    expect(res.ok).toBe(true);
    const real = w.cw.notices.pending({ clientKey: 'key-target-Mallory' } as never).find((n) => n.kind === 'chat');
    expect((real?.excerpt ?? []).map((l) => l.text)).toEqual(shown());
  });

  it('a blocked line reads from the server\'s masked text, starred; the raw word is never in the page', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK });
    const { panel } = await open(w, f.id);
    await waitFor(() => expect(panel).toHaveTextContent('Your messages that led to this'));
    expect(panel.textContent).toContain('you play like a ******');
    expect(/zorbak/i.test(panel.innerHTML)).toBe(false);
  });

  it('follows the verdict: not a problem says nothing is sent to anyone; fair brings the notices back', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK });
    const { user, bar, panel } = await open(w, f.id);
    await user.click(within(bar).getByRole('radio', { name: 'Not a problem' }));
    await waitFor(() => expect(panel).toHaveTextContent('Nothing is sent to anyone. The report is closed.'));
    expect(within(panel).queryByRole('heading', { level: 4 })).toBeNull();
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await waitFor(() => expect(within(panel).getByRole('heading', { level: 4, name: 'Your chat is turned off' })).toBeInTheDocument());
  });

  it('fair plus a rename: the sanction, the thank-you to the reporter, and the rename, in order, with who sees what', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK, reason: 'name', reporter: 'Rae' });
    const { user, bar, panel } = await open(w, f.id);
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await user.click(within(bar).getByRole('checkbox', { name: 'Ask for a new name' }));
    await waitFor(() => expect(within(panel).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Your chat is turned off', 'Please choose a new name', 'Thanks for your report']));
    expect(panel).toHaveTextContent('Notice 1 of 2');
    expect(panel).toHaveTextContent('Notice 2 of 2');
    expect(panel).toHaveTextContent('The player sees them one at a time.');
    expect(panel).toHaveTextContent('Mallory sees');
    expect(panel).toHaveTextContent('Rae, who reported, sees');
    expect(panel).toHaveTextContent('Community Rule 7: No offensive names');
    expect(panel).toHaveTextContent('They are asked to pick a new name before they can chat.');
  });

  it('reporter feedback off: the reporter is not told', async () => {
    const w = await appealsHub({ names: { renames: true }, limits: { reporterFeedback: false } });
    const f = await w.fileRich({ lines: TALK });
    const { panel } = await open(w, f.id);
    await waitFor(() => expect(panel).toHaveTextContent('Your chat is turned off'));
    expect(panel).not.toHaveTextContent('Thanks for your report');
    expect(panel).toHaveTextContent('The person who reported is not told.');
  });

  it('appeals on: the notice carries the appeal button; appeals off: none', async () => {
    const on = await appealsHub({ names: { renames: true } });
    const f = await on.fileRich({ lines: TALK });
    const opened = await open(on, f.id);
    await waitFor(() => expect(opened.panel).toHaveTextContent('Button: Think this is a mistake?'));
    opened.unmount();
    const off = await appealsHub({ names: { renames: true }, appeals: false });
    const g = await off.fileRich({ lines: TALK });
    const second = await open(off, g.id);
    await waitFor(() => expect(second.panel).toHaveTextContent('Your chat is turned off'));
    expect(second.panel).not.toHaveTextContent('Think this is a mistake?');
  });

  it('a sentinel in the reason, the evidence and the gap note never appears in the panel', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK });
    const { user, bar, panel } = await open(w, f.id);
    await user.type(within(bar).getByRole('textbox', { name: 'Reason' }), 'SENTINEL-REASON-quissel');
    await user.click(within(bar).getByRole('radio', { name: 'Bad faith' }));
    await user.type(within(bar).getByRole('textbox', { name: /evidence/i }), 'SENTINEL-EVIDENCE-drakkuun');
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await waitFor(() => expect(panel).toHaveTextContent('Your chat is turned off'));
    const everything = [panel.textContent ?? '', ...[...panel.querySelectorAll('*')].flatMap((n) => [...n.attributes].map((a) => a.value))].join('\n');
    for (const secret of ['SENTINEL-REASON-quissel', 'SENTINEL-EVIDENCE-drakkuun', f.person, f.reporter]) expect(everything, secret).not.toContain(secret);
  });

  it('a flagged name is the hidden label in the headings, and no raw handle is in the panel', async () => {
    const w = await appealsHub({ names: { renames: true } });
    const f = await w.fileRich({ lines: TALK, target: 'zorbakKid', reporter: 'Rae' });
    const { user, bar, panel } = await open(w, f.id);
    await user.click(within(bar).getByRole('radio', { name: 'Fair' }));
    await waitFor(() => expect(panel).toHaveTextContent('Blocked words, hidden sees'));
    expect(/zorbakkid/i.test(panel.innerHTML)).toBe(false);
  });
});

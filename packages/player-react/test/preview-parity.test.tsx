import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import type { Role } from '@chatwarden/core';
import { createHubClient } from '../../hub-react/src/client.js';
import { LazyPlayerPreview } from '../../hub-react/src/lazyParts.js';
import { HubProvider } from '../../hub-react/src/provider.js';
import { routerTransport } from '../../hub-react/src/transport.js';
import type { NoticeOp } from '@chatwarden/core/notice-copy';
import { previewLines } from '../../hub-react/src/case/usePreviewParts.js';
import { emptyForm, newDraft } from '../../hub-react/src/decision.js';
import { decideOp } from '../../hub-react/src/preview/ops.js';
import { RestrictedChatLine } from '../src/RestrictedChatLine.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import { renderUi } from './render.js';
import { ALICE, DAY, playerWorld } from './world.js';

// Renderer parity (Review Focus 2 and 5): for the same decision, the text the moderator's panel draws for a notice equals the text of the notice the real
// NoticeQueue shows for what the real server holds for the player. The panel is the hub's, the queue is the player kit's, the notice is the core's.

/** The notice as text: title, body, facts (term and value), the lines (day and text), the hints and the button words. */
function textOf(root: Element, selectors: { title: string; body: string; fact: string; line: string; hint: string }): unknown {
  const pair = (el: Element, a: string, b: string) => [el.querySelector(a)?.textContent ?? '', el.querySelector(b)?.textContent ?? ''];
  return {
    title: root.querySelector(selectors.title)?.textContent,
    body: root.querySelector(selectors.body)?.textContent,
    facts: [...root.querySelectorAll(selectors.fact)].map((f) => pair(f, 'dt', 'dd')),
    lines: [...root.querySelectorAll(selectors.line)].map((l) => pair(l, '.cw-line-day, .cw-pv-line-day', '.cw-line-text, .cw-pv-line-text')),
    hints: [...root.querySelectorAll(selectors.hint)].map((h) => h.textContent),
  };
}

async function panelFor(w: Awaited<ReturnType<typeof playerWorld>>, op: NoticeOp) {
  const handle = createRouter(adminRoutes(w.cw, { authorize: () => ({ actor: 'ann@example.test', role: 'senior' as Role }), gameName: 'Test Game' }));
  const client = createHubClient(routerTransport(handle));
  const view = render(
    <HubProvider client={client} now={w.now} mode="detailed">
      <LazyPlayerPreview op={op} nameOf={() => 'Alice'} />
    </HubProvider>,
  );
  const region = await screen.findByRole('region', { name: 'What the player sees' });
  return { region, view };
}

/**
 * What the moderator's form would send for `kind` on this report: the kind and length chosen, the player's own lines ticked in the REVERSE of the report's order
 * (so the selection path is exercised), read the way the hub reads them (`GET /reports/:id`, then `noticeText` through `previewLines`), never copied out of the notice.
 */
async function opFor(w: Awaited<ReturnType<typeof playerWorld>>, reportId: string, kind: 'warning' | 'chat' | 'area' | 'ban', length: number | null, rule = 2): Promise<NoticeOp> {
  const client = createHubClient(routerTransport(createRouter(adminRoutes(w.cw, { authorize: () => ({ actor: 'ann@example.test', role: 'senior' as Role }), gameName: 'Test Game' }))));
  const { report } = await client.getReport(reportId);
  // The hub attaches no chat line to a report about play or a name (and the server would refuse one).
  const own = report.evidenceKind === 'play' || report.evidenceKind === 'name' ? [] : [...(report.ownLineIds[report.targetPerson] ?? [])].reverse();
  const form = { ...emptyForm(), verdict: 'fair' as const, actions: [{ ...newDraft('a1', report.targetPerson, rule), what: `${kind}:${length}`, lineIds: own }] };
  const op = decideOp(form, { target: report.targetPerson, reporter: report.reporterPerson!, ...previewLines(report), evidence: report.evidenceKind });
  if (op === null) throw new Error('no op');
  return op;
}

describe('the panel reads like the notice the player gets', () => {
  // Each kind a decision sends, with the lines the test says (a blocked word is starred in both places): the expected text is the fixture, not the notice.
  it.each([
    ['a warning with one line', 'warning', null, ['you are a snerp'], ['you are a snerp']],
    ['a chat restriction with two lines', 'chat', DAY, ['you play like a snerp', 'honestly tarvo'], ['you play like a snerp', 'honestly tarvo']],
    ['an area restriction with no lines', 'area', DAY, [], []],
    ['a permanent ban with a masked line', 'ban', null, ['you are a zorbak'], ['you are a ******']],
    ['a ban with a masked line among plain ones', 'ban', 7 * DAY, ['fine game', 'zorbak is here', 'glarn it'], ['fine game', '****** is here', 'glarn it']],
  ] as const)('%s', async (_name, kind, length, lines, expectedLines) => {
    const w = await playerWorld();
    const { reportId } = await w.sanction(ALICE, kind, { rule: 2, durationMs: length, lines: [...lines] });
    await sameWords(w, reportId, kind, length, expectedLines);
  });

  // The evidence kind is part of the notice: for a report about play or a name the panel and the queue say the same neutral words, and neither shows a line.
  it.each([
    ['a warning for AFK (play)', 'afk', 6, 'how you played'],
    ['a warning about a name', 'name', 7, 'about your name'],
    ['a warning for something that is neither (the reason other)', 'other', 2, 'breaking a community rule'],
  ] as const)('%s', async (_name, reason, rule, words) => {
    const w = await playerWorld();
    const { reportId } = await w.sanction(ALICE, 'warning', { rule, reason, noLines: reason !== 'other', lines: ['you play like a snerp'] });
    await sameWords(w, reportId, 'warning', null, reason === 'other' ? ['you play like a snerp'] : [], rule);
    expect(document.body.textContent).toContain(words);
  });

  async function sameWords(w: Awaited<ReturnType<typeof playerWorld>>, reportId: string, kind: 'warning' | 'chat' | 'area' | 'ban', length: number | null, expectedLines: readonly string[], rule = 2) {
    const real = w.pending(ALICE).find((n) => n.kind === kind);
    expect(real).toBeDefined();
    // The world ticks one second after a decision; the panel is asked at the moment the decision was made.
    w.clock.t -= 1000;
    const op = await opFor(w, reportId, kind, length, rule);
    const { region } = await panelFor(w, op);
    const block = await waitFor(() => {
      const el = region.querySelector('.cw-pv-notice');
      expect(el).not.toBeNull();
      return el as Element;
    });
    const panelText = textOf(block, { title: 'h4', body: '.cw-pv-body', fact: '.cw-pv-fact', line: '.cw-pv-lines li', hint: '.cw-pv-hint' }) as { facts: string[][]; lines: string[][] };
    // The lines are the fixture's, in the report's order, however they were ticked.
    expect(panelText.lines.map((l) => l[1])).toEqual([...expectedLines]);

    const queue = renderUi(<NoticeQueue client={w.client} now={w.now} locale="en" />);
    const dialog = await screen.findByRole('dialog');
    const queueText = textOf(dialog, { title: '.cw-title', body: '.cw-body', fact: '.cw-fact', line: '.cw-lines li', hint: '.cw-hint' }) as { facts: string[][]; lines: string[][] };
    // The reference code is "Made when it is sent" in the panel and the real code in the queue: the one fact that differs, on purpose.
    const withoutRef = (t: { facts: string[][] }) => ({ ...t, facts: t.facts.filter((f) => f[0] !== 'Reference') });
    expect(withoutRef(panelText)).toEqual(withoutRef(queueText));
    expect(panelText.facts.find((f) => f[0] === 'Reference')?.[1]).toBe('Made when it is sent');
    expect(queueText.facts.find((f) => f[0] === 'Reference')?.[1]).toMatch(/\S/);
    queue.unmount();
  }

  // The line a direct chat restriction shows is the line player-react's RestrictedChatLine draws for a moderator's restriction (one shared text, tested to stay one).
  it.each([
    ['with an end', DAY],
    ['with an end that is hours away', 3 * 3_600_000],
    ['with no end', null],
  ] as const)('a direct chat restriction %s: the panel line is the chat box line', async (_name, length) => {
    const w = await playerWorld();
    const { region } = await panelFor(w, { op: 'sanction', kind: 'chat', durationMs: length });
    const drawn = await waitFor(() => {
      const spans = region.querySelectorAll('.cw-pv-chatline > span');
      expect(spans.length).toBeGreaterThan(0);
      return (spans[spans.length - 1] as Element).textContent;
    });
    const real = renderUi(<RestrictedChatLine locale="en" now={w.now} until={length === null ? null : w.now() + length} byModerator />);
    expect(drawn).toBe(real.container.querySelector('.cw-text')?.textContent);
    expect(drawn).toMatch(/^A moderator turned off your chat/);
  });
});

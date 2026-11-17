import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { adminRoutes, createRouter } from '@chatwarden/http/admin';
import type { Role } from '@chatwarden/core';
import { createHubClient } from '../../hub-react/src/client.js';
import { LazyPlayerPreview } from '../../hub-react/src/lazyParts.js';
import { HubProvider } from '../../hub-react/src/provider.js';
import { routerTransport } from '../../hub-react/src/transport.js';
import type { NoticeOp } from '@chatwarden/core/notice-copy';
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

describe('the panel reads like the notice the player gets', () => {
  it.each([
    ['a chat restriction with two lines', 'chat', 'chat' as const, ['you play like a snerp', 'honestly tarvo']],
    ['an area restriction with no lines', 'area', 'area' as const, []],
    ['a permanent ban with a masked line', 'ban', 'ban' as const, ['you are a zorbak']],
  ])('%s', async (_name, _label, kind, lines) => {
    const w = await playerWorld();
    await w.sanction(ALICE, kind, { rule: 2, durationMs: kind === 'ban' ? null : DAY, lines });
    const real = w.pending(ALICE).find((n) => n.kind === kind);
    expect(real).toBeDefined();
    // The panel is asked the same thing the moderator did: the same kind, length, rule and lines (the masked text the server holds).
    const op: NoticeOp = {
      op: 'decide',
      verdict: 'upheld',
      target: 'alice',
      reporter: 'bob',
      actions: [
        {
          person: 'alice',
          kind,
          // The sanction was written one second before the panel is drawn (the world's clock ticks after a decision).
          durationMs: kind === 'ban' ? null : DAY - 1000,
          rule: 2,
          lines: (real?.excerpt ?? []).map((l) => ({ text: l.text, day: l.day })),
        },
      ],
      rename: null,
    };
    const { region } = await panelFor(w, op);
    const block = await waitFor(() => {
      const el = region.querySelector('.cw-pv-notice');
      expect(el).not.toBeNull();
      return el as Element;
    });
    const panelText = textOf(block, { title: 'h4', body: '.cw-pv-body', fact: '.cw-pv-fact', line: '.cw-pv-lines li', hint: '.cw-pv-hint' }) as { facts: string[][] };

    const queue = renderUi(<NoticeQueue client={w.client} now={w.now} locale="en" />);
    const dialog = await screen.findByRole('dialog');
    const queueText = textOf(dialog, { title: '.cw-title', body: '.cw-body', fact: '.cw-fact', line: '.cw-lines li', hint: '.cw-hint' }) as { facts: string[][] };
    // The reference code is "Made when it is sent" in the panel and the real code in the queue: the one fact that differs, on purpose.
    const withoutRef = (t: { facts: string[][] }) => ({ ...t, facts: t.facts.filter((f) => f[0] !== 'Reference') });
    expect(withoutRef(panelText)).toEqual(withoutRef(queueText));
    expect(panelText.facts.find((f) => f[0] === 'Reference')?.[1]).toBe('Made when it is sent');
    expect(queueText.facts.find((f) => f[0] === 'Reference')?.[1]).toMatch(/\S/);
    queue.unmount();
  });
});

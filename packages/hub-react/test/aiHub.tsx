import { act, screen, waitFor, within } from '@testing-library/react';
import { expect } from 'vitest';
import { fakeRead } from '@chatwarden/core';
import type { AIRead, AIReadInput, FakeScript } from '@chatwarden/core';
import { renderHub } from './render.js';
import type { RenderOptions } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, RichLine, WorldOptions } from './world.js';

// Helpers for the AI's tests in the hub: a case with the AI on, over the real routes and the scripted fake, opened in either mode. The
// reported person is the second line's writer ("target"); the fake cites the first line the reported person wrote.

export const TALK: RichLine[] = [
  { who: 'reporter', text: 'hello there' },
  { who: 'target', text: 'you are trash' },
  { who: 'bystander', text: 'what is going on' },
  { who: 'target', text: 'uninstall the game' },
];

/** A read as the fake would give it, with these fields replaced (and the recommendation's severity following unless it is replaced too). */
export const reads = (over: Partial<AIRead> = {}) => (input: AIReadInput): { output: AIRead } => {
  const base = fakeRead(input);
  const severity = over.severity ?? base.severity;
  const recommendation =
    over.recommendation === undefined ? (base.recommendation === null ? null : { ...base.recommendation, severity, ...(over.rule === undefined ? {} : { rule: over.rule }) }) : over.recommendation;
  return { output: { ...base, ...over, severity, recommendation } };
};

export interface AiWorldOptions {
  level?: 0 | 1 | 2;
  script?: FakeScript;
  lines?: RichLine[];
  /** Do not wait for the read to land (a script that hangs, or a test that watches it come). */
  noRead?: boolean;
  world?: Partial<WorldOptions>;
}

export interface AiCaseOptions extends Omit<RenderOptions, 'path'>, AiWorldOptions {}

/** A world with the AI on and one reported case in it (not rendered). */
export async function aiWorld(o: AiWorldOptions = {}) {
  const { level = 1, lines = TALK, noRead = false, world } = o;
  // The fake cites the first rule by default, and rule 1 is one the ladder treats as severe (a 7 day step). At level 2 the cases are about a
  // rule that is not: rule 2, so a rude first offence is a warning, as the ladder says.
  const script = o.script ?? (level === 2 ? reads({ rule: 2 }) : undefined);
  const w = await hubWorld({ actor: 'ann@example.test', ...(level === 0 ? {} : { ai: { level, ...(script === undefined ? {} : { script }) } }), ...(world ?? {}) });
  const f = await w.fileRich({ lines, note: 'Keeps following me.' });
  if (!noRead && level > 0) await w.aiIdle();
  return { w, f };
}

/** A world with the AI on and one reported case in it, rendered. Returns everything the render gives, the world and the report. */
export async function aiCase(o: AiCaseOptions = {}) {
  const { level, script, lines, noRead, world, ...render } = o;
  const { w, f } = await aiWorld({ ...(level === undefined ? {} : { level }), ...(script === undefined ? {} : { script }), ...(lines === undefined ? {} : { lines }), ...(noRead === undefined ? {} : { noRead }), ...(world === undefined ? {} : { world }) });
  const r = await open(w, f.id, render);
  return { w, f, ...r };
}

/** Renders the hub on a case and waits until its decision area is there. */
export async function open(w: HubWorld, id: string, render: Omit<RenderOptions, 'path'> = {}) {
  const mode = render.mode ?? 'detailed';
  const r = renderHub(w, { path: `/reports/${id}`, ...render, mode });
  if (mode === 'simple') await screen.findByRole('region', { name: /^Case against Mallory/ });
  else await within(await screen.findByRole('region', { name: 'Decision' })).findByRole('radio', { name: 'Fair' });
  return r;
}

/** Renders the hub on a case and waits for its heading only (a closed case, or a role that cannot decide, has no decision form to wait for). */
export async function openPlain(w: HubWorld, id: string, render: Omit<RenderOptions, 'path'> = {}) {
  const mode = render.mode ?? 'detailed';
  const r = renderHub(w, { path: `/reports/${id}`, ...render, mode });
  if (mode === 'simple') await screen.findByRole('region', { name: /^Case against Mallory/ });
  else await screen.findByRole('heading', { level: 2, name: /report against/ });
  return r;
}

/** The AI strip, once it has come in. */
export const strip = (): Promise<HTMLElement> => screen.findByRole('region', { name: 'AI read' });
export const noStrip = (): HTMLElement | null => screen.queryByRole('region', { name: 'AI read' });

/** Waits for a number of GET /reports/:id requests (the page, and the polls that follow it). */
export const pageReads = (w: HubWorld, id: string): number => w.sent.filter((r) => r.method === 'GET' && r.path === `/reports/${id}`).length;

export const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function untilGone(el: () => HTMLElement | null): Promise<void> {
  await waitFor(() => expect(el()).toBeNull());
}

// ---- Level 2 ---------------------------------------------------------------------------------------------------------------------

export const decision = (): HTMLElement => screen.getByRole('region', { name: 'Decision' });
/** The pre-fill bar's header, once it has come in. */
export const aiBar = (): Promise<HTMLElement> => screen.findByRole('group', { name: 'AI suggestion' });
export const noAiBar = (): HTMLElement | null => screen.queryByRole('group', { name: 'AI suggestion' });

type Mutable = { ai: { recommendation: { verdict: string; step: unknown; stepWithinCeiling: boolean; evidenceLineIds: string[]; rule: unknown; severity: string } | null; stale: boolean; id: string } };

/**
 * Makes the server's answer for the case page say something else about the AI's read (a step the real ladder would not give, a read made
 * stale), so the hub's own checks can be shown holding against a wire that is wrong. Everything else is the real route.
 */
export function rewrite(w: HubWorld, id: string, change: (body: Mutable) => void): void {
  w.intercept.fn = async (req) => {
    if (req.method !== 'GET' || req.path !== `/reports/${id}`) return undefined;
    const res = await w.raw({ method: 'GET', path: req.path });
    const body = JSON.parse(JSON.stringify(res.body)) as Mutable;
    change(body);
    return { ...res, body };
  };
}

export const isDecide = (r: { method: string; path: string }): boolean => r.method === 'POST' && /^\/reports\/[^/]+\/decide$/.test(r.path);
export const decides = (w: HubWorld) => w.sent.filter(isDecide);
export const lastDecide = (w: HubWorld) => decides(w).at(-1)?.body as Record<string, unknown> | undefined;

/** Lets a held decision go on the spot (the page hides: a held decision is sent). */
export async function flushHold(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new Event('pagehide'));
    await Promise.resolve();
  });
}

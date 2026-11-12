import { screen, waitFor, within } from '@testing-library/react';
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
  const recommendation = over.recommendation === undefined ? (base.recommendation === null ? null : { ...base.recommendation, severity }) : over.recommendation;
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
  const { level = 1, script, lines = TALK, noRead = false, world } = o;
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

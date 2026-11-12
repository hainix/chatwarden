import type { PaceSettings } from '@chatwarden/core';
import type { Problems } from './panels.js';

// The draft of the "Slow mode and flooding" panel: what the owner types (seconds, as text), what it means in the kit's own units (milliseconds), and the
// checks the kit makes again on its side. Pure: nothing here reads the page or sends anything.

export interface PaceDraft {
  slow: boolean;
  slowSec: string;
  burst: boolean;
  burstLines: string;
  burstSec: string;
  dup: boolean;
  dupSec: string;
}

/** The kit's ranges (core `pace.ts`): milliseconds for slow mode, messages and milliseconds for a burst, milliseconds for repeats. */
const SLOW_MS = [500, 600_000] as const;
const LINES = [2, 100] as const;
const WINDOW_MS = [1000, 600_000] as const;
const DUP_MS = [1000, 3_600_000] as const;

/** The built-in chat limit the pacer sits behind, when the server does not say (an older one): 3 messages per 5 seconds per player and room. */
export const BUILTIN_RATE = { lines: 3, windowMs: 5000 } as const;

/** The chat rate in force, from what the server reports (`limits.chatRate`), else the kit's default. */
export function builtinRate(limits: { chatRate?: { count: number; windowMs: number } } | undefined): { lines: number; windowMs: number } {
  const r = limits?.chatRate;
  return r !== undefined && Number.isFinite(r.count) && r.count >= 1 && Number.isFinite(r.windowMs) && r.windowMs >= 1 ? { lines: r.count, windowMs: r.windowMs } : BUILTIN_RATE;
}

/** What the kit reports in force (`effective.pace`), with every field filled and null meaning off; an older server sends none: all off. */
type Pace = Partial<{ slowModeMs: number | null; burst: { lines: number; windowMs: number } | null; duplicateWindowMs: number | null }> | undefined;

const text = (ms: number): string => String(Math.round(ms) / 1000);

export const paceDraftOf = (p: Pace): PaceDraft => ({
  slow: typeof p?.slowModeMs === 'number',
  slowSec: typeof p?.slowModeMs === 'number' ? text(p.slowModeMs) : '',
  burst: p?.burst != null,
  burstLines: p?.burst != null ? String(p.burst.lines) : '',
  burstSec: p?.burst != null ? text(p.burst.windowMs) : '',
  dup: typeof p?.duplicateWindowMs === 'number',
  dupSec: typeof p?.duplicateWindowMs === 'number' ? text(p.duplicateWindowMs) : '',
});

/** A number the owner typed: plain digits with an optional decimal part; anything else (empty, `1e3`, `-2`, `3 s`) is not a number. */
const numberOf = (s: string): number | null => (/^\d+(\.\d+)?$/.test(s.trim()) ? Number(s.trim()) : null);

const ms = (s: string): number | null => {
  const n = numberOf(s);
  return n === null ? null : Math.round(n * 1000);
};
const within = (v: number | null, [lo, hi]: readonly [number, number]): v is number => v !== null && Number.isFinite(v) && v >= lo && v <= hi;

type PaceKey = 'hub.settings.pace.error.slow' | 'hub.settings.pace.error.lines' | 'hub.settings.pace.error.window' | 'hub.settings.pace.error.repeat';

/** A problem with the range it was checked against, as text (so a thousand separator never splits 3600), from the same constants as the check. */
const ranged = (key: PaceKey, [lo, hi]: readonly [number, number], inSeconds: boolean): { key: PaceKey; params: { min: string; max: string } } => ({
  key,
  params: inSeconds ? { min: String(lo / 1000), max: String(hi / 1000) } : { min: String(lo), max: String(hi) },
});

/** The fields that cannot be sent, by the field's key; nothing for a switched-off row. */
export function paceProblems(d: PaceDraft): Problems {
  const out: Record<string, ReturnType<typeof ranged>> = {};
  if (d.slow && !within(ms(d.slowSec), SLOW_MS)) out['slowSec'] = ranged('hub.settings.pace.error.slow', SLOW_MS, true);
  if (d.burst) {
    const lines = numberOf(d.burstLines);
    if (lines === null || !Number.isInteger(lines) || !within(lines, LINES)) out['burstLines'] = ranged('hub.settings.pace.error.lines', LINES, false);
    if (!within(ms(d.burstSec), WINDOW_MS)) out['burstSec'] = ranged('hub.settings.pace.error.window', WINDOW_MS, true);
  }
  if (d.dup && !within(ms(d.dupSec), DUP_MS)) out['dupSec'] = ranged('hub.settings.pace.error.repeat', DUP_MS, true);
  return out;
}

/**
 * The pace section to save: every field named, `null` for off, so a setting the owner turned off stays off whatever the code says. Only for a draft
 * with no problems.
 */
export function paceLayer(d: PaceDraft): PaceSettings {
  return {
    slowModeMs: d.slow ? (ms(d.slowSec) as number) : null,
    burst: d.burst ? { lines: Number(d.burstLines.trim()), windowMs: ms(d.burstSec) as number } : null,
    duplicateWindowMs: d.dup ? (ms(d.dupSec) as number) : null,
  };
}

/** A draft with what a switched-off row holds left out, so two drafts that mean the same compare equal. */
const meaning = (d: PaceDraft): unknown => [d.slow ? d.slowSec.trim() : null, d.burst ? [d.burstLines.trim(), d.burstSec.trim()] : null, d.dup ? d.dupSec.trim() : null];

/** Is the draft different from what is in force? */
export const paceDirty = (d: PaceDraft, effective: Pace): boolean => JSON.stringify(meaning(d)) !== JSON.stringify(meaning(paceDraftOf(effective)));

/** The field a refusal's layer path names, as the draft's key; null for a path that is not one of the fields. */
export function paceFieldKey(path: string): string | null {
  if (path === 'layer.pace.slowModeMs') return 'slowSec';
  if (path === 'layer.pace.burst' || path === 'layer.pace.burst.lines') return 'burstLines';
  if (path === 'layer.pace.burst.windowMs') return 'burstSec';
  if (path === 'layer.pace.duplicateWindowMs') return 'dupSec';
  return null;
}

/** Is the burst the owner typed looser than the built-in limit (so that limit answers first and the burst limit rarely does)? */
export function burstLooserThanBuiltin(d: PaceDraft, rate: { lines: number; windowMs: number } = BUILTIN_RATE): boolean {
  if (!d.burst) return false;
  const lines = numberOf(d.burstLines);
  const window = ms(d.burstSec);
  return lines !== null && window !== null && window > 0 && lines * rate.windowMs > rate.lines * window;
}

/** The suggested values for a preset, as a draft: only what the preset suggests is switched on. */
export function suggestedDraft(p: { slowModeMs: number | null; burst: { lines: number; windowMs: number } | null; duplicateWindowMs: number | null }): PaceDraft {
  return paceDraftOf(p);
}

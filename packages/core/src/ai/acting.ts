import { AUDIT_REASON_MAX, isValidAuditActor } from '../audit.js';
import type { Clock } from '../types.js';

// The acting state (design 3 rulings 1, 12, 13 and 16, and 6.3): AI level 3 is two audited steps by the owner, shadow and then acting, held apart from the
// policy layer so the hub's generic "save the profile" cannot turn it on. This file is the pure part (`planActing`: facts in, the next row or a code
// out) and the facade (`cw.ai.acting`) that gathers the facts, makes the one conditional write and answers. The route checks WHO may ask; nothing here
// knows a role. In this release (the shadow release) nothing that acting can lead to writes a sanction: `on` records what the AI would have done.

/** The typed word that confirms a step that widens what the AI does. Exactly this, in this case. */
export const ACT_WORD = 'ACT';

/** The days of shadow before acting may start: its default and its band (design 5.4). */
export const AI_SHADOW_DAYS_DEFAULT = 14;
export const AI_SHADOW_DAYS_BAND: Readonly<{ min: number; max: number }> = Object.freeze({ min: 7, max: 60 });

const DAY_MS = 86_400_000;

/**
 * Where acting stands: `off`, `shadow` (every step runs and records "would have acted", nothing is written to a player) or `on`.
 * @experimental
 */
export type AiActingMode = 'off' | 'shadow' | 'on';

/**
 * The one stored row, as the store keeps it.
 * @experimental
 */
export interface AiActingRow {
  mode: AiActingMode;
  modeSince: number | null;
  /** The staff ref that took the mode step; audit-class, never returned to a player. */
  modeBy: string | null;
  paused: boolean;
  pausedSince: number | null;
  pausedBy: string | null;
}

/**
 * What the hub shows (`GET /ai/acting`): numbers, words and booleans, no staff ref.
 * @experimental
 */
export interface AiActingState {
  mode: AiActingMode;
  paused: boolean;
  modeSince: number | null;
  /** Whole days since shadow began; 0 outside shadow. */
  shadowDaysDone: number;
  /** How many reports shadow recorded as "would have acted" since it began; 0 outside shadow. */
  shadowWouldHaveActed: number;
  /** The code's ceiling (`ai.maxLevel`). */
  maxLevel: 0 | 1 | 2 | 3 | 4;
}

/**
 * Why a step was refused. `invalid` is a wrong word, a missing reason or a bad actor; `unsupported` the code, the adapter or the store cannot do
 * acting; `no_appeals` appeals are not enabled; `not_allowed` the hub's AI level is below 2; `too_early` shadow has not run its days;
 * `wrong_state` the state is not one this step starts from.
 * @experimental
 */
export type AiActingError = 'invalid' | 'unsupported' | 'no_appeals' | 'not_allowed' | 'too_early' | 'wrong_state';
/** @experimental */
export type AiActingResult = { ok: true; state: AiActingState } | { ok: false; error: AiActingError };

/** What a step is given. Read as `unknown`: it comes from a route. */
export interface ActingInput {
  actor?: unknown;
  confirm?: unknown;
  reason?: unknown;
}

/** The facts a step depends on, gathered by the facade at the moment of use. */
export interface ActingContext {
  now: number;
  /** The hub's AI level (`profile.ai.level`), 0 to 2. */
  level: number;
  /** The code's ceiling (`ai.maxLevel`). */
  maxLevel: number;
  /** `ai.act` is given and `enabled` is not false. */
  actEnabled: boolean;
  adapter: boolean;
  /** The store has the acting state methods. */
  storeSupported: boolean;
  appealsEnabled: boolean;
  shadowDays: number;
}

export type ActingStep = 'shadow' | 'start' | 'pause' | 'resume' | 'off';
const STEPS: readonly string[] = ['shadow', 'start', 'pause', 'resume', 'off'];

const refuse = (error: AiActingError): { ok: false; error: AiActingError } => ({ ok: false, error });

/**
 * Plan one step: the next row, or the code that refuses it. Pure; the row it is given is not changed. Order of refusals: an unknown step or input,
 * a state the step does not start from, the actor, the reason and the word, then what acting needs (the code, the level, appeals) and last the shadow
 * days. Raising the AI's reach (`shadow` from off, `start`) needs the word `ACT`, everything it needs and, for `start`, the days; lowering it
 * (`off`, `shadow` from on) and `pause` and `resume` need a reason only and no prerequisite, since the code or appeals may be gone by then.
 */
export function planActing(step: ActingStep, row: AiActingRow, input: ActingInput, ctx: ActingContext): { ok: true; next: AiActingRow } | { ok: false; error: AiActingError } {
  if (typeof step !== 'string' || !STEPS.includes(step) || typeof input !== 'object' || input === null) return refuse('invalid');
  // 1. Is the state one this step starts from?
  const from = row.mode;
  const raises = (step === 'shadow' && from === 'off') || (step === 'start' && from === 'shadow');
  const ok =
    step === 'shadow' ? from === 'off' || from === 'on'
    : step === 'start' ? from === 'shadow'
    : step === 'pause' ? from !== 'off' && !row.paused
    : step === 'resume' ? row.paused
    : from !== 'off';
  if (!ok) return refuse('wrong_state');
  // 2. The actor, the reason and (for a step that raises) the word.
  const actor: unknown = input.actor;
  if (!isValidAuditActor(actor)) return refuse('invalid');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason === '' || reason.length > AUDIT_REASON_MAX) return refuse('invalid');
  if (raises && input.confirm !== ACT_WORD) return refuse('invalid');
  // 3. What acting needs.
  if (raises) {
    if (!ctx.adapter || !ctx.actEnabled || ctx.maxLevel < 3 || !ctx.storeSupported) return refuse('unsupported');
    if (ctx.level < 2) return refuse('not_allowed');
    if (!ctx.appealsEnabled) return refuse('no_appeals');
    if (step === 'start' && !(typeof row.modeSince === 'number' && ctx.now - row.modeSince >= ctx.shadowDays * DAY_MS)) return refuse('too_early');
  }
  const now = ctx.now;
  switch (step) {
    case 'shadow':
      return { ok: true, next: { ...row, mode: 'shadow', modeSince: now, modeBy: actor } };
    case 'start':
      return { ok: true, next: { ...row, mode: 'on', modeSince: now, modeBy: actor } };
    case 'off':
      return { ok: true, next: { mode: 'off', modeSince: now, modeBy: actor, paused: false, pausedSince: null, pausedBy: null } };
    case 'pause':
      return { ok: true, next: { ...row, paused: true, pausedSince: now, pausedBy: actor } };
    default:
      return { ok: true, next: { ...row, paused: false, pausedSince: null, pausedBy: null } };
  }
}

/**
 * `cw.ai.acting`. Every method answers a result and never throws on a bad input; a store that fails is thrown as its own. The role is not known here:
 * the route lets the owner start, stop and resume and a senior pause.
 * @experimental
 */
export interface AiActingFacade {
  /** The state now, read from the store at every call (never cached, so a pause is seen by the very next act). `off` when the code pins it off. */
  state(): AiActingState;
  /** Owner. Off to shadow (the word `ACT`, a reason; needs level 2, `maxLevel` 3 or more, an adapter and enabled appeals) or on to shadow (a reason). */
  startShadow(actor: string, input: { confirm?: string; reason: string }): AiActingResult;
  /** Owner. Shadow to on, once shadow has run `shadowDays` (the word `ACT`, a reason). */
  startActing(actor: string, input: { confirm: string; reason: string }): AiActingResult;
  /** A senior or the owner. Takes effect before the next act. */
  pause(actor: string, input: { reason: string }): AiActingResult;
  /** Owner. */
  resume(actor: string, input: { reason: string }): AiActingResult;
  /** Owner. */
  off(actor: string, input: { reason: string }): AiActingResult;
}

/** The store methods the acting facade needs (a view of the AI store). */
export interface ActingStore {
  aiActingState?(): AiActingRow;
  setAiActingState?(expect: { mode: AiActingMode; paused: boolean }, next: AiActingRow): boolean;
}

/** What the acting facade needs of the kit. */
export interface ActingDeps {
  store: ActingStore;
  clock: Clock;
  /** The hub's level now (`profile.ai.level`). */
  level: () => number;
  maxLevel: 0 | 1 | 2 | 3 | 4;
  /** `ai.act` is given and not disabled. False pins the state to `off`. */
  actEnabled: boolean;
  adapter: boolean;
  appealsEnabled: () => boolean;
  shadowDays: number;
  /** How many reports shadow recorded as "would have acted" at or after `since`. */
  shadowCount: (since: number) => number;
}

const OFF_ROW: Readonly<AiActingRow> = Object.freeze({ mode: 'off', modeSince: null, modeBy: null, paused: false, pausedSince: null, pausedBy: null });

/** @internal */
export function createActing(deps: ActingDeps): AiActingFacade {
  const supported = (): boolean => typeof deps.store.aiActingState === 'function' && typeof deps.store.setAiActingState === 'function';
  // The code pins acting off (`ai.act.enabled: false`, or no `ai.act`): whatever the store says, nothing acts.
  const row = (): AiActingRow => (!deps.actEnabled || deps.maxLevel < 3 || !supported() ? { ...OFF_ROW } : { ...(deps.store.aiActingState as () => AiActingRow)() });
  const view = (r: AiActingRow): AiActingState => {
    const inShadow = r.mode === 'shadow' && r.modeSince !== null;
    const now = deps.clock.now();
    return {
      mode: r.mode,
      paused: r.paused,
      modeSince: r.modeSince,
      shadowDaysDone: inShadow ? Math.max(0, Math.floor((now - (r.modeSince as number)) / DAY_MS)) : 0,
      shadowWouldHaveActed: inShadow ? deps.shadowCount(r.modeSince as number) : 0,
      maxLevel: deps.maxLevel,
    };
  };
  const step = (kind: ActingStep, actor: string, input: { confirm?: unknown; reason?: unknown }): AiActingResult => {
    // The code pins acting off (or the store cannot keep the state): there is nothing to start, pause or lower, so every step says so.
    if (!deps.actEnabled || deps.maxLevel < 3 || !supported()) return refuse('unsupported');
    const current = row();
    const ctx: ActingContext = {
      now: deps.clock.now(),
      level: deps.level(),
      maxLevel: deps.maxLevel,
      actEnabled: deps.actEnabled,
      adapter: deps.adapter,
      storeSupported: supported(),
      appealsEnabled: deps.appealsEnabled(),
      shadowDays: deps.shadowDays,
    };
    const plan = planActing(kind, current, { actor, confirm: input?.confirm, reason: input?.reason }, ctx);
    if (!plan.ok) return plan;
    // One conditional write: a second process that read the same state changes nothing and is told so.
    const moved = (deps.store.setAiActingState as NonNullable<ActingStore['setAiActingState']>)({ mode: current.mode, paused: current.paused }, plan.next);
    return moved ? { ok: true, state: view(plan.next) } : refuse('wrong_state');
  };
  return {
    state: () => view(row()),
    startShadow: (actor, input) => step('shadow', actor, input),
    startActing: (actor, input) => step('start', actor, input),
    pause: (actor, input) => step('pause', actor, input),
    resume: (actor, input) => step('resume', actor, input),
    off: (actor, input) => step('off', actor, input),
  };
}

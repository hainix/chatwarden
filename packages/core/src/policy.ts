import { isValidAuditActor, AUDIT_REASON_MAX } from './audit.js';
import { suggest } from './ladder.js';
import type { ActionRecord } from './ladder.js';
import { applyPolicyLayer, changedSections, frozenCopy, layerSections, POLICY_SECTIONS, ProfileError } from './profile.js';
import type { PolicyLayer, PolicySection, ResolvedProfile } from './profile.js';
import { playerReporting } from './reporting.js';
import type { PlayerReporting } from './reporting.js';
import type { RuleRef } from './rules.js';
import { errorClass, safeWarn } from './log.js';
import { RETENTION_DEFAULTS } from './retention.js';
import { checkSignalFeeds, pruneSignalFeeds, SIGNAL_FEED_NAMES } from './signals.js';
import type { SignalDropReason } from './signals.js';
import { retryBusy } from './team.js';
import { CONDUCT_LEVELS } from './types.js';
import type { Clock, ConductLevel, Logger, Store } from './types.js';

/**
 * The editable moderation profile at runtime. The profile given in code (a preset plus `overrides`) is the BASE. A moderator's
 * edits are stored in the adopter's own store as a versioned {@link PolicyLayer}; the EFFECTIVE profile is the base with that
 * layer merged on top, validated. Every consumer in the kit reads {@link PolicyService.profileNow} at call time, so a save is
 * seen by the very next suggestion, document or check, and a change another process saved is seen within
 * {@link POLICY_REFRESH_MS}. A stored layer the kit cannot use is ignored (the base stays in force) and reported, never thrown.
 */

/** How often a read may look at the store for a newer version: 10 seconds. */
export const POLICY_REFRESH_MS = 10_000;

/**
 * A stored signal feed that was dropped when the layer was read: the feed (`record`, `queue`, `ladder`, `ai`, or `unknown` for a name the kit
 * does not have) and why. A code only: never a kind id, a rule id, a label or a number from the stored layer.
 * @experimental
 */
export interface PolicyDropped {
  feed: string;
  reason: SignalDropReason;
}

/** What {@link PolicyService.get} answers. */
export interface PolicyState {
  /** The profile in force: base, then the stored layer. Deep-frozen. */
  effective: ResolvedProfile;
  /** The profile from code (preset and overrides), without the stored layer. Deep-frozen. */
  base: ResolvedProfile;
  /**
   * The layer in force, as last read (`{}` when none), deep-frozen: the stored layer with any signal feed that could no longer be used
   * taken out (see `dropped`). Send it back to `save` and the save is accepted, and repairs the stored row.
   */
  layer: PolicyLayer;
  /** The stored layer's version; 0 when nothing was ever saved. Pass it back to `save`. */
  version: number;
  /** True when the store has the policy methods, so `save` and `reset` can work. */
  canSave: boolean;
  /**
   * Present when the stored layer could not be used: it is ignored and `effective` is `base`. `path` names the field (`layer`
   * itself for one that is not an object). `kind` is `'unreadable'` when the stored text could not be read at all (corrupted, not
   * JSON, not an object): the owner's edits are gone until they save again; `'invalid'` when it was read but a setting is not
   * valid (a newer kit's field, a hand edit). Either way a save or a full `reset()` repairs it.
   */
  layerError?: { path: string; kind: 'unreadable' | 'invalid' };
  /**
   * Present only when the stored layer held signal feeds that could no longer be used (the code stopped declaring their kind, or a
   * window is longer than the retention now allows) and were left out of `layer` and of what is in force. One entry per feed, with the
   * reason of the first thing lost from it. The stored row itself is rewritten by the next save.
   * @experimental
   */
  dropped?: readonly PolicyDropped[];
}

/** What {@link PolicyService.save} and {@link PolicyService.reset} answer. */
export type PolicySaveResult =
  | { ok: true; version: number; /** The editable sections whose stored value changed. */ changed: PolicySection[] }
  | { ok: false; error: 'conflict' | 'unsupported' }
  | { ok: false; error: 'invalid'; path: string };

/** Who saved, and why. `actor` and `reason` are checked here; the routes record them in the audit trail. */
export interface PolicySaveContext {
  /** The stored layer's version the editor started from (`get().version`). */
  version: number;
  actor: string;
  reason: string;
}

/** The four fixed sample records a preview is computed for. */
export const PREVIEW_SAMPLES = ['clean', 'oneWarning', 'chat24h', 'ban7d'] as const;
export type PreviewSample = (typeof PREVIEW_SAMPLES)[number];

/** One suggested outcome in a preview. `durationMs` is null for permanent and for an outcome with no length. */
export interface PreviewOutcome {
  label: string;
  kind: 'none' | 'note' | 'warning' | 'chat' | 'area' | 'ban';
  durationMs: number | null;
}

/** What {@link PolicyService.preview} answers: for each sample and each conduct level, what would be suggested. */
export type PolicyPreview =
  | { ok: true; samples: Record<PreviewSample, Record<ConductLevel, PreviewOutcome>>; /** What players would read of the candidate's reporting settings (the enabled reasons, the flow and the thank-you). */ reporting: PlayerReporting }
  | { ok: false; error: 'invalid'; path: string };

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The records behind the samples, as of `now`: a clean record, one warning, a 24 hour chat restriction, a 7 day ban. */
function sampleRecords(now: number): Record<PreviewSample, ActionRecord[]> {
  const one = (kind: ActionRecord['kind'], durationMs: number | null): ActionRecord[] => [
    { kind, durationMs, startsAt: now - HOUR_MS, revoked: false, automated: false, roomId: null },
  ];
  return { clean: [], oneWarning: one('warning', null), chat24h: one('chat', DAY_MS), ban7d: one('ban', 7 * DAY_MS) };
}

const isRuleRef = (v: unknown): v is RuleRef => v === 'uncovered' || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1);

export class PolicyService {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly logger: Logger | undefined;
  private readonly base: ResolvedProfile;
  private state: { effective: ResolvedProfile; layer: PolicyLayer; version: number; layerError?: PolicyState['layerError']; dropped?: readonly PolicyDropped[] };
  /** When the store was last looked at (epoch ms), or null before the first read. */
  private lastCheck: number | null = null;

  /** How long signal rows are kept, ms: a feed window longer than this could never be met. */
  private readonly signalsMs: () => number;

  constructor(deps: { store: Store; clock: Clock; logger: Logger | undefined; base: ResolvedProfile; signalsMs?: () => number }) {
    this.signalsMs = deps.signalsMs ?? (() => RETENTION_DEFAULTS.signalsMs);
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.base = deps.base;
    this.state = { effective: applyPolicyLayer(deps.base, {}), layer: frozenCopy({}), version: 0 };
  }

  private get supported(): boolean {
    return typeof this.store.loadPolicyLayer === 'function' && typeof this.store.savePolicyLayer === 'function';
  }

  /** Read the stored layer once, at creation. A store failure here is the caller's (like every other load). */
  load(): void {
    if (!this.supported) return;
    this.lastCheck = this.clock.now();
    this.adopt(this.store.loadPolicyLayer?.() ?? null);
  }

  /** Make `stored` the layer in force: the effective profile is rebuilt, or the base kept when the layer cannot be used. */
  private adopt(stored: { layer: PolicyLayer; version: number } | null): void {
    const version = stored?.version ?? 0;
    // A row the store could not read as a layer arrives as null (or any non-object): it is a layerError like any unusable layer.
    const raw: unknown = stored === null ? {} : stored.layer;
    const layer = frozenCopy(raw as PolicyLayer);
    try {
      // What is read and shown is the layer in force: the stale feeds are out of it, so a save that sends it back is never refused for them.
      const { layer: inForce, dropped } = this.withoutStaleFeeds(layer);
      const shown = dropped.length === 0 ? layer : frozenCopy(inForce);
      this.state = { effective: applyPolicyLayer(this.base, shown), layer: shown, version, ...(dropped.length === 0 ? {} : { dropped: Object.freeze(dropped.map((d) => Object.freeze(d))) }) };
    } catch (err) {
      if (!(err instanceof ProfileError)) throw err;
      // What `get()` shows is always an object: an unreadable layer reads as empty, with the error beside it.
      const shown = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? layer : frozenCopy({});
      const kind = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? 'invalid' : 'unreadable';
      this.state = { effective: this.base, layer: shown, version, layerError: { path: err.path, kind } };
      // Once per version: `adopt` runs only when the stored version changed (or at start-up), never on a plain re-read.
      safeWarn(this.logger, 'chatwarden.policy_layer_invalid', { version, path: err.path });
    }
  }

  /**
   * The stored layer with any signal feed that can no longer be used taken out (it names a kind the code stopped declaring, or a window
   * longer than the retention now allows), and what was taken out. Without this one stale feed would make the whole layer unusable and
   * silently drop the owner's other edits too. Logged by feed name only. Anything else wrong with the layer is left for
   * `applyPolicyLayer` to refuse; a layer with nothing to drop comes back as it is.
   */
  private withoutStaleFeeds(layer: PolicyLayer): { layer: PolicyLayer; dropped: PolicyDropped[] } {
    const dropped: PolicyDropped[] = [];
    const signals: unknown = typeof layer === 'object' && layer !== null && !Array.isArray(layer) ? (layer as { signals?: unknown }).signals : undefined;
    const feeds: unknown = typeof signals === 'object' && signals !== null && !Array.isArray(signals) ? (signals as { feeds?: unknown }).feeds : undefined;
    if (typeof feeds !== 'object' || feeds === null || Array.isArray(feeds)) return { layer, dropped };
    const pruned = pruneSignalFeeds(feeds, this.base.signals.kinds, {
      signalsMs: this.signalsMs(),
      onDrop: (name, reason) => {
        const feed = SIGNAL_FEED_NAMES.includes(name) ? name : 'unknown';
        safeWarn(this.logger, 'chatwarden.signal_feed_dropped', { feed });
        dropped.push({ feed, reason });
      },
    });
    return { layer: dropped.length === 0 ? layer : ({ ...layer, signals: { ...(signals as object), feeds: pruned } } as PolicyLayer), dropped };
  }

  /** Look at the store now and adopt a strictly newer version (an older one, say a restored backup, never regresses what is in force). A store failure throws. */
  private reload(): void {
    const stored = this.store.loadPolicyLayer?.() ?? null;
    if ((stored?.version ?? 0) > this.state.version) this.adopt(stored);
  }

  /** The cheap check every read does: at most one store look per {@link POLICY_REFRESH_MS}; a failure keeps what is in force. */
  private maybeRefresh(): void {
    if (!this.supported) return;
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      return;
    }
    // A clock that went backwards is not "recent": look again.
    if (this.lastCheck !== null && now >= this.lastCheck && now - this.lastCheck < POLICY_REFRESH_MS) return;
    this.lastCheck = now;
    try {
      this.reload();
    } catch (err) {
      safeWarn(this.logger, 'chatwarden.policy_refresh_failed', { error: errorClass(err) });
    }
  }

  /** The profile in force right now. Every consumer calls this, at call time, and never keeps the result. */
  profileNow(): ResolvedProfile {
    this.maybeRefresh();
    return this.state.effective;
  }

  get(): PolicyState {
    this.maybeRefresh();
    const { effective, layer, version, layerError, dropped } = this.state;
    return {
      effective,
      base: this.base,
      layer,
      version,
      canSave: this.supported,
      ...(layerError === undefined ? {} : { layerError: { ...layerError } }),
      ...(dropped === undefined ? {} : { dropped }),
    };
  }

  /** Look at the store now, whatever the interval. A store failure throws. */
  refresh(): void {
    if (!this.supported) return;
    this.lastCheck = this.clock.now();
    this.reload();
  }

  private persist(layer: PolicyLayer, expected: number): PolicySaveResult {
    // What this save changes is judged against the layer at `expected`: ours when we are current, else read it.
    const before = this.state.version === expected ? this.state.layer : (this.store.loadPolicyLayer?.()?.layer ?? {});
    // One conditional write; when another process holds the database lock past the busy timeout it is tried again (as a claim is).
    const next = retryBusy(() => this.store.savePolicyLayer?.(layer, expected) ?? null);
    if (next === null) {
      try {
        this.refresh();
      } catch (err) {
        safeWarn(this.logger, 'chatwarden.policy_refresh_failed', { error: errorClass(err) });
      }
      return { ok: false, error: 'conflict' };
    }
    const changed = changedSections(before, layer);
    this.lastCheck = this.clock.now();
    this.adopt({ layer, version: next });
    return { ok: true, version: next, changed };
  }

  /**
   * Replace the stored layer. `layer` is the WHOLE layer wanted: a section left out goes back to the base. Checked in this
   * order: the store must support it (`unsupported`), `version`, `actor` and `reason` (`invalid`, path `version`, `actor` or
   * `reason`), then the layer itself (`invalid`, with a `layer...` path; a setting outside the editable sections, such as
   * `profanity`, is refused). A `version` that is no longer the stored one is `conflict`, and nothing is written. On success
   * the effective profile changes at once, in this process.
   */
  save(layer: PolicyLayer, ctx: PolicySaveContext): PolicySaveResult {
    if (!this.supported) return { ok: false, error: 'unsupported' };
    if (typeof ctx !== 'object' || ctx === null) return { ok: false, error: 'invalid', path: 'version' };
    if (!Number.isSafeInteger(ctx.version) || ctx.version < 0) return { ok: false, error: 'invalid', path: 'version' };
    if (!isValidAuditActor(ctx.actor)) return { ok: false, error: 'invalid', path: 'actor' };
    if (typeof ctx.reason !== 'string' || ctx.reason.trim() === '' || ctx.reason.trim().length > AUDIT_REASON_MAX) {
      return { ok: false, error: 'invalid', path: 'reason' };
    }
    try {
      const effective = applyPolicyLayer(this.base, layer);
      // The windows are checked against the retention here, where it is known: a window longer than it could never be met.
      checkSignalFeeds(effective.signals.feeds, effective.signals.kinds, { signalsMs: this.signalsMs() }, 'layer.signals.feeds');
    } catch (err) {
      if (err instanceof ProfileError) return { ok: false, error: 'invalid', path: err.path };
      throw err;
    }
    // Stored as plain JSON: exactly the sections given, nothing that is not data.
    const clean = JSON.parse(JSON.stringify(layer)) as PolicyLayer;
    return this.persist(clean, ctx.version);
  }

  /**
   * Put one editable section (or, with no section, every section) back to the base, by storing the layer without it. It starts
   * from the latest stored layer, so a reset never undoes another process's unrelated edit. With `version` it must still be
   * the stored one (`conflict` otherwise). Nothing to reset is a no-op that writes nothing (`changed: []`).
   */
  reset(section?: PolicySection, o: { version?: number } = {}): PolicySaveResult {
    if (!this.supported) return { ok: false, error: 'unsupported' };
    if (section !== undefined && !(POLICY_SECTIONS as readonly string[]).includes(section)) return { ok: false, error: 'invalid', path: 'section' };
    if (o.version !== undefined && (!Number.isSafeInteger(o.version) || o.version < 0)) return { ok: false, error: 'invalid', path: 'version' };
    this.refresh();
    if (o.version !== undefined && o.version !== this.state.version) return { ok: false, error: 'conflict' };
    const { layer, version, layerError } = this.state;
    let next: PolicyLayer = {};
    if (section !== undefined) {
      next = { ...layer };
      delete next[section];
      if (layerError !== undefined) {
        // A layer we cannot use may need more than this section gone: it must still be valid, or it is the full reset's job.
        try {
          applyPolicyLayer(this.base, next);
        } catch (err) {
          if (err instanceof ProfileError) return { ok: false, error: 'invalid', path: err.path };
          throw err;
        }
      }
    }
    const touches = section === undefined ? layerSections(layer).length > 0 : Object.hasOwn(layer, section);
    if (!touches && layerError === undefined) return { ok: true, version, changed: [] };
    return this.persist(JSON.parse(JSON.stringify(next)) as PolicyLayer, version);
  }

  /**
   * What would be suggested under the candidate `layer` (the whole layer, applied over the base, exactly as a save would
   * store it), for four fixed sample records and each conduct level, without saving anything or reading the store. `rule`
   * (default `'uncovered'`) is the Community Rule the sample incident cites: pass a rule from `areaRules` or `severeRules` to
   * see those rules take effect.
   */
  preview(layer: PolicyLayer, rule: RuleRef = 'uncovered'): PolicyPreview {
    if (!isRuleRef(rule)) return { ok: false, error: 'invalid', path: 'rule' };
    let candidate: ResolvedProfile;
    try {
      candidate = applyPolicyLayer(this.base, layer);
    } catch (err) {
      if (err instanceof ProfileError) return { ok: false, error: 'invalid', path: err.path };
      throw err;
    }
    const now = this.clock.now();
    const records = sampleRecords(now);
    const samples = {} as Record<PreviewSample, Record<ConductLevel, PreviewOutcome>>;
    for (const sample of PREVIEW_SAMPLES) {
      const levels = {} as Record<ConductLevel, PreviewOutcome>;
      for (const level of CONDUCT_LEVELS) {
        const s = suggest(candidate, records[sample], level, rule, now);
        const o = s.outcome;
        levels[level] =
          typeof o === 'string'
            ? { label: s.label, kind: o, durationMs: null }
            : { label: s.label, kind: o.kind, durationMs: o.durationMs };
      }
      samples[sample] = levels;
    }
    return { ok: true, samples, reporting: playerReporting(candidate.reporting) };
  }
}

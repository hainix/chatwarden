import { isValidAuditActor, AUDIT_REASON_MAX } from './audit.js';
import { sampleRecords, suggest } from './ladder.js';
import { checkFilterRules } from './filters.js';
import { checkNameRules } from './names.js';
import { promptPrinciples } from './principles.js';
import type { PromptExcluded } from './principles.js';
import { CREATOR_TEAM_NOTE, isGameKind, recommendFor } from './recommend.js';
import type { GameKind } from './recommend.js';
import { checkTeamNoteRules, resolveTeamNotes } from './teamNotes.js';
import type { TeamNote } from './teamNotes.js';
import { applyPolicyLayer, changedSections, frozenCopy, layerSections, POLICY_SECTIONS, ProfileError } from './profile.js';
import type { PolicyLayer, PolicySection, ResolvedProfile } from './profile.js';
import { playerReporting } from './reporting.js';
import type { PlayerReporting } from './reporting.js';
import type { RuleRef } from './rules.js';
import { errorClass, safeWarn, ThrottledWarn } from './log.js';
import { RETENTION_DEFAULTS } from './retention.js';
import { checkSignalFeeds, pruneSignalFeeds, SIGNAL_FEED_NAMES } from './signals.js';
import type { SignalDropReason } from './signals.js';
import { RATE_LIMIT, RATE_WINDOW_MS } from './chat.js';
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
 */
export interface PolicyDropped {
  feed: string;
  reason: SignalDropReason;
}

/**
 * The kit's own numbers the settings screens need, read only: they come from `createChatwarden` (`limits.chatRate`, `retention.signalsMs`), are
 * never part of the stored layer, and a save cannot change them.
 */
export interface PolicyLimits {
  /** The chat rate the kit enforces per room and seat: at most `count` lines in any `windowMs` (default 3 per 5 000 ms). Slow mode and burst sit beside it. */
  chatRate: { count: number; windowMs: number };
  /** How long signal rows are kept, ms: the longest window a signal feed may look back (default 90 days, never less than 14). */
  signalsMs: number;
  /** What the chat filters can use: `accountAge` is true only when the kit was given `signals.accountAgeDays`, so a "new account" link rule can act. */
  filters: { accountAge: boolean };
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
   */
  dropped?: readonly PolicyDropped[];
  /**
   * The chat rate limit actually in force and the signals retention window, so a settings screen can say what slow mode sits beside and how
   * far back a feed may look. Read only, deep-frozen.
   */
  limits: PolicyLimits;
  /**
   * What the AI prompt leaves out of the profile in force: indexes into `effective.guidelines` (`tiers`: screened, so the tier line keeps only
   * its title and covers) and into `effective.teamNotes` (`notes`: screened and left out; `capped`: dropped for length), and whether the AI
   * standard (`aiContext`) was screened and left out. Optional on the type for older servers; always set by `get()`, deep-frozen. It reflects
   * the profile in force, so text from a code profile is screened too.
   */
  promptExcluded?: PromptExcluded;
}

/**
 * What {@link PolicyService.setup} answers: whether to show the first-run setup panel, when it was dismissed (null when it has not been) and whether the
 * dismissal survives a restart (`persists`: the store keeps the setup flag; without that it lasts for this process only).
 */
export interface PolicySetup {
  show: boolean;
  dismissedAt: number | null;
  persists: boolean;
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
  /** The chat rate in force (`limits.chatRate`), for `get().limits`. */
  private readonly chatRate: { count: number; windowMs: number };
  /** What the chat filters can use, for `get().limits`. */
  private readonly filtersLimits: Readonly<{ accountAge: boolean }>;
  /** Whether the store has the appeal methods. Without them a layer cannot turn appeals on: it is refused when saved, and kept off when read. */
  private readonly appealsKept: boolean;
  /** Whether the store has the comment and escalation methods. Without them a layer cannot turn `desk.workflow` on: it is refused when saved, and read as off. */
  private readonly workflowKept: boolean;
  private readonly appealsWarn: ThrottledWarn;
  /** Whether a Community Rule number is an active rule of the registry: the filters may cite only those, checked when a layer is saved or previewed. */
  private readonly isActiveRule: (rule: number) => boolean;
  /** Whether a Community Rule number exists in the registry (a retired rule does): a team note may cite one. Checked when a layer is saved or previewed. */
  private readonly ruleExists: (rule: number) => boolean;
  /** When the setup panel was dismissed, as far as this process knows (read from the store, or kept here when the store cannot keep it). A dismissal is never undone. */
  private setupDismissed: number | null = null;
  private readonly setupWarn: ThrottledWarn;

  constructor(deps: { store: Store; clock: Clock; logger: Logger | undefined; base: ResolvedProfile; signalsMs?: () => number; chatRate?: { count: number; windowMs: number }; appealsKept?: boolean; workflowKept?: boolean; isActiveRule?: (rule: number) => boolean; ruleExists?: (rule: number) => boolean; accountAge?: boolean }) {
    this.isActiveRule = deps.isActiveRule ?? (() => true);
    this.ruleExists = deps.ruleExists ?? (() => true);
    this.appealsKept = deps.appealsKept ?? true;
    this.workflowKept = deps.workflowKept ?? true;
    this.appealsWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.setupWarn = new ThrottledWarn(deps.logger, deps.clock);
    this.signalsMs = deps.signalsMs ?? (() => RETENTION_DEFAULTS.signalsMs);
    this.filtersLimits = Object.freeze({ accountAge: deps.accountAge === true });
    this.chatRate = Object.freeze({ count: deps.chatRate?.count ?? RATE_LIMIT, windowMs: deps.chatRate?.windowMs ?? RATE_WINDOW_MS });
    this.store = deps.store;
    this.clock = deps.clock;
    this.logger = deps.logger;
    this.base = deps.base;
    this.state = { effective: applyPolicyLayer(deps.base, {}), layer: frozenCopy({}), version: 0 };
  }

  private get supported(): boolean {
    return typeof this.store.loadPolicyLayer === 'function' && typeof this.store.savePolicyLayer === 'function';
  }

  /** Whether the store keeps the setup flag (both optional methods). */
  private get setupPersists(): boolean {
    return typeof this.store.getSetupState === 'function' && typeof this.store.saveSetupState === 'function';
  }

  /** When the setup panel was dismissed, or null. The store is looked at until a dismissal is seen; a failure or an unreadable value reads as not dismissed (logged by class, throttled). */
  private readDismissal(): number | null {
    if (this.setupDismissed !== null) return this.setupDismissed;
    if (!this.setupPersists) return null;
    try {
      const at: unknown = (this.store.getSetupState?.() as { dismissedAt?: unknown } | null | undefined)?.dismissedAt;
      if (typeof at === 'number' && Number.isFinite(at)) {
        this.setupDismissed = at;
        return at;
      }
    } catch (err) {
      this.setupWarn.warn('chatwarden.setup_state_failed', { error: errorClass(err) });
    }
    return null;
  }

  /**
   * Whether to show the first-run setup panel: only when the store can save settings, nothing was ever saved (version 0: a reset counts as saved), the
   * stored layer is usable and the panel was not dismissed. It looks at the store first, so a layer another process saved hides it. Never throws.
   */
  setup(): PolicySetup {
    this.maybeRefresh();
    const dismissedAt = this.readDismissal();
    const show = this.supported && this.state.version === 0 && this.state.layerError === undefined && dismissedAt === null;
    return { show, dismissedAt, persists: this.setupPersists };
  }

  /**
   * Dismiss the setup panel. The first dismissal is kept (a second call writes nothing and keeps its time); it is written to the store when the store keeps the
   * flag, and kept for this process only otherwise, or when the write failed (logged by class). Answers {@link PolicyService.setup}. Never throws.
   */
  dismissSetup(): PolicySetup {
    try {
      if (this.readDismissal() === null) {
        const at = this.clock.now();
        this.setupDismissed = at;
        if (this.setupPersists) {
          try {
            this.store.saveSetupState?.({ dismissedAt: at });
          } catch (err) {
            this.setupWarn.warn('chatwarden.setup_state_failed', { error: errorClass(err) });
          }
        }
      }
    } catch {
      // A clock that throws leaves the panel as it was.
    }
    return this.setup();
  }

  /**
   * Save the recommended setup for a kind of game (see `recommendFor`) as ONE layer: the current layer with `guidelines`, `firstOffense`, `repeat`, `ladder` and
   * `aiContext` replaced by the recommendation's (always, even when they equal the base), every other section untouched, and for `creator` the team note
   * added to the existing notes unless it is already there. It goes through {@link PolicyService.save}, so `version`, `actor` and `reason` are checked as for any save
   * and the answer carries `changed`: the sections whose stored value differs from the previous layer (what this save really changed, as for `save`: a customised section the apply resets is listed, a section already stored as recommended is not). An unknown game is `invalid` at path `game`; a store that cannot save is `unsupported`. A layer the kit could not use is
   * replaced, not merged (it was ignored anyway). A store failure while looking at the store throws, as `reset` does.
   */
  applyRecommendation(game: GameKind, ctx: PolicySaveContext): PolicySaveResult {
    if (!this.supported) return { ok: false, error: 'unsupported' };
    if (!isGameKind(game)) return { ok: false, error: 'invalid', path: 'game' };
    this.refresh();
    const current: PolicyLayer = this.state.layerError === undefined ? this.state.layer : {};
    const rec = recommendFor(game).layer;
    const next: PolicyLayer = { ...current, guidelines: rec.guidelines, firstOffense: rec.firstOffense, repeat: rec.repeat, ladder: rec.ladder, aiContext: rec.aiContext };
    if (game === 'creator') {
      // The notes in force (the layer's, or the code profile's when the layer sets none), cleaned: a code profile's notes are kept, never replaced by the one note.
      const notes: TeamNote[] = this.state.effective.teamNotes.map((n) => ({ ...n }));
      const creator = resolveTeamNotes([{ text: CREATOR_TEAM_NOTE }])[0]!;
      if (!notes.some((n) => n.text === creator.text)) notes.push(creator);
      next.teamNotes = notes;
    }
    return this.save(next, ctx);
  }

  /** Read the stored layer once, at creation. A store failure here is the caller's (like every other load). */
  load(): void {
    if (!this.supported) return;
    this.lastCheck = this.clock.now();
    this.adopt(this.store.loadPolicyLayer?.() ?? null);
  }

  /**
   * The profile as the store can serve it: a layer that turned appeals on over a store without the appeal methods leaves them off
   * (a code profile that asked for them is refused at creation, never here). Warned by class only, throttled.
   */
  private served(effective: ResolvedProfile): ResolvedProfile {
    let out = effective;
    if (!this.appealsKept && out.appeals.enabled && !this.base.appeals.enabled) {
      this.appealsWarn.warn('chatwarden.appeals_unsupported_store', {});
      out = Object.freeze({ ...out, appeals: Object.freeze({ ...out.appeals, enabled: false }) });
    }
    // The same for the staff workflow: a layer that turned it on over a store without the thread methods leaves it off.
    if (!this.workflowKept && out.desk.workflow && !this.base.desk.workflow) {
      this.appealsWarn.warn('chatwarden.workflow_unsupported_store', {});
      out = Object.freeze({ ...out, desk: Object.freeze({ ...out.desk, workflow: false }) });
    }
    return out;
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
      this.state = { effective: this.served(applyPolicyLayer(this.base, shown)), layer: shown, version, ...(dropped.length === 0 ? {} : { dropped: Object.freeze(dropped.map((d) => Object.freeze(d))) }) };
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
    if (dropped.length === 0) return { layer, dropped };
    // Nothing usable is left of the section: it is not shown at all, so the code's own feeds are what is in force (a section with a `feeds`
    // key replaces them wholesale, and an empty one would keep them off for a reason nobody can see).
    const { feeds: _gone, ...others } = signals as { feeds?: unknown };
    void _gone;
    const rest = { ...layer } as Record<string, unknown>;
    if (Object.keys(pruned).length === 0 && Object.keys(others).length === 0) delete rest['signals'];
    else rest['signals'] = Object.keys(pruned).length === 0 ? others : { ...others, feeds: pruned };
    return { layer: rest as PolicyLayer, dropped };
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
      limits: Object.freeze({ chatRate: this.chatRate, signalsMs: this.signalsMs(), filters: this.filtersLimits }),
      promptExcluded: frozenCopy(promptPrinciples(effective).excluded),
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
    // The layer this save was judged against had feeds taken out of it (`dropped`): the stored row loses them now, so `signals` changed.
    if (this.state.version === expected && this.state.dropped !== undefined && !changed.includes('signals')) {
      changed.push('signals');
      changed.sort((a, b) => POLICY_SECTIONS.indexOf(a) - POLICY_SECTIONS.indexOf(b));
    }
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
      // A switch that would do nothing is refused, so the owner is not shown "on" over a store that cannot keep appeals.
      if (!this.appealsKept && effective.appeals.enabled && !this.base.appeals.enabled) return { ok: false, error: 'invalid', path: 'layer.appeals.enabled' };
      if (!this.workflowKept && effective.desk.workflow && !this.base.desk.workflow) return { ok: false, error: 'invalid', path: 'layer.desk.workflow' };
      // A filter may cite only an active Community Rule. Checked here, not when a stored layer is read: a rule switched off later fails the next save, never the chat path.
      checkFilterRules(effective.filters, this.isActiveRule, 'layer.filters');
      checkNameRules(effective.names, this.isActiveRule, 'layer.names');
      // A note may cite any rule the registry has, a retired one too. Not checked on read: a rule cannot disappear, and the chat path never fails over it.
      checkTeamNoteRules(effective.teamNotes, this.ruleExists, 'layer.teamNotes');
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
      // As save: a window longer than the retention could never be met, so the candidate is refused here too, not only when it is saved.
      checkSignalFeeds(candidate.signals.feeds, candidate.signals.kinds, { signalsMs: this.signalsMs() }, 'layer.signals.feeds');
      checkFilterRules(candidate.filters, this.isActiveRule, 'layer.filters');
      checkNameRules(candidate.names, this.isActiveRule, 'layer.names');
      checkTeamNoteRules(candidate.teamNotes, this.ruleExists, 'layer.teamNotes');
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
    return { ok: true, samples, reporting: playerReporting(candidate.reporting, candidate.safety) };
  }
}

import { checkFilters, mergeFilters } from './filters.js';
import type { FilterSettings, ResolvedFilters } from './filters.js';
import { deepFreeze } from './freeze.js';
import { checkPace, mergePace } from './pace.js';
import type { PaceSettings, ResolvedPace } from './pace.js';
import type { ProfanityConfig } from './profile.js';
import { ProfileError } from './profileError.js';

// Room contexts: rules per room, declared in code (`profile.contexts`), selected by the room's `context` tag. A context overrides only the
// chat-time sections below; the conduct levels, ladder, durations, reporting, appeals, signals and names stay the game's one policy. This
// file is pure data and validation plus the lookup (`Contexts`); the chat path that applies a context is chat.ts and the facade.

/** The chat-time sections a context may override: the one list the other themes extend. */
export const CONTEXT_SECTIONS = ['profanity', 'pace', 'chat', 'filters'] as const;
export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

/** The reserved room tags: `context` (which rules the room uses) and `scope` (which staff may see its reports). */
export const ROOM_TAG_KEYS = ['context', 'scope'] as const;

/** The most contexts a profile may declare. */
export const MAX_CONTEXTS = 20;
/** The most tags a room may carry. */
export const MAX_ROOM_TAGS = 8;
/** The longest tag value, in characters. */
export const ROOM_TAG_VALUE_MAX = 64;
/** The longest context label, in characters. */
export const CONTEXT_LABEL_MAX = 40;
/** The most labels a staff scope may hold. */
export const MAX_SCOPE_LABELS = 20;

const CONTEXT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const SCOPE_LABEL = /^[a-z0-9][a-z0-9:_.-]{0,63}$/;
const TAG_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PHRASE_BOOK_ID = /^[a-z][a-z0-9_-]{0,31}$/;
const PROFANITY_MODES: readonly string[] = ['allow', 'star', 'refuse'];
const PROFANITY_STYLES: readonly string[] = ['full', 'keepFirst', 'grawlix'];
const PROFANITY_KEYS = ['mode', 'style', 'add', 'remove', 'only', 'languages'] as const;
const CHAT_KEYS = ['phrases', 'minAccountAgeDays'] as const;
const CONTEXT_KEYS = ['label', ...CONTEXT_SECTIONS] as const;
const WORD_MAX = 40;

/** Is `v` a well-formed context name? */
export const isContextName = (v: unknown): v is string => typeof v === 'string' && CONTEXT_NAME.test(v);
/** Is `v` a well-formed staff scope label? */
export const isScopeLabel = (v: unknown): v is string => typeof v === 'string' && SCOPE_LABEL.test(v);

/** What a context overrides on the chat path: the room's phrase book (M5) and the youngest account that may speak. */
export interface ContextChat {
  /** The id of a phrase book: the room is phrase-only. `null` or absent: free text. */
  phrases?: string | null;
  /** 1 to 365. A player whose account is younger, or whose age the game cannot tell, is refused `account_too_new`. `null` or absent: no age rule. */
  minAccountAgeDays?: number | null;
}

/** One context as the profile declares it. Every field optional; a field left out inherits the base. */
export interface ContextSettings {
  /** The name on the case chip, 1 to 40 characters. Default: the context's name. */
  label?: string;
  /** Merged over the base `profanity` key by key; an array replaces the base array whole. */
  profanity?: Partial<ProfanityConfig>;
  /** Merged over the base pace: a field left out inherits, `null` turns that check off. */
  pace?: PaceSettings;
  /** Phrase-only rooms and the least account age. */
  chat?: ContextChat;
  /** Merged over the base filters with `mergeFilters`: a block that is given replaces the base's whole, `null` turns it off. */
  filters?: FilterSettings;
}

/** A context as the kit keeps it: validated, copied, the label filled in, and only the sections the context set. */
export interface ResolvedContext extends ContextSettings {
  label: string;
}

/** The contexts of a resolved profile, by name, in the order they were declared. */
export type ResolvedContexts = Readonly<Record<string, ResolvedContext>>;

/** What a room in a context runs with: every section filled. */
export interface EffectiveContext {
  profanity: ProfanityConfig;
  pace: ResolvedPace;
  chat: { phrases: string | null; minAccountAgeDays: number | null };
  filters: ResolvedFilters;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const fail = (path: string, reason: string): never => {
  throw new ProfileError(path, reason);
};

/** `o` must be a plain object with no key outside `allowed`; a refusal names the key, never its value. */
function only(o: unknown, allowed: readonly string[], path: string): Record<string, unknown> {
  if (!isPlain(o)) return fail(path, 'must be an object');
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${path}.${k}`, 'is not a known setting');
  return o;
}

const given = (o: Record<string, unknown>, key: string): unknown => (Object.hasOwn(o, key) ? o[key] : undefined);

function wordList(v: unknown, path: string): string[] {
  if (!Array.isArray(v)) return fail(path, 'must be a list');
  return v.map((item: unknown, i) => {
    if (typeof item !== 'string' || item.length < 1 || item.length > WORD_MAX || /\s/.test(item)) {
      return fail(`${path}[${i}]`, `must be a single word of 1 to ${WORD_MAX} characters with no spaces`);
    }
    return item;
  });
}

function checkProfanity(v: unknown, path: string): Partial<ProfanityConfig> {
  const o = only(v, PROFANITY_KEYS, path);
  const out: Partial<ProfanityConfig> = {};
  const mode = given(o, 'mode');
  if (mode !== undefined) {
    if (typeof mode !== 'string' || !PROFANITY_MODES.includes(mode)) fail(`${path}.mode`, "must be 'allow', 'star' or 'refuse'");
    out.mode = mode as ProfanityConfig['mode'];
  }
  const style = given(o, 'style');
  if (style !== undefined) {
    if (typeof style !== 'string' || !PROFANITY_STYLES.includes(style)) fail(`${path}.style`, "must be 'full', 'keepFirst' or 'grawlix'");
    out.style = style as ProfanityConfig['style'];
  }
  const add = given(o, 'add');
  if (add !== undefined) out.add = wordList(add, `${path}.add`);
  const remove = given(o, 'remove');
  if (remove !== undefined) out.remove = wordList(remove, `${path}.remove`);
  const only_ = given(o, 'only');
  if (only_ !== undefined) out.only = only_ === null ? null : wordList(only_, `${path}.only`);
  const languages = given(o, 'languages');
  if (languages !== undefined) out.languages = wordList(languages, `${path}.languages`);
  return out;
}

function checkChat(v: unknown, path: string): ContextChat {
  const o = only(v, CHAT_KEYS, path);
  const out: ContextChat = {};
  const phrases = given(o, 'phrases');
  if (phrases !== undefined) {
    if (phrases !== null && (typeof phrases !== 'string' || !PHRASE_BOOK_ID.test(phrases))) {
      fail(`${path}.phrases`, 'must be the id of a phrase book: a lowercase letter, then lowercase letters, digits, _ or -, up to 32 characters, or null');
    }
    out.phrases = phrases as string | null;
  }
  const age = given(o, 'minAccountAgeDays');
  if (age !== undefined) {
    if (age !== null && (typeof age !== 'number' || !Number.isSafeInteger(age) || age < 1 || age > 365)) {
      fail(`${path}.minAccountAgeDays`, 'must be a whole number of days from 1 to 365, or null');
    }
    out.minAccountAgeDays = age as number | null;
  }
  return out;
}

function checkOne(v: unknown, path: string, name: string): ResolvedContext {
  const o = only(v, CONTEXT_KEYS, path);
  const label = given(o, 'label');
  if (label !== undefined && (typeof label !== 'string' || label.trim() === '' || label.length > CONTEXT_LABEL_MAX)) {
    fail(`${path}.label`, `must be text of 1 to ${CONTEXT_LABEL_MAX} characters`);
  }
  const out: ResolvedContext = { label: typeof label === 'string' ? label : name };
  const profanity = given(o, 'profanity');
  if (profanity !== undefined) out.profanity = checkProfanity(profanity, `${path}.profanity`);
  const pace = given(o, 'pace');
  if (pace !== undefined) out.pace = checkPace(pace as PaceSettings, `${path}.pace`);
  const chat = given(o, 'chat');
  if (chat !== undefined) out.chat = checkChat(chat, `${path}.chat`);
  const filters = given(o, 'filters');
  if (filters !== undefined) out.filters = checkFilters(filters as FilterSettings, `${path}.filters`);
  return out;
}

/**
 * Check `input` (the profile's `contexts`) and return it as a new object that shares nothing with it: the labels filled in and only the
 * sections each context set. Throws ProfileError naming the field (`profile.contexts.kids.pace.slowModeMs`), never echoing a value: a name
 * that does not fit the grammar is reported on `path` itself. `undefined` is no contexts.
 */
export function resolveContexts(input: Record<string, ContextSettings> | undefined, path = 'profile.contexts'): ResolvedContexts {
  if (input === undefined) return {};
  if (!isPlain(input)) return fail(path, 'must be an object of contexts by name');
  const names = Object.keys(input);
  if (names.length > MAX_CONTEXTS) fail(path, `must declare at most ${MAX_CONTEXTS} contexts`);
  for (const name of names) {
    if (!CONTEXT_NAME.test(name)) fail(path, 'names must be a lowercase letter, then lowercase letters, digits, _ or -, up to 32 characters');
  }
  const out: Record<string, ResolvedContext> = {};
  for (const name of names) {
    Object.defineProperty(out, name, { value: checkOne(input[name], `${path}.${name}`, name), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** The sections this context overrides, in {@link CONTEXT_SECTIONS} order. */
export function overriddenSections(c: ResolvedContext): ContextSection[] {
  return CONTEXT_SECTIONS.filter((s) => Object.hasOwn(c, s));
}

/**
 * Validate the reserved room tags and the shape of every tag: at most 8 keys, a key of 1 to 32 characters starting with a letter, a string
 * value of at most 64 characters, `context` a context name and `scope` a scope label. Throws RangeError (a bug in the game's code: the call
 * is made where the game sets a room up) and never echoes a value.
 */
export function checkRoomTags(tags: unknown): void {
  if (tags === undefined) return;
  if (!isPlain(tags)) throw new RangeError('room tags must be an object of strings');
  const keys = Object.keys(tags);
  if (keys.length > MAX_ROOM_TAGS) throw new RangeError(`a room may carry at most ${MAX_ROOM_TAGS} tags`);
  for (const key of keys) {
    if (!TAG_KEY.test(key)) throw new RangeError('a room tag key must be a letter, then letters, digits, _ or -, up to 32 characters');
    const value = tags[key];
    if (typeof value !== 'string') throw new RangeError(`room tag ${key} must be a string`);
    if (value.length > ROOM_TAG_VALUE_MAX) throw new RangeError(`room tag ${key} must be at most ${ROOM_TAG_VALUE_MAX} characters`);
    if (key === 'context' && !CONTEXT_NAME.test(value)) throw new RangeError('room tag context must be a context name');
    if (key === 'scope' && !SCOPE_LABEL.test(value)) throw new RangeError('room tag scope must be a scope label');
  }
}

const copyOf = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function mergeProfanity(base: ProfanityConfig, over: Partial<ProfanityConfig> | undefined): ProfanityConfig {
  const out: ProfanityConfig = copyOf(base);
  if (over === undefined) return out;
  if (over.mode !== undefined) out.mode = over.mode;
  if (over.style !== undefined) out.style = over.style;
  if (over.add !== undefined) out.add = [...over.add];
  if (over.remove !== undefined) out.remove = [...over.remove];
  if (over.only !== undefined) out.only = over.only === null ? null : [...over.only];
  if (over.languages !== undefined) out.languages = [...over.languages];
  return out;
}

/** The sections of the profile a context is merged over. */
export interface ContextBase {
  profanity: ProfanityConfig;
  pace: ResolvedPace;
  filters: ResolvedFilters;
  contexts: ResolvedContexts;
}

/** The effective sections of a context over `base`: a pure function, every value a new frozen copy that shares nothing with `base`. */
export function effectiveOf(base: ContextBase, name: string | null): EffectiveContext {
  const ctx = name === null ? undefined : Object.hasOwn(base.contexts, name) ? base.contexts[name] : undefined;
  if (name !== null && ctx === undefined) throw new ProfileError('context', 'is not a declared context');
  return deepFreeze({
    profanity: mergeProfanity(base.profanity, ctx?.profanity),
    pace: ctx?.pace === undefined ? copyOf(base.pace) : mergePace(base.pace, ctx.pace),
    chat: { phrases: ctx?.chat?.phrases ?? null, minAccountAgeDays: ctx?.chat?.minAccountAgeDays ?? null },
    filters: ctx?.filters === undefined ? copyOf(base.filters) : mergeFilters(base.filters, ctx.filters),
  });
}

/**
 * The lookup the kit holds: which context a room is in (read from its `context` tag on every line, so a cheap lookup) and what a context
 * means over the profile in force. The merged pace and filters are cached per context name and dropped when the live profile object
 * changes (it is a new object on every stored-layer change); a context that does not override a section hands back the profile's own object.
 */
export class Contexts {
  private readonly profile: () => ContextBase;
  private readonly tag: (roomId: string) => string | undefined;
  private seen: ContextBase | null = null;
  private readonly merged = new Map<string, { pace?: ResolvedPace; filters?: ResolvedFilters }>();

  constructor(deps: { profile: () => ContextBase; tag: (roomId: string) => string | undefined }) {
    this.profile = deps.profile;
    this.tag = deps.tag;
  }

  /** The declared names, in declaration order. */
  names(): string[] {
    return Object.keys(this.profile().contexts);
  }

  /** The room's validated context tag, or null (no tag, or one that is not a context name). */
  of(roomId: string): string | null {
    const t = this.tag(roomId);
    return isContextName(t) ? t : null;
  }

  /**
   * What the room's tag means: `null` for a room with no `context` tag (the base), the context name, or `'unknown'` for a tag that is
   * malformed or that the profile does not declare (the chat path refuses every line, failing shut).
   */
  resolveTag(roomId: string): string | null | 'unknown' {
    const t = this.tag(roomId);
    if (t === undefined) return null;
    if (!isContextName(t)) return 'unknown';
    return Object.hasOwn(this.profile().contexts, t) ? t : 'unknown';
  }

  /** {@link effectiveOf} for the profile in force. Throws ProfileError for a name the profile does not declare. */
  effective(name: string | null): EffectiveContext {
    return effectiveOf(this.profile(), name);
  }

  private entry(name: string): { pace?: ResolvedPace; filters?: ResolvedFilters } {
    const live = this.profile();
    if (live !== this.seen) {
      this.merged.clear();
      this.seen = live;
    }
    let held = this.merged.get(name);
    if (held === undefined) {
      held = {};
      this.merged.set(name, held);
    }
    return held;
  }

  /** The pace a room runs with before any `setPace` override: the profile's own object unless the room's context sets pace. */
  paceOf(roomId: string): ResolvedPace {
    const live = this.profile();
    const name = this.resolveTag(roomId);
    const over = name === null || name === 'unknown' ? undefined : live.contexts[name]?.pace;
    if (name === null || name === 'unknown' || over === undefined) return live.pace;
    const held = this.entry(name);
    return (held.pace ??= mergePace(live.pace, over));
  }

  /** The filters a room runs with: the profile's own object unless the room's context sets filters. */
  filtersOf(roomId: string): ResolvedFilters {
    const live = this.profile();
    const name = this.resolveTag(roomId);
    const over = name === null || name === 'unknown' ? undefined : live.contexts[name]?.filters;
    if (name === null || name === 'unknown' || over === undefined) return live.filters;
    const held = this.entry(name);
    return (held.filters ??= mergeFilters(live.filters, over));
  }
}

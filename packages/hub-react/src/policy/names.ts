import type { NameSettings } from '@chatwarden/core';

// The draft of the "Names" panel: four switches and two lists of names, as the kit reads them. Pure: nothing here reads the page or sends anything.

export interface NamesDraft {
  /** Also refuse a name the profanity filter flags. */
  profanity: boolean;
  /** Keep a blocked name, with the word it hit, as evidence. */
  keep: boolean;
  /** A moderator may ask a player for a new name. */
  renames: boolean;
  /** Hide a name the word list flags in this hub until it is shown. On unless the owner turned it off. */
  mask: boolean;
  /** The protected names, one to a line (a textarea's text). */
  reserved: string;
  /** The names that pass although they read as a protected one, one to a line. */
  allow: string;
}

/** What the kit reports in force (`effective.names`); an older server sends none, which reads as the defaults. */
type Names = Partial<{ profanity: boolean; keepBlocked: boolean; renames: boolean; maskInHub: boolean; reserved: readonly string[]; reservedAllow: readonly string[] }> | undefined;

export const namesDraftOf = (n: Names): NamesDraft => ({
  profanity: n?.profanity === true,
  keep: n?.keepBlocked === true,
  renames: n?.renames === true,
  mask: n?.maskInHub !== false,
  reserved: (n?.reserved ?? []).join('\n'),
  allow: (n?.reservedAllow ?? []).join('\n'),
});

/** The names a textarea holds: one to a line, trimmed, blank lines dropped. The kit refuses what does not fit, naming the entry. */
export const linesOf = (text: string): string[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');

/**
 * The names section to save: every switch named, so a setting the owner left alone is still the same after a change in the code. A list is named only when it has names or the one in force has
 * (so an owner who never uses them saves exactly what they always did, and one who empties a list saves the empty one).
 */
export function namesLayer(d: NamesDraft, effective?: Names): NameSettings {
  const reserved = linesOf(d.reserved);
  const allow = linesOf(d.allow);
  return {
    profanity: d.profanity,
    keepBlocked: d.keep,
    renames: d.renames,
    maskInHub: d.mask,
    ...(reserved.length > 0 || (effective?.reserved?.length ?? 0) > 0 ? { reserved } : {}),
    ...(allow.length > 0 || (effective?.reservedAllow?.length ?? 0) > 0 ? { reservedAllow: allow } : {}),
  };
}

/** Is the draft different from what is in force? The lists are compared as names, so a stray space or blank line is no change. */
export const namesDirty = (d: NamesDraft, effective: Names): boolean => {
  const now = namesDraftOf(effective);
  return JSON.stringify({ ...d, reserved: linesOf(d.reserved), allow: linesOf(d.allow) }) !== JSON.stringify({ ...now, reserved: linesOf(now.reserved), allow: linesOf(now.allow) });
};

/** The field a refusal's layer path names (a switch, or one of the two lists, entry or not); null for a path that is not one of them. */
export function namesFieldKey(path: string): string | null {
  const field = /^layer\.names\.(profanity|keepBlocked|renames|maskInHub|reserved|reservedAllow)(?:\[\d+\])?$/.exec(path)?.[1];
  if (field === undefined) return null;
  return field === 'keepBlocked' ? 'keep' : field === 'maskInHub' ? 'mask' : field === 'reservedAllow' ? 'allow' : field;
}

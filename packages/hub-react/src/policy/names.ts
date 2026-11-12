import type { NameSettings } from '@chatwarden/core';

// The draft of the "Names" panel: four switches, as the kit reads them. Pure: nothing here reads the page or sends anything.

export interface NamesDraft {
  /** Also refuse a name the profanity filter flags. */
  profanity: boolean;
  /** Keep a blocked name, with the word it hit, as evidence. */
  keep: boolean;
  /** A moderator may ask a player for a new name. */
  renames: boolean;
  /** Hide a name the word list flags in this hub until it is shown. On unless the owner turned it off. */
  mask: boolean;
}

/** What the kit reports in force (`effective.names`); an older server sends none, which reads as the defaults. */
type Names = Partial<{ profanity: boolean; keepBlocked: boolean; renames: boolean; maskInHub: boolean }> | undefined;

export const namesDraftOf = (n: Names): NamesDraft => ({
  profanity: n?.profanity === true,
  keep: n?.keepBlocked === true,
  renames: n?.renames === true,
  mask: n?.maskInHub !== false,
});

/** The names section to save: every switch named, so a setting the owner left alone is still the same after a change in the code. */
export const namesLayer = (d: NamesDraft): NameSettings => ({ profanity: d.profanity, keepBlocked: d.keep, renames: d.renames, maskInHub: d.mask });

/** Is the draft different from what is in force? */
export const namesDirty = (d: NamesDraft, effective: Names): boolean => JSON.stringify(d) !== JSON.stringify(namesDraftOf(effective));

/** The switch a refusal's layer path names; null for a path that is not one of them. */
export function namesFieldKey(path: string): string | null {
  const field = /^layer\.names\.(profanity|keepBlocked|renames|maskInHub)$/.exec(path)?.[1];
  if (field === undefined) return null;
  return field === 'keepBlocked' ? 'keep' : field === 'maskInHub' ? 'mask' : field;
}

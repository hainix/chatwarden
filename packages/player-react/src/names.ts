import type { NameReason } from '@chatwarden/core';
import { en } from './i18n.js';
import type { PlayerT, PlayerText } from './i18n.js';

const NAME_TEXT: Readonly<Record<NameReason, PlayerText>> = {
  name_not_allowed: 'player.name.not_allowed',
  name_profane: 'player.name.profane',
};

/**
 * The sentence a sign-up screen shows beside its name field when `cw.names.check` (or `POST /names/check`) refused a name: "That name is
 * not allowed. Choose another." for `name_not_allowed`, "That name is not allowed here. Choose another." for `name_profane`. A reason a newer
 * kit adds reads as the general one. A key your catalog lacks falls back to the English words, never to the key. It never says which
 * word matched: the check does not tell it.
 * @experimental
 */
export function nameReasonText(t: PlayerT, reason: NameReason): string {
  const key = typeof reason === 'string' && Object.hasOwn(NAME_TEXT, reason) ? NAME_TEXT[reason] : NAME_TEXT.name_not_allowed;
  const words = t(key);
  return words === key ? ((en as Record<string, string>)[key] ?? words) : words;
}

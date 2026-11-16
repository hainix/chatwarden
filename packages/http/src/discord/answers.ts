import type { KitResponse } from '../types.js';
import type { DiscordActionRow } from './types.js';

// What the bot answers with. Every answer is a Discord interaction response with `allowed_mentions: { parse: [] }`, so nothing in it can ping anyone,
// and every answer to a command or a button is ephemeral (`flags: 64`): only the person who clicked sees it.

/** Discord's interaction callback types the bot uses. */
export const PONG = 1;
export const CHANNEL_MESSAGE = 4;
export const UPDATE_MESSAGE = 7;
/** The ephemeral message flag, `1 << 6`. */
export const EPHEMERAL = 64;

/** The interaction response body, before it is wrapped in an HTTP response. */
export interface InteractionAnswer {
  type: number;
  data?: {
    content: string;
    flags: number;
    allowed_mentions: { parse: [] };
    components: readonly DiscordActionRow[];
  };
}

/** A new ephemeral message (type 4): a refusal, a lookup, a preview. */
export const ephemeral = (content: string, components: readonly DiscordActionRow[] = []): InteractionAnswer => ({
  type: CHANNEL_MESSAGE,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, components },
});

/** Replace the message the button was on (type 7): a confirm becomes "Done", a cancel becomes "Cancelled". */
export const updateMessage = (content: string, components: readonly DiscordActionRow[] = []): InteractionAnswer => ({
  type: UPDATE_MESSAGE,
  data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] }, components },
});

/** The HTTP response: 200, JSON, with a content type Discord accepts. */
export const respond = (answer: InteractionAnswer | { type: number }): KitResponse => ({
  status: 200,
  headers: { 'content-type': 'application/json' },
  body: answer,
});

/** The fixed answers. Fixed text so a probe learns nothing from a difference, and never an id, a role name or a user. */
export const TEXT = {
  notSetUp: 'This bot is not set up for this server.',
  noRole: 'You do not have a moderator role for this bot.',
  noPermission: 'You do not have permission to do this.',
  slowDown: 'Slow down.',
  actionsOff: 'Actions from Discord are turned off.',
  unsupported: 'That is not available here.',
  noSanction: 'No sanction found for that code.',
  claimed: 'Another moderator has this case open.',
  needsRule: 'This report needs a Community Rule chosen. Open it in the hub.',
  changed: 'That changed. Open it in the hub.',
  failed: 'Something went wrong. Try again in the hub.',
  cancelled: 'Cancelled.',
} as const;

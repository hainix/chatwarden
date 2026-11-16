import type { Role } from '@chatwarden/core';
import type { RouteTable } from '../router.js';

// The wire shapes the bot sends. They are written out here, not imported from `@chatwarden/discord`, so this subpath has no dependency on that
// package: the two meet only in the adopter's wiring (K5 design 6.1), and a test checks that the rows the bot makes pass the feed's own check.

/** A button: styles 1 to 4 carry a `custom_id` and send it back; style 5 is a link. */
export type DiscordButton =
  | { type: 2; style: 1 | 2 | 3 | 4; label: string; custom_id: string }
  | { type: 2; style: 5; label: string; url: string };

/** One row of buttons. */
export interface DiscordActionRow {
  type: 1;
  components: readonly DiscordButton[];
}

/** An option of a slash command. */
export interface DiscordCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  min_length?: number;
  max_length?: number;
  options?: readonly DiscordCommandOption[];
}

/** A slash command as `PUT /applications/{app}/guilds/{guild}/commands` takes it. */
export interface DiscordCommand {
  name: string;
  description: string;
  type: 1;
  default_member_permissions: string;
  options: readonly DiscordCommandOption[];
}

/** What `discordBot` returns. */
export interface DiscordBot {
  /** `POST /discord/interactions`: mount it with the rest of the kit's routes. The adapter must supply `rawBody`. */
  routes: RouteTable;
  /** The buttons for a report post (hand it to `discordFeed({ components })`). `undefined` unless `actions` is set. */
  components(post: { kind: 'report'; reportId: string }): readonly DiscordActionRow[] | undefined;
  /** The command definitions for `registerCommands`. A fresh copy each call. */
  commands(): readonly DiscordCommand[];
  /** Forget what the bot holds in memory and stop accepting work. Safe to call more than once. */
  dispose(): void;
}

/** Which Discord role ids map to which kit role. */
export type DiscordRoleMap = Readonly<Partial<Record<Role, readonly string[]>>>;

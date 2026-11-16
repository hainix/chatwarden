// What the bot reads of a verified interaction, and no more. The body is signed by Discord, so it is trusted to come from Discord, but every field is
// still read defensively: it may be missing, mistyped or oversized, and a click is only as trustworthy as the role list and user id in it.

const SNOWFLAKE = /^\d{17,20}$/;
const ID_MAX = 64;
const VALUE_MAX = 64;

export interface ParsedInteraction {
  /** The interaction id (kept to answer a redelivery the same way), or null when it has none the bot can use. */
  id: string | null;
  type: number;
  /** The guild the interaction came from, or null (a DM, or none). */
  guildId: string | null;
  /** `member.user.id` when it is a snowflake, else null (a DM has no `member`). */
  userId: string | null;
  /** `member.roles`: the strings in it, as sent (never names: Discord sends ids). */
  roles: readonly string[];
  /** `data.name` of a command, or null. */
  commandName: string | null;
  /** `data.options` as sent, for the command parser. */
  options: readonly unknown[];
  /** `data.custom_id` of a component, or null. */
  customId: string | null;
}

const obj = (v: unknown): Record<string, unknown> | null => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** Read the fields the bot uses. Never throws, whatever the body holds. */
export function parseInteraction(body: Record<string, unknown>): ParsedInteraction {
  const member = obj(body.member);
  const user = obj(member?.user);
  const data = obj(body.data);
  const id = typeof body.id === 'string' && body.id.length >= 1 && body.id.length <= ID_MAX ? body.id : null;
  const roles = Array.isArray(member?.roles) ? (member.roles as unknown[]).filter((r): r is string => typeof r === 'string' && r.length <= 32) : [];
  return {
    id,
    type: typeof body.type === 'number' ? body.type : 0,
    guildId: typeof body.guild_id === 'string' && SNOWFLAKE.test(body.guild_id) ? body.guild_id : null,
    userId: typeof user?.id === 'string' && SNOWFLAKE.test(user.id) ? user.id : null,
    roles: roles.slice(0, 250),
    commandName: typeof data?.name === 'string' ? data.name : null,
    options: Array.isArray(data?.options) ? (data.options as unknown[]) : [],
    customId: typeof data?.custom_id === 'string' ? data.custom_id : null,
  };
}

/**
 * The reference code typed to `/chatwarden lookup`, or `undefined` when the command is not that (an unknown subcommand), or `null` when it is
 * `lookup` with no usable value. A value is a string of at most 64 characters (longer is as good as wrong).
 */
export function lookupRef(options: readonly unknown[]): string | null | undefined {
  const sub = options.map(obj).find((o) => o !== null && o.name === 'lookup');
  if (sub === undefined || sub === null) return undefined;
  const inner = Array.isArray(sub.options) ? (sub.options as unknown[]).map(obj) : [];
  const ref = inner.find((o) => o !== null && o.name === 'ref');
  const value = ref?.value;
  return typeof value === 'string' && value.length <= VALUE_MAX ? value : null;
}

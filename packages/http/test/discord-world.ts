import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { KitRequest } from '../src/types.js';

// The fake Discord for the bot's tests (K5 D3): an Ed25519 key pair generated here (never a real key), a builder that signs interactions the way
// Discord does (timestamp + raw body), and a reader for the answers. No network, no real application id or token: every id is obviously fake digits.

export const APP_ID = '111111111111111111';
export const GUILD_ID = '222222222222222222';
export const OTHER_GUILD_ID = '222222222222222299';
export const ROLE_MOD = '333333333333333301';
export const ROLE_SENIOR = '333333333333333302';
export const ROLE_OWNER = '333333333333333303';
export const ROLE_OTHER = '333333333333333399';
export const USER_ID = '444444444444444401';
export const USER_2 = '444444444444444402';
export const PATH = '/discord/interactions';

/** Seconds since the epoch of the test clock's start; the tests' clock is `t` milliseconds. */
export const NOW = 1_800_000_000_000;

export interface Pair {
  publicKeyHex: string;
  privateKey: KeyObject;
}

/** A fresh Ed25519 key pair: the 32 raw public bytes as hex (what the Developer Portal shows) and the private key. */
export function newPair(): Pair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return { publicKeyHex: Buffer.from(der.subarray(der.length - 32)).toString('hex'), privateKey };
}

export interface SignOptions {
  /** The signed timestamp in unix seconds (default: the clock's). */
  timestamp?: number | string;
  /** Sign with another key (a forged request). */
  pair?: Pair;
  /** Send this body instead of the signed one. */
  sendRaw?: string;
  /** Replace or drop headers (undefined drops). */
  headers?: Record<string, string | undefined>;
  /** Sign this exact text as the timestamp part (default: the timestamp header's value). */
  signedTimestamp?: string;
}

export interface ClientOptions {
  now: () => number;
  pair?: Pair;
}

/** Who clicked: roles, user, guild (null: none), and a DM when `member` is false. */
export interface Who {
  roles?: readonly string[];
  user?: string;
  guild?: string | null;
  /** `false` makes a DM: no member, a top-level user instead. */
  member?: boolean;
  id?: string;
}

/** Builds signed requests for one fake application. */
export function fakeDiscordClient(options: ClientOptions) {
  const pair = options.pair ?? newPair();
  let counter = 0;
  const nextId = (): string => `5555555555${String(++counter).padStart(8, '0')}`;

  /** A signed request around `rawBody`. */
  const raw = (rawBody: string, o: SignOptions = {}): KitRequest => {
    const ts = String(o.timestamp ?? Math.floor(options.now() / 1000));
    const signer = (o.pair ?? pair).privateKey;
    const signature = sign(null, Buffer.from((o.signedTimestamp ?? ts) + rawBody, 'utf8'), signer).toString('hex');
    const headers: Record<string, string> = { 'x-signature-ed25519': signature, 'x-signature-timestamp': ts };
    for (const [k, v] of Object.entries(o.headers ?? {})) {
      if (v === undefined) delete headers[k];
      else headers[k] = v;
    }
    return { method: 'POST', path: PATH, query: {}, headers, body: undefined, rawBody: o.sendRaw ?? rawBody };
  };

  const signed = (body: unknown, o: SignOptions = {}): KitRequest => raw(typeof body === 'string' ? body : JSON.stringify(body), o);

  const member = (roles: readonly string[], user: string) => ({ user: { id: user, username: 'zorbak-name' }, roles: [...roles], permissions: '0' });

  const base = (type: number, who: Who) => {
    const user = who.user ?? USER_ID;
    return {
      id: who.id ?? nextId(),
      application_id: APP_ID,
      type,
      token: `tok_${counter}_fake-interaction-token`,
      version: 1,
      ...(who.guild === null ? {} : { guild_id: who.guild ?? GUILD_ID }),
      ...(who.member === false ? { user: { id: user } } : { member: member(who.roles ?? [ROLE_MOD], user) }),
    };
  };

  return {
    pair,
    publicKeyHex: pair.publicKeyHex,
    raw,
    signed,
    ping: (o: SignOptions = {}) => signed({ id: nextId(), application_id: APP_ID, type: 1, token: 'tok_ping', version: 1 }, o),
    /** `/chatwarden lookup ref:<ref>` */
    lookup: (ref: unknown, who: Who = {}, o: SignOptions = {}) =>
      signed(
        { ...base(2, who), data: { id: '666666666666666601', name: 'chatwarden', type: 1, options: [{ type: 1, name: 'lookup', options: [{ type: 3, name: 'ref', value: ref }] }] } },
        o,
      ),
    /** A command interaction with an arbitrary `data`. */
    command: (data: unknown, who: Who = {}, o: SignOptions = {}) => signed({ ...base(2, who), data }, o),
    /** A button click with `custom_id`. */
    click: (customId: unknown, who: Who = {}, o: SignOptions = {}) => signed({ ...base(3, who), data: { custom_id: customId, component_type: 2 }, message: { id: '777777777777777701' } }, o),
    /** An interaction of any type with no data (autocomplete, modal). */
    ofType: (type: number, who: Who = {}, o: SignOptions = {}) => signed({ ...base(type, who), data: {} }, o),
    /** The interaction as an object, for a test that wants to re-sign it or deliver it twice. */
    interaction: (type: number, data: unknown, who: Who = {}) => ({ ...base(type, who), data }),
  };
}

export type DiscordClient = ReturnType<typeof fakeDiscordClient>;

/** What an answer's data holds, for a test that reads it. */
export interface Answer {
  type: number;
  data?: {
    content?: string;
    flags?: number;
    allowed_mentions?: { parse?: string[] };
    components?: Array<{ type: number; components: Array<Record<string, unknown>> }>;
  };
}

export const answerOf = (res: { status: number; body: unknown }): Answer => {
  if (res.status !== 200) throw new Error(`status ${res.status}`);
  return res.body as Answer;
};

export const contentOf = (res: { status: number; body: unknown }): string => answerOf(res).data?.content ?? '';

/** Every button of an answer, flattened. */
export const buttonsOf = (res: { status: number; body: unknown }): Array<Record<string, unknown>> =>
  (answerOf(res).data?.components ?? []).flatMap((row) => row.components);

/** A recording logger. */
export function recordingLogger() {
  const logged: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  return { logged, logger: { warn: (event: string, detail?: Record<string, string | number | boolean>) => void logged.push([event, detail]) } };
}

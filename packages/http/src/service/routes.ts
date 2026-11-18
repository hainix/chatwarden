// The /v1 route table (design 3.3). Each route is DESCRIBED once, as data (`ROUTE_SPECS`: method, path, summary, request and answer schemas, examples, whether it honours `Idempotency-Key`), and
// the table and `SERVICE_OPENAPI` are both built from those descriptions, so they cannot disagree. A route's handler is a thin adapter: validate, call the kit, copy the answer by name.
// Browser-safe: nothing here imports `node:`.
import { errorClass, safeWarn } from '@chatwarden/core';
import type { Chatwarden, ChatResult, DoorKind, NameKind, RawWho, ReportEntity } from '@chatwarden/core';
import { HttpError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { KitResponse } from '../types.js';
import { VERSION } from '../version.js';
import { SERVICE_API_VERSION, parseWho, validId } from './contract.js';
import type { ServiceWho } from './contract.js';
import { doorRefusal, lineRefusal } from './refusal.js';
import type { ServiceCall, ServiceHandler, Svc } from './wrap.js';

type Schema = Record<string, unknown>;

/** A route's description. */
export interface RouteSpec {
  /** A short id, unique. */
  name: string;
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** The router pattern under the `/v1` mount (`/rooms/:room~room/seats/:seat~room`). */
  path: string;
  /** The same path as OpenAPI writes it, under `/v1` (`/rooms/{room}/seats/{seat}`). */
  openapiPath: string;
  summary: string;
  /** The JSON schema of the body, when the route takes one. */
  request?: Schema;
  /** A body that fits `request`, for the document and the tests. */
  requestExample?: unknown;
  /** The JSON schema of the 200 answer (a refusal is a 200 too). */
  answer: Schema;
  /** Answers that fit `answer`, one per shape the route can give. */
  examples: unknown[];
  /** Honours an `Idempotency-Key` header. */
  idempotent?: boolean;
}

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str = (min = 1, max = 256): Schema => ({ type: 'string', minLength: min, maxLength: max });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const nullable = (type: string): Schema => ({ type: [type, 'null'] });
const okTrue: Schema = { const: true };

/** The schemas the routes share, as `components.schemas`. */
export const SERVICE_SCHEMAS: Record<string, Schema> = {
  Who: obj({ clientKey: str(), accountId: str(), ip: str() }),
  Error: obj({ error: str(), message: str() }, ['error', 'message']),
  Refusal: obj(
    {
      reason: str(1, 64),
      until: nullable('number'),
      byModerator: { type: 'boolean' },
      rule: { type: 'integer', minimum: 1 },
      noticeId: str(1, 64),
      retryAfterMs: { type: 'integer', minimum: 1 },
    },
    ['reason'],
  ),
  Restriction: obj({ until: nullable('number'), kind: nullable('string') }, ['until', 'kind']),
  Notice: {
    type: 'object',
    properties: {
      id: str(),
      kind: str(),
      rule: { type: ['integer', 'string', 'null'] },
      ruleLabel: nullable('string'),
      until: nullable('number'),
      refCode: nullable('string'),
      excerpt: { type: 'array', items: obj({ text: { type: 'string' }, day: { type: 'string' } }, ['text', 'day']) },
      createdAt: { type: 'number' },
      mustAcknowledge: { type: 'boolean' },
    },
    required: ['id', 'kind', 'excerpt', 'createdAt', 'mustAcknowledge'],
  },
};

const ID: Schema = { type: 'string', pattern: '^[A-Za-z0-9_.:@~-]{1,128}$' };
const WHO = ref('Who');
const REFUSED_LINE = obj({ ok: { const: false }, refused: ref('Refusal') }, ['ok', 'refused']);
const SEATED_WHO = { clientKey: 'raw-client-key-0001' };
const NOTICE_EXAMPLE = { id: 'n1', kind: 'warning', rule: 2, ruleLabel: 'Be respectful', until: null, refCode: 'CW-0001', excerpt: [{ text: 'a line', day: '2026-11-17' }], createdAt: 1_800_000_000_000, mustAcknowledge: true };

export const ROUTE_SPECS: readonly RouteSpec[] = [
  {
    name: 'handshake',
    method: 'GET',
    path: '/',
    openapiPath: '/',
    summary: 'The handshake: the API version, the kit version, what this service can do and the warnings an operator should read.',
    answer: obj(
      {
        api: { type: 'integer', minimum: 1 },
        kit: str(),
        mode: { const: 'service' },
        processes: { enum: ['single', 'multiple'] },
        capabilities: obj(
          { phrases: { type: 'boolean' }, blocks: { type: 'boolean' }, contexts: { type: 'array', items: str() }, sharedPacing: { type: 'boolean' }, matchModes: { type: 'array', items: str() } },
          ['phrases', 'blocks', 'contexts', 'sharedPacing', 'matchModes'],
        ),
        warnings: { type: 'array', items: str(1, 32) },
      },
      ['api', 'kit', 'mode', 'processes', 'capabilities', 'warnings'],
    ),
    examples: [{ api: 1, kit: '0.2.0', mode: 'service', processes: 'single', capabilities: { phrases: false, blocks: true, contexts: ['kids'], sharedPacing: false, matchModes: ['word', 'segment', 'contains'] }, warnings: ['synthetic_terms'] }],
  },
  {
    name: 'seat',
    method: 'PUT',
    path: '/rooms/:room~room/seats/:seat~room',
    openapiPath: '/rooms/{room}/seats/{seat}',
    summary: 'Seat a person: the room, the seat, who sits there and the name moderators see. A repeat replaces. Answers the restriction they are under, so the game can say so at once.',
    request: obj({ who: WHO, handle: str(1, 64), tags: { type: 'object', additionalProperties: str(1, 64) } }, ['who', 'handle']),
    requestExample: { who: SEATED_WHO, handle: 'Plenk', tags: { context: 'kids' } },
    answer: obj({ ok: okTrue, restriction: { oneOf: [ref('Restriction'), { type: 'null' }] } }, ['ok', 'restriction']),
    examples: [{ ok: true, restriction: null }, { ok: true, restriction: { until: 1_800_003_600_000, kind: 'chat' } }],
  },
  {
    name: 'unseat',
    method: 'DELETE',
    path: '/rooms/:room~room/seats/:seat~room',
    openapiPath: '/rooms/{room}/seats/{seat}',
    summary: 'Empty a seat. A no-op for a seat the service does not know.',
    answer: obj({ ok: okTrue }, ['ok']),
    examples: [{ ok: true }],
  },
  {
    name: 'close',
    method: 'DELETE',
    path: '/rooms/:room~room',
    openapiPath: '/rooms/{room}',
    summary: 'Close a room: its seats, tags, evidence and pace state go.',
    answer: obj({ ok: okTrue }, ['ok']),
    examples: [{ ok: true }],
  },
  {
    name: 'lines',
    method: 'POST',
    path: '/rooms/:room~room/seats/:seat~room/lines',
    openapiPath: '/rooms/{room}/seats/{seat}/lines',
    summary: 'Check a line a player typed. Deliver `line.text` to every seat except those in `hiddenFor`, or tell the author why it was refused. Honours Idempotency-Key.',
    request: obj({ text: { type: 'string' } }, ['text']),
    requestExample: { text: 'hello everyone' },
    answer: {
      oneOf: [obj({ ok: okTrue, line: obj({ id: str(1, 128), text: { type: 'string' }, phrase: str(1, 32) }, ['id', 'text']), hiddenFor: { type: 'array', items: str(1, 128) } }, ['ok', 'line', 'hiddenFor']), REFUSED_LINE],
    },
    examples: [{ ok: true, line: { id: 'l1', text: 'hello everyone' }, hiddenFor: [] }, { ok: false, refused: { reason: 'blocked', rule: 1 } }],
    idempotent: true,
  },
  {
    name: 'phrases',
    method: 'POST',
    path: '/rooms/:room~room/seats/:seat~room/phrases',
    openapiPath: '/rooms/{room}/seats/{seat}/phrases',
    summary: 'Send one phrase of a phrase-only room book, by its id. The answer is the same as for a line, with the phrase id on `line`. Text in a phrase room is refused phrases_only; an id the book lacks is phrase_unknown. Honours Idempotency-Key.',
    request: obj({ phraseId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' } }, ['phraseId']),
    requestExample: { phraseId: 'gg' },
    answer: {
      oneOf: [obj({ ok: okTrue, line: obj({ id: str(1, 128), text: { type: 'string' }, phrase: str(1, 32) }, ['id', 'text']), hiddenFor: { type: 'array', items: str(1, 128) } }, ['ok', 'line', 'hiddenFor']), REFUSED_LINE],
    },
    examples: [{ ok: true, line: { id: 'l2', text: 'Good game!', phrase: 'gg' }, hiddenFor: [] }, { ok: false, refused: { reason: 'phrase_unknown' } }],
    idempotent: true,
  },
  {
    name: 'mutes_list',
    method: 'GET',
    path: '/rooms/:room~room/seats/:seat~room/mutes',
    openapiPath: '/rooms/{room}/seats/{seat}/mutes',
    summary: 'The seats whose current occupant this seat muted (`muted`) or blocked (`blocked`). Seat ids only.',
    answer: obj({ muted: { type: 'array', items: str(1, 128) }, blocked: { type: 'array', items: str(1, 128) } }, ['muted', 'blocked']),
    examples: [{ muted: ['b'], blocked: [] }],
  },
  {
    name: 'mutes_put',
    method: 'PUT',
    path: '/rooms/:room~room/seats/:seat~room/mutes/:target~room',
    openapiPath: '/rooms/{room}/seats/{seat}/mutes/{target}',
    summary: 'This seat mutes (or, with kind block, blocks) the target seat. Muting oneself or an empty seat does nothing and answers ok. A block is two-way and lasting: neither seat is sent the lines of the other.',
    request: obj({ kind: { enum: ['mute', 'block'] } }),
    requestExample: { kind: 'block' },
    answer: { oneOf: [obj({ ok: okTrue }, ['ok']), obj({ ok: { const: false }, limit: okTrue }, ['ok', 'limit'])] },
    examples: [{ ok: true }, { ok: false, limit: true }],
  },
  {
    name: 'mutes_delete',
    method: 'DELETE',
    path: '/rooms/:room~room/seats/:seat~room/mutes/:target~room',
    openapiPath: '/rooms/{room}/seats/{seat}/mutes/{target}',
    summary: 'Remove a mute.',
    answer: obj({ ok: okTrue }, ['ok']),
    examples: [{ ok: true }],
  },
  {
    name: 'reports',
    method: 'POST',
    path: '/rooms/:room~room/seats/:seat~room/reports',
    openapiPath: '/rooms/{room}/seats/{seat}/reports',
    summary: 'This seat reports another. The kit snapshots the chat it saw. No report id comes back. Honours Idempotency-Key.',
    request: obj({ target: ID, lineId: str(1, 64), reason: str(1, 64), note: str(1, 500), entity: obj({ kind: str(1, 24), ref: str(1, 64), label: str(1, 64) }, ['kind', 'ref', 'label']) }, ['target']),
    requestExample: { target: 'b', reason: 'name', entity: { kind: 'clan', ref: 'clan-42', label: 'Example Clan' } },
    answer: {
      oneOf: [
        obj({ ok: okTrue, remaining: { type: 'integer', minimum: 0 }, detailUntil: { type: 'number' } }, ['ok', 'remaining']),
        obj({ ok: { const: false }, refused: str(1, 64), remaining: { type: 'integer', minimum: 0 } }, ['ok', 'refused']),
      ],
    },
    examples: [{ ok: true, remaining: 9, detailUntil: 1_800_000_600_000 }, { ok: false, refused: 'reason_unknown' }],
    idempotent: true,
  },
  {
    name: 'notices_pending',
    method: 'POST',
    path: '/notices/pending',
    openapiPath: '/notices/pending',
    summary: 'The notices this person has not acknowledged, oldest first. An unknown person has none.',
    request: obj({ who: WHO }, ['who']),
    requestExample: { who: SEATED_WHO },
    answer: obj({ notices: { type: 'array', items: ref('Notice') } }, ['notices']),
    examples: [{ notices: [NOTICE_EXAMPLE] }, { notices: [] }],
  },
  {
    name: 'notices_ack',
    method: 'POST',
    path: '/notices/:id/ack',
    openapiPath: '/notices/{id}/ack',
    summary: 'This person has seen the notice. `ok: false` (still 200) for a notice that is not theirs or not there, so ids cannot be probed.',
    request: obj({ who: WHO }, ['who']),
    requestExample: { who: SEATED_WHO },
    answer: obj({ ok: { type: 'boolean' } }, ['ok']),
    examples: [{ ok: true }, { ok: false }],
  },
  {
    name: 'record',
    method: 'POST',
    path: '/record',
    openapiPath: '/record',
    summary: '"My record": the notices of the sanctions that still apply to this person, seen or not.',
    request: obj({ who: WHO }, ['who']),
    requestExample: { who: SEATED_WHO },
    answer: obj({ record: { type: 'array', items: ref('Notice') } }, ['record']),
    examples: [{ record: [NOTICE_EXAMPLE] }],
  },
  {
    name: 'restriction',
    method: 'POST',
    path: '/restriction',
    openapiPath: '/restriction',
    summary: 'Is this person chat-restricted now, until when and by what kind of restriction?',
    request: obj({ who: WHO, roomId: ID, seatId: ID }, ['who']),
    requestExample: { who: SEATED_WHO, roomId: 'lobby', seatId: 'a' },
    answer: obj({ restricted: { type: 'boolean' }, until: nullable('number'), kind: nullable('string') }, ['restricted', 'until', 'kind']),
    examples: [{ restricted: false, until: null, kind: null }, { restricted: true, until: 1_800_003_600_000, kind: 'chat' }],
  },
  {
    name: 'names_check',
    method: 'POST',
    path: '/names/check',
    openapiPath: '/names/check',
    summary: 'May a player use this name? The check a game runs when a name is chosen.',
    request: obj({ name: str(1, 64), kind: { enum: ['player', 'entity'] }, who: WHO }, ['name']),
    requestExample: { name: 'Plenk the Brave' },
    answer: { oneOf: [obj({ ok: okTrue }, ['ok']), obj({ ok: { const: false }, reason: str(1, 64), rule: { type: 'integer', minimum: 1 } }, ['ok', 'reason', 'rule'])] },
    examples: [{ ok: true }, { ok: false, reason: 'name_not_allowed', rule: 7 }],
  },
  {
    name: 'blocks_between',
    method: 'POST',
    path: '/blocks/between',
    openapiPath: '/blocks/between',
    summary: 'Has the first person blocked, or been blocked by, each of the others? Persons are found, never created: an unknown person is false. For matchmaking. At most 50 others.',
    request: obj({ who: WHO, others: { type: 'array', items: WHO, minItems: 1, maxItems: 50 } }, ['who', 'others']),
    requestExample: { who: SEATED_WHO, others: [{ clientKey: 'raw-client-key-0002' }] },
    answer: obj({ blocked: { type: 'array', items: { type: 'boolean' } } }, ['blocked']),
    examples: [{ blocked: [true, false] }],
  },
  {
    name: 'doors_check',
    method: 'POST',
    path: '/doors/check',
    openapiPath: '/doors/check',
    summary: 'The login and matchmaking check: may this person join, create, host publicly or queue? A refusal carries the kind, when it ends and the code to quote.',
    request: obj({ kind: { enum: ['join', 'create', 'public', 'matchmaking'] }, who: WHO }, ['kind', 'who']),
    requestExample: { kind: 'join', who: SEATED_WHO },
    answer: {
      oneOf: [
        obj({ ok: okTrue }, ['ok']),
        obj({ ok: { const: false }, refusal: obj({ kind: { enum: ['ban', 'area'] }, until: nullable('number'), refCode: str(0, 64), noticeId: str(1, 64) }, ['kind', 'until', 'refCode']) }, ['ok', 'refusal']),
      ],
    },
    examples: [{ ok: true }, { ok: false, refusal: { kind: 'ban', until: 1_800_003_600_000, refCode: 'CW-0042' } }],
  },
];

// ---- validation helpers -------------------------------------------------------------------------------------------------------

const TAG_KEY_RE = /^[a-z][a-z0-9_]{0,23}$/;
const MAX_TAGS = 8;
const TEXT_MAX = 2000;
const TOKEN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DOOR_KINDS: readonly string[] = ['join', 'create', 'public', 'matchmaking'];
const NAME_MAX = 64;
const MAX_OTHERS = 50;
const PHRASE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** The body as an object with only the allowed keys and all the required ones. No body is `{}` when nothing is required. Anything else is 400 `invalid_request`. */
function bodyOf(body: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  const value = body === undefined && required.length === 0 ? {} : body;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o)) if (!allowed.includes(key)) throw new ValidationError();
  for (const key of required) if (!Object.hasOwn(o, key)) throw new ValidationError();
  return o;
}

const text = (v: unknown, min: number, max: number): string => {
  if (typeof v !== 'string' || v.length < min || v.length > max) throw new ValidationError();
  return v;
};

/** An optional string of at most `max` characters: absent or null is none. */
const optionalText = (o: Record<string, unknown>, key: string, max: number): string | undefined => {
  if (!Object.hasOwn(o, key) || o[key] === null || o[key] === undefined) return undefined;
  return text(o[key], 1, max);
};

/** The room tags: at most 8, key `[a-z][a-z0-9_]{0,23}`, value 1 to 64 characters. The reserved `context` and `scope` are checked by the kit (400 too). */
function parseTags(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  const keys = Object.keys(value);
  if (keys.length > MAX_TAGS) throw new ValidationError();
  const tags: Record<string, string> = {};
  for (const key of keys) {
    if (!TAG_KEY_RE.test(key)) throw new ValidationError();
    tags[key] = text((value as Record<string, unknown>)[key], 1, 64);
  }
  return tags;
}

/** The most seats the service lets one room hold, and the most rooms one process holds. Past the seats a seat is refused; past the rooms the room idle the longest is closed. */
export const SERVICE_MAX_SEATS_PER_ROOM = 5000;
export const SERVICE_MAX_ROOMS = 10_000;

/**
 * A bounded tally of the rooms and seats this process seated through the API, oldest use first. It holds ids only to count them: who must not see a line comes from the kit's own roster
 * (`cw.chat.hiddenFor`), so there is no second copy that could drift. A room stays in the tally when its last seat leaves (the kit keeps the room's tags) until it is closed or evicted.
 */
class RoomTally {
  private readonly rooms = new Map<string, Set<string>>();
  private readonly maxSeats: number;
  private readonly maxRooms: number;
  constructor(maxSeats: number, maxRooms: number) {
    this.maxSeats = maxSeats;
    this.maxRooms = maxRooms;
  }
  /** Mark the room as just used (the least recently used room is evicted first). */
  touch(room: string): void {
    const seats = this.rooms.get(room);
    if (seats === undefined) return;
    this.rooms.delete(room);
    this.rooms.set(room, seats);
  }
  /** May this seat be added? A seat the room already holds may always change hands. */
  canSeat(room: string, seat: string): boolean {
    const seats = this.rooms.get(room);
    return seats === undefined || seats.has(seat) || seats.size < this.maxSeats;
  }
  /** Record a seat; returns the room evicted to make room for a new one, if any. */
  add(room: string, seat: string): string | undefined {
    let seats = this.rooms.get(room);
    let evicted: string | undefined;
    if (seats === undefined) {
      seats = new Set();
      this.rooms.set(room, seats);
      if (this.rooms.size > this.maxRooms) {
        const oldest = this.rooms.keys().next();
        if (oldest.done !== true) {
          evicted = oldest.value;
          this.rooms.delete(evicted);
        }
      }
    } else this.touch(room);
    seats.add(seat);
    return evicted;
  }
  remove(room: string, seat: string): void {
    this.rooms.get(room)?.delete(seat);
    this.touch(room);
  }
  clear(room: string): void {
    this.rooms.delete(room);
  }
}

const ok = (body: unknown): KitResponse => ({ status: 200, body });

/** What `serviceRoutes` hands the table: the options a handler reads. */
export interface RouteOptions {
  capabilities?: { phrases?: boolean; blocks?: boolean; contexts?: string[]; sharedPacing?: boolean; matchModes?: string[] };
  warnings?: () => string[];
  processes?: 'single' | 'multiple';
  logger?: { warn(event: string, detail?: Record<string, string | number | boolean>): unknown };
  /** Caps on the rooms and seats the service tracks. Defaults: `SERVICE_MAX_SEATS_PER_ROOM` and `SERVICE_MAX_ROOMS`. */
  limits?: { maxSeatsPerRoom?: number; maxRooms?: number };
}

const WARNING_RE = /^[a-z][a-z_]{0,31}$/;
const MATCH_MODES = ['word', 'segment', 'contains'];

/** The /v1 table over a kit: every description in `ROUTE_SPECS` wrapped by `svc` around its handler. */
export function buildServiceTable(cw: Chatwarden, svc: Svc, options: RouteOptions): RouteTable {
  const tally = new RoomTally(options.limits?.maxSeatsPerRoom ?? SERVICE_MAX_SEATS_PER_ROOM, options.limits?.maxRooms ?? SERVICE_MAX_ROOMS);
  const room = (c: ServiceCall): string => validId(c.params.room);
  const seat = (c: ServiceCall): string => validId(c.params.seat);

  const warningsFor = (plainHttp: boolean): string[] => {
    let given: unknown = [];
    try {
      given = options.warnings === undefined ? [] : options.warnings();
    } catch (err) {
      safeWarn(options.logger, 'chatwarden.service_warnings_failed', { error: errorClass(err) });
    }
    const out: string[] = [];
    if (Array.isArray(given)) for (const w of given as unknown[]) if (typeof w === 'string' && WARNING_RE.test(w) && !out.includes(w)) out.push(w);
    if (plainHttp && !out.includes('plain_http')) out.push('plain_http');
    return out;
  };

  /** The answer for a kit verdict on a line or a phrase: the line to send, and the seats that must NOT be sent it (they muted or blocked the sender, or the sender blocked them). Or the author's refusal. */
  const delivered = (roomId: string, seatId: string, result: ChatResult): KitResponse => {
    tally.touch(roomId);
    if (!('deliver' in result)) return ok({ ok: false, refused: lineRefusal(result.refuse) });
    const hiddenFor = cw.chat.hiddenFor(roomId, seatId);
    const { lineId, text, phrase } = result.deliver;
    return ok({ ok: true, line: { id: lineId, text, ...(typeof phrase === 'string' && phrase !== '' ? { phrase } : {}) }, hiddenFor });
  };

  const handlers: Record<string, ServiceHandler> = {
    handshake: ({ req }) => {
      const given = options.capabilities ?? {};
      const plain = (req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'http';
      return ok({
        api: SERVICE_API_VERSION,
        kit: VERSION,
        mode: 'service',
        processes: options.processes ?? 'single',
        capabilities: {
          phrases: given.phrases ?? cw.phrases.names().length > 0,
          blocks: given.blocks ?? true,
          contexts: given.contexts === undefined ? [...cw.contexts.names()] : [...given.contexts],
          sharedPacing: given.sharedPacing ?? false,
          matchModes: given.matchModes === undefined ? [...MATCH_MODES] : [...given.matchModes],
        },
        warnings: warningsFor(plain),
      });
    },

    seat: (c) => {
      const b = bodyOf(c.body, ['who', 'handle', 'tags'], ['who', 'handle']);
      const who = parseWho(b.who, { identity: true });
      const handle = text(b.handle, 1, 64);
      const tags = parseTags(b.tags);
      const roomId = room(c);
      const seatId = seat(c);
      if (!tally.canSeat(roomId, seatId)) throw new HttpError('invalid_value');
      try {
        cw.rooms.seat(roomId, seatId, who as RawWho, handle, tags);
      } catch (err) {
        // A reserved tag that is malformed, a context that cannot change, a handle the kit refuses: the request's fault, not the server's.
        if (err instanceof RangeError || err instanceof TypeError) throw new ValidationError();
        throw err;
      }
      const evicted = tally.add(roomId, seatId);
      if (evicted !== undefined) {
        // The room idle the longest makes way: closed in the kit like a DELETE. Class only in the log, never the room.
        cw.rooms.close(evicted);
        safeWarn(options.logger, 'chatwarden.service_room_evicted', { cap: options.limits?.maxRooms ?? SERVICE_MAX_ROOMS });
      }
      const r = cw.chat.restricted(who as RawWho, { roomId, seatId });
      return ok({ ok: true, restriction: r.restricted ? { until: r.until, kind: r.kind } : null });
    },

    unseat: (c) => {
      const roomId = room(c);
      const seatId = seat(c);
      cw.rooms.unseat(roomId, seatId);
      tally.remove(roomId, seatId);
      return ok({ ok: true });
    },

    close: (c) => {
      const roomId = room(c);
      cw.rooms.close(roomId);
      tally.clear(roomId);
      return ok({ ok: true });
    },

    lines: (c) => {
      const b = bodyOf(c.body, ['text'], ['text']);
      if (typeof b.text !== 'string') throw new ValidationError();
      const roomId = room(c);
      const seatId = seat(c);
      // Far too long to be a line: say so without asking the kit (which would say the same).
      if (b.text.length > TEXT_MAX) return ok({ ok: false, refused: { reason: 'length' } });
      return delivered(roomId, seatId, cw.chat.accept(roomId, seatId, b.text));
    },

    phrases: (c) => {
      const b = bodyOf(c.body, ['phraseId'], ['phraseId']);
      if (typeof b.phraseId !== 'string' || !PHRASE_ID_RE.test(b.phraseId)) throw new ValidationError();
      const roomId = room(c);
      const seatId = seat(c);
      return delivered(roomId, seatId, cw.chat.acceptPhrase(roomId, seatId, b.phraseId));
    },

    mutes_list: (c) => {
      const roomId = room(c);
      const seatId = seat(c);
      const all = cw.mutes.mutedSeats(roomId, seatId);
      const blocked = cw.mutes.blockedSeats(roomId, seatId);
      return ok({ muted: all.filter((s) => !blocked.includes(s)), blocked });
    },

    mutes_put: (c) => {
      const b = bodyOf(c.body, ['kind']);
      if (Object.hasOwn(b, 'kind') && b.kind !== 'mute' && b.kind !== 'block') throw new ValidationError();
      const roomId = room(c);
      const seatId = seat(c);
      const target = validId(c.params.target);
      const outcome = b.kind === 'block' ? cw.blocks.set(roomId, seatId, target, true) : cw.mutes.set(roomId, seatId, target, true);
      // The seat's list holds as many blocks as is allowed: nothing was written. Muting oneself or an empty seat is `none`: ok, and nothing.
      return ok(outcome === 'limit' ? { ok: false, limit: true } : { ok: true });
    },

    mutes_delete: (c) => {
      const roomId = room(c);
      const seatId = seat(c);
      const target = validId(c.params.target);
      cw.mutes.set(roomId, seatId, target, false);
      return ok({ ok: true });
    },

    reports: async (c) => {
      const b = bodyOf(c.body, ['target', 'lineId', 'reason', 'note', 'entity'], ['target']);
      const target = validId(b.target);
      let entity: ReportEntity | undefined;
      if (b.entity !== undefined && b.entity !== null) {
        // The shape is the kit's to judge (`entity_invalid`, before anything is spent); only a non-object is turned away here.
        if (typeof b.entity !== 'object' || Array.isArray(b.entity)) throw new ValidationError();
        entity = b.entity as ReportEntity;
      }
      const lineId = optionalText(b, 'lineId', 64);
      if (lineId !== undefined && !TOKEN_RE.test(lineId)) throw new ValidationError();
      const reason = optionalText(b, 'reason', 64);
      const note = optionalText(b, 'note', 500);
      const res = await cw.reports.submit({
        roomId: room(c),
        reporterSeat: seat(c),
        targetSeat: target,
        ...(lineId === undefined ? {} : { lineId }),
        ...(reason === undefined ? {} : { reason }),
        ...(note === undefined ? {} : { note }),
        ...(entity === undefined ? {} : { entity }),
      });
      if (!res.ok && res.refused === 'entity_invalid') throw new ValidationError();
      if (res.ok) return ok({ ok: true, remaining: res.remaining, ...(res.detailUntil === undefined ? {} : { detailUntil: res.detailUntil }) });
      return ok({ ok: false, refused: res.refused, ...(res.remaining === undefined ? {} : { remaining: res.remaining }) });
    },

    notices_pending: (c) => {
      const who = parseWho(bodyOf(c.body, ['who'], ['who']).who, { identity: true });
      return ok({ notices: cw.notices.pending(who as RawWho) });
    },

    notices_ack: (c) => {
      const who = parseWho(bodyOf(c.body, ['who'], ['who']).who, { identity: true });
      return ok({ ok: cw.notices.ack(who as RawWho, c.params.id as string) });
    },

    record: (c) => {
      const who = parseWho(bodyOf(c.body, ['who'], ['who']).who, { identity: true });
      return ok({ record: cw.notices.record(who as RawWho) });
    },

    restriction: (c) => {
      const b = bodyOf(c.body, ['who', 'roomId', 'seatId'], ['who']);
      const who = parseWho(b.who, { identity: true });
      const roomId = b.roomId === undefined ? undefined : validId(b.roomId);
      const seatId = b.seatId === undefined ? undefined : validId(b.seatId);
      const r = cw.chat.restricted(who as RawWho, { roomId: roomId ?? null, seatId: seatId ?? null });
      return ok({ restricted: r.restricted, until: r.until, kind: r.kind });
    },

    names_check: (c) => {
      const b = bodyOf(c.body, ['name', 'kind', 'who'], ['name']);
      const name = text(b.name, 1, NAME_MAX);
      if (Object.hasOwn(b, 'kind') && b.kind !== 'player' && b.kind !== 'entity') throw new ValidationError();
      const who: ServiceWho | undefined = b.who === undefined ? undefined : parseWho(b.who);
      const r = cw.names.check(name, { ...(who === undefined ? {} : { who: who as RawWho }), ...(b.kind === undefined ? {} : { kind: b.kind as NameKind }) });
      return ok(r.ok ? { ok: true } : { ok: false, reason: r.reason, rule: r.rule });
    },

    blocks_between: (c) => {
      const b = bodyOf(c.body, ['who', 'others'], ['who', 'others']);
      const who = parseWho(b.who, { identity: true });
      if (!Array.isArray(b.others) || b.others.length < 1 || b.others.length > MAX_OTHERS) throw new ValidationError();
      const others = (b.others as unknown[]).map((o) => parseWho(o, { identity: true }));
      return ok({ blocked: cw.blocks.anyBetween(who as RawWho, others as RawWho[]) });
    },

    doors_check: (c) => {
      const b = bodyOf(c.body, ['kind', 'who'], ['kind', 'who']);
      if (typeof b.kind !== 'string' || !DOOR_KINDS.includes(b.kind)) throw new ValidationError();
      const who = parseWho(b.who, { identity: true });
      const refusal = cw.doors.check(b.kind as DoorKind, who as RawWho);
      return ok(refusal === null ? { ok: true } : { ok: false, refusal: doorRefusal(refusal) });
    },
  };

  const table: RouteTable = {};
  for (const spec of ROUTE_SPECS) {
    const handler = handlers[spec.name];
    if (handler === undefined) throw new Error(`service: route ${spec.name} has no handler`);
    const key = `${spec.method} ${spec.path}`;
    table[key] = svc(key, handler, spec.idempotent === true ? { idempotent: true } : {});
  }
  return table;
}

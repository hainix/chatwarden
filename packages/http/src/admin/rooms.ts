import { NotFoundError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminContext } from './context.js';
import { bodyObject, bodyRetract, bodyRoomMode, lineParam, optionalBody, roomParam } from './validate.js';

/**
 * The rooms-under-attack routes (0.2.0, `@experimental`). A mode and a retraction are per process (the kit holds them in memory, like the pace): a game with several processes mounts the staff API on the
 * process that serves the room. Every body is `no-store`; nothing here carries a seat, a handle or a line's text.
 *
 * - `GET /rooms` (`rooms.read`, a moderator's by default): `{ rooms: [{ roomId, tags, seated, mode, until }] }`, the rooms this process knows (seated players, or a mode set), up to 500, the most seated first.
 *   No audit row.
 * - `POST /rooms/:room/mode { mode, forMs? }` (`rooms.manage`): put the room in `normal`, `locked` or `emergency`; every mode but normal ends by itself after `forMs` (60 000 to 86 400 000) or the profile's
 *   `rooms.defaultModeMs`. 200 `{ mode, since, until }`. 400 `invalid_mode`, `invalid_value` (a bad length) or `invalid_request` (a bad room id, key or shape). The audit row `room.mode` (the room as target,
 *   by `roomAuditRef`) is `required` and is written BEFORE the change, for `normal` too: a failing audit write fails the call (500) and changes nothing. A mode is never a sanction.
 * - `POST /rooms/:room/lines/:line/retract { allFromAuthor? }` (`rooms.manage`): take a line (or every delivered line of its author still in the evidence buffer) back for everyone, keeping it as evidence. 200
 *   `{ count }`. 404 `not_found` for a line that is too old, gone, already taken back or unknown (one body for all). The audit row `room.retract` is `required` and written before the retraction, so a
 *   call that finds nothing still leaves the attempt on the trail.
 */
export function roomRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /rooms': ctx.secure('rooms.read', () => ({ status: 200, body: { rooms: cw.rooms.list() } })),

    'POST /rooms/:room~room/mode': ctx.secure('rooms.manage', (c) => {
      const room = roomParam(c.params.room);
      const { mode, forMs } = bodyRoomMode(bodyObject(c.req));
      // The trail first: a change nobody can answer for is not made.
      c.audit('room.mode', { type: 'room', ref: cw.audit.roomRef(room) }, 'required');
      const state = cw.rooms.setMode(room, mode, forMs === undefined ? undefined : { forMs });
      return { status: 200, body: { mode: state.mode, since: state.since, until: state.until } };
    }),

    'POST /rooms/:room~room/lines/:line/retract': ctx.secure('rooms.manage', (c) => {
      const room = roomParam(c.params.room);
      const line = lineParam(c.params.line);
      const { allFromAuthor } = bodyRetract(optionalBody(c.req));
      c.audit('room.retract', { type: 'room', ref: cw.audit.roomRef(room) }, 'required');
      const res = cw.rooms.retract(room, line, { allFromAuthor });
      if (!res.ok) throw new NotFoundError();
      return { status: 200, body: { count: res.lineIds.length } };
    }),
  };
}

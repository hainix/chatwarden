import { GAME_KINDS, isGameKind, recommendFor } from '@chatwarden/core';
import type { GameKind } from '@chatwarden/core';
import { HttpError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminCall, AdminContext } from './context.js';
import { answer, bodyReason, bodyVersion } from './policyProfile.js';
import { bodyObject, has, optionalBody } from './validate.js';

/** The owner's, compared in code: a `permissions` override cannot lower it (the routes sit behind `policy.read` only to be signed-in staff). */
const requireOwner = (c: AdminCall): void => {
  if (c.authz.role !== 'owner') throw new HttpError('forbidden');
};

/** `{ game, version, reason? }` and nothing else, else 400 `invalid_request`. */
function bodyApply(body: Record<string, unknown>): { game: GameKind; version: number; reason: string } {
  for (const k of Object.keys(body)) if (k !== 'game' && k !== 'version' && k !== 'reason') throw new ValidationError();
  const { game } = body;
  if (!isGameKind(game)) throw new ValidationError();
  const version = bodyVersion(body.version);
  const reason = has(body, 'reason') ? bodyReason(body.reason) : `Applied the recommended principles for ${game} games`;
  return { game, version, reason };
}

/**
 * The first-run setup routes (0.2.2): the owner's, fixed in code (a `permissions` option cannot lower them), and not scope-aware (a scoped caller is 403).
 * Every body is `no-store`. They are the hub's "choose your kind of game" panel: it shows until the team has saved a setting or dismissed it.
 *
 * - `GET /setup`: `{ show, dismissedAt, persists, version, options }`. `show` is true only when the store can save settings, nothing was ever saved and the panel
 *   was not dismissed; `dismissedAt` is when it was (a number) or null; `persists` says whether a dismissal survives a restart; `version` is the stored policy version
 *   (what `POST /setup/apply` must send). `options` is the four recommendations in order (`competitive`, `social`, `kids`, `creator`), each `{ game, preset, layer }`
 *   (the layer is what a choice would save), while `show` is true and `[]` otherwise. Writes no audit row.
 * - `POST /setup/dismiss` (body absent or `{}`; any other key is 400 `invalid_request`): `{ ok: true, show: false, dismissedAt, persists }`. The first dismissal is kept.
 *   Changes no policy, so it writes no audit row.
 * - `POST /setup/apply { game, version, reason? }` (exactly these keys, else 400 `invalid_request`; `game` one of the four, `version` a whole number from 0, `reason` text,
 *   default `Applied the recommended principles for <game> games`): save the recommendation for that kind of game as one layer, keeping every other section. It
 *   answers as `PUT /policy/profile` does (200 `{ ok, changed, effective, base, layer, version, canSave, limits, promptExcluded }`, where `changed` names only the sections that
 *   differ from the profile in code; 409 `conflict` for a stale `version`; 501 `not_supported`; 400 `invalid_profile` with a `path`) and audits `policy.update` with the
 *   sections changed and the reason, best-effort.
 */
export function setupRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;
  return {
    'GET /setup': ctx.secure('policy.read', (c) => {
      requireOwner(c);
      // Look at the store now, so a layer another process saved hides the panel and the version is the stored one.
      cw.policy.refresh();
      const state = cw.policy.setup();
      return { status: 200, body: { ...state, version: cw.policy.get().version, options: state.show ? GAME_KINDS.map(recommendFor) : [] } };
    }),

    'POST /setup/dismiss': ctx.secure('policy.read', (c) => {
      requireOwner(c);
      if (Object.keys(optionalBody(c.req)).length > 0) throw new ValidationError();
      const state = cw.policy.dismissSetup();
      return { status: 200, body: { ok: true, ...state } };
    }),

    'POST /setup/apply': ctx.secure('policy.read', (c) => {
      requireOwner(c);
      const { game, version, reason } = bodyApply(bodyObject(c.req));
      // The actor is never from the body: it is who the auth hook says.
      const res = cw.policy.applyRecommendation(game, { version, actor: c.authz.actor, reason });
      return answer(cw, res, (changed) =>
        // The change is stored: an audit failure is logged, never turned into an error.
        c.audit('policy.update', undefined, 'best-effort', { sections: changed, reason }),
      );
    }),
  };
}

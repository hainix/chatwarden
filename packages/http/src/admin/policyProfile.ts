import { POLICY_SECTIONS } from '@chatwarden/core';
import type { Chatwarden, PolicyLayer, PolicySaveResult, PolicySection } from '@chatwarden/core';
import { HttpError, LayerInvalidError, ValidationError } from '../errors.js';
import type { RouteTable } from '../router.js';
import type { AdminCall, AdminContext } from './context.js';
import { asObject, bodyObject, bodyRule, bodyText, has } from './validate.js';

/** A body `version`: a whole number from 0 (0 is "nothing stored yet"), else 400. */
function bodyVersion(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new ValidationError();
  return v;
}

/** A body `layer`: a plain object, else 400. What is in it is the core's to check (`invalid_profile` with a path). */
function bodyLayer(v: unknown): PolicyLayer {
  const layer = asObject(v);
  if (layer === undefined) throw new ValidationError();
  return layer as PolicyLayer;
}

/** A reason: text of 1 to 2000 characters once trimmed, else 400. */
function bodyReason(v: unknown): string {
  const reason = bodyText(v);
  if (reason.trim() === '') throw new ValidationError();
  return reason;
}

/**
 * What the core answered, as the route answers it: 409, 501 or 400 with the path, or the success body after `onOk`. The success
 * body is `{ ok, changed }` and the fresh state in the shape of `GET /policy/profile` (`effective`, `base`, `layer`, `version`,
 * `canSave`), so a screen needs no follow-up read.
 */
function answer(cw: Chatwarden, res: PolicySaveResult, onOk: (changed: PolicySection[]) => void) {
  if (!res.ok) {
    if ('path' in res) throw new LayerInvalidError(res.path);
    throw new HttpError(res.error === 'unsupported' ? 'not_supported' : 'conflict');
  }
  onOk(res.changed);
  return { status: 200, body: { ok: true, changed: res.changed, ...cw.policy.get(), version: res.version } };
}

/**
 * The editable moderation profile (the lengths offered, the ladder, the first offences, the repeat rule, the area and severe
 * rules, the guideline outcome texts, the reporting settings: the flow, the reasons and the thank-you, the AI level and the pace settings: slow mode, burst and repeats). The profile in code is the base; the owner's edits are a versioned layer in the
 * adopter's store, and what is in force is the base with the layer on top (`cw.policy`). All JSON, all no-store.
 *
 * - `GET /policy/profile` (`policy.read`, audited as `policy.view`): `{ effective, base, layer, version, canSave }`, plus
 *   `layerError` (`{ path }`) when the stored layer cannot be used and is being ignored, and `dropped` (`[{ feed, reason }]`, codes only)
 *   when a stored signal feed could no longer be used: `layer` is then the layer in force, without it. It looks at the store first, so it is
 *   never up to 10 seconds behind. `canSave` false means the store cannot save settings (the profile stays code-only).
 * - `PUT /policy/profile { layer, version, reason }` (`policy.write`, owner only by default): replace the stored layer, the WHOLE
 *   layer (a section left out is reset). 200 `{ ok, changed, effective, base, layer, version, canSave }` (the fresh state, as GET answers it); 409 `conflict` when `version` is no longer the stored
 *   one (reload and merge); 400 `invalid_profile` with `path` for a layer that touches a setting that is not editable (profanity
 *   stays in code) or would make the profile invalid; 400 `invalid_request` for a bad body; 501 `not_supported` for a store that
 *   cannot save. Audits `policy.update` with the sections changed and the reason (never the values).
 * - `POST /policy/profile/preview { layer, rule? }` (`policy.read`, no audit row): `{ samples }`, what the candidate layer would
 *   suggest for the sample records `clean`, `oneWarning`, `chat24h` and `ban7d` at each conduct level, as `{ label, kind,
 *   durationMs }`, plus `reporting`: what players would read of the candidate's reporting settings (the enabled reasons, with no rule
 *   mapping, the flow and the thank-you). Saves nothing. `rule` (a Community Rule number) shows the area and severe rules taking effect.
 * - `DELETE /policy/profile?section=` (`policy.write`): reset one editable section (`durations`, `customDuration`, `ladder`,
 *   `firstOffense`, `repeat`, `areaRules`, `severeRules`, `guidelines`, `reporting`, `ai`, `pace`), or with no `section` everything. An optional body
 *   `{ reason, version? }` (the reason is required, as for PUT): a `version` that is stale is 409. Audits `policy.reset` with the
 *   sections changed and the reason. An unknown or empty `section` is 400 `invalid_query`.
 */
export function policyProfileRoutes(ctx: AdminContext): RouteTable {
  const { cw } = ctx;

  const audited = (c: AdminCall, action: 'policy.update' | 'policy.reset', reason: string | undefined) => (changed: PolicySection[]) =>
    // The change is stored: an audit failure is logged, never turned into an error.
    c.audit(action, undefined, 'best-effort', { sections: changed, ...(reason === undefined ? {} : { reason }) });

  return {
    'GET /policy/profile': ctx.secure('policy.read', (c) => {
      // Look at the store now: the screen that edits must start from the stored version, not one up to 10 seconds old.
      cw.policy.refresh();
      const state = cw.policy.get();
      c.audit('policy.view');
      return { status: 200, body: state };
    }),

    'PUT /policy/profile': ctx.secure('policy.write', (c) => {
      const body = bodyObject(c.req);
      const layer = bodyLayer(body.layer);
      const version = bodyVersion(body.version);
      const reason = bodyReason(body.reason);
      // The actor is never from the body: it is who the auth hook says.
      const res = cw.policy.save(layer, { version, actor: c.authz.actor, reason });
      return answer(cw, res, audited(c, 'policy.update', reason));
    }),

    'POST /policy/profile/preview': ctx.secure('policy.read', (c) => {
      const body = bodyObject(c.req);
      const layer = bodyLayer(body.layer);
      const rule = has(body, 'rule') ? bodyRule(body.rule) : undefined;
      const res = cw.policy.preview(layer, rule);
      if (!res.ok) throw new LayerInvalidError(res.path);
      return { status: 200, body: { samples: res.samples, reporting: res.reporting } };
    }),

    'DELETE /policy/profile': ctx.secure('policy.write', (c) => {
      const raw = c.req.query.section;
      if (raw !== undefined && !(POLICY_SECTIONS as readonly string[]).includes(raw)) throw new HttpError('invalid_query');
      const section = raw as PolicySection | undefined;
      const body = bodyObject(c.req);
      const reason = bodyReason(body.reason);
      const version = has(body, 'version') ? bodyVersion(body.version) : undefined;
      const res = cw.policy.reset(section, version === undefined ? {} : { version });
      return answer(cw, res, audited(c, 'policy.reset', reason));
    }),
  };
}

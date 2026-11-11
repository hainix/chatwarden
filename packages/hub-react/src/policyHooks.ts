import { useRef, useState } from 'react';
import { toHubError } from './client.js';
import { useHub } from './context.js';
import type { HubRead } from './embedHooks.js';
import type { ActionResult } from './headless/env.js';
import { useHubAction, useHubData } from './hooks.js';
import type { PolicyLayer, PolicySaved, PolicySamples, PolicySection, PolicyState } from './types.js';

/**
 * The steps and ladder: what is in force, what is saved, and how to change it.
 * @experimental
 */
export interface UsePolicy extends HubRead<PolicyState> {
  /** The role may change the settings and the store can keep them (`policy.write` and the kit's `canSave`). False until they are read. */
  canEdit: boolean;
  /** A save or a reset is on its way. */
  busy: boolean;
  /**
   * What a layer would suggest for the sample records (`clean`, `oneWarning`, `chat24h`, `ban7d`) at each conduct level, saving nothing.
   * `rule` is a Community Rule number, so area and severe rules show. A layer the kit refuses is `{ ok: false }` with the field `path`.
   */
  preview: (layer: PolicyLayer, rule?: number) => Promise<ActionResult<PolicySamples>>;
  /**
   * Replace the saved layer (a section left out goes back to the profile in code), against the version last read. A 409 `conflict` means
   * someone else saved first: `reload()` and merge. A refused layer is a 400 `invalid_profile` with `error.path`. On success the state
   * is updated, and the hub's remembered rules are dropped so the next decision form reads the new profile.
   */
  save: (layer: PolicyLayer, reason: string) => Promise<ActionResult<PolicySaved>>;
  /** Reset the given sections (none: everything) to the profile in code, with the reason the audit trail keeps. */
  reset: (sections: PolicySection | readonly PolicySection[] | undefined, reason: string) => Promise<ActionResult<PolicySaved>>;
}

const hasState = (r: PolicySaved): r is PolicySaved & PolicyState => typeof r.effective === 'object' && r.effective !== null && typeof r.base === 'object' && r.base !== null && typeof r.layer === 'object';

/**
 * The steps and ladder (`GET /policy/profile`, which the server audits on every call): read once when it is first used and again after
 * a save or a reset, never on a timer. Needs `policy.read`; changing it needs `policy.write`. Nothing is asked of a role without
 * `policy.read` (`allowed` is false).
 *
 * ```tsx
 * const { data, canEdit, save } = usePolicy();
 * return <p>{data?.effective.durations?.length ?? 0} lengths{canEdit ? ' (you can change them)' : ''}</p>;
 * ```
 * @experimental
 */
export function usePolicy(): UsePolicy {
  const { client, can, session } = useHub();
  const allowed = can('policy.read');
  const read = useHubData<PolicyState | null>(allowed ? 'policy:profile' : 'policy:profile:idle', () => (allowed ? client.policyProfile() : Promise.resolve(null)));
  // A save or reset that answers with the new state hands it over at once; one that does not makes the screen read it again.
  const [kept, setKept] = useState<{ source: PolicyState | null | undefined; state: PolicyState } | null>(null);
  const data = kept !== null && kept.source === read.data ? kept.state : (read.data ?? undefined);
  const latest = useRef(data);
  latest.current = data;

  const after = (res: PolicySaved): void => {
    session.invalidatePolicy();
    if (hasState(res)) setKept({ source: read.data, state: { effective: res.effective, base: res.base, layer: res.layer, version: res.version, canSave: res.canSave, ...(res.layerError === undefined ? {} : { layerError: res.layerError }) } });
    else read.reload();
  };

  const saving = useHubAction(async (layer: PolicyLayer, reason: string) => {
    const res = await client.savePolicyProfile({ layer, version: latest.current?.version ?? 0, reason });
    after(res);
    return res;
  });
  const resetting = useHubAction(async (sections: readonly (PolicySection | undefined)[], reason: string) => {
    let last: PolicySaved | undefined;
    for (const section of sections) {
      last = await client.resetPolicyProfile({ ...(section === undefined ? {} : { section }), reason });
    }
    if (last === undefined) throw new Error('nothing to reset');
    after(last);
    return last;
  });

  return {
    allowed,
    data,
    error: allowed ? read.error : null,
    loading: allowed && read.loading,
    reload: read.reload,
    canEdit: can('policy.write') && data?.canSave === true,
    busy: saving.busy || resetting.busy,
    preview: async (layer, rule) => {
      try {
        const res = await client.previewPolicyProfile({ layer, ...(rule === undefined ? {} : { rule }) });
        return { ok: true, value: res.samples };
      } catch (e) {
        return { ok: false, error: toHubError(e) };
      }
    },
    save: (layer, reason) => saving.run(layer, reason),
    reset: (sections, reason) => resetting.run(Array.isArray(sections) ? sections : [sections as PolicySection | undefined], reason),
  };
}

import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';
import type { HubData } from '../hooks.js';
import type { SetupState } from '../types.js';

/**
 * The first-run state (`GET /setup`), asked ONLY of the owner (a role that may change the settings): anyone else sends nothing and gets nothing. While the request is on its way, when it failed
 * and when there is nothing to offer, `state` is null, so the panel draws nothing at all. Read once for a mount and again on `reload()`.
 */
export function useSetup(): { allowed: boolean; state: SetupState | null; reload: () => void } {
  const { client, me, can } = useHub();
  const allowed = me.role === 'owner' && can('policy.write');
  const read: HubData<SetupState | null> = useHubData<SetupState | null>(allowed ? 'setup' : 'setup:idle', () => (allowed ? client.setup() : Promise.resolve(null)));
  const state = allowed && read.data != null && read.data.show && read.data.options.length > 0 ? read.data : null;
  return { allowed, state, reload: read.reload };
}

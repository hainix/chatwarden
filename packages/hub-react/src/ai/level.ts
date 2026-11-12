import { useHub } from '../context.js';
import { useHubData } from '../hooks.js';

/**
 * The AI level the hub is set to (0 off, 1 read, 2 recommend), from the policy the hub already keeps for its decision forms (one read, shared).
 * 0 for a role that cannot read the policy. What the shortcut sheet uses to list the AI's keys only where they exist.
 */
export function useAiLevel(): number {
  const { can, session } = useHub();
  const allowed = can('policy.read');
  const policy = useHubData(allowed ? 'policy' : 'policy:idle', () => (allowed ? session.policy() : Promise.resolve(null)));
  return (policy.data?.profile as { ai?: { level?: number } } | undefined)?.ai?.level ?? 0;
}

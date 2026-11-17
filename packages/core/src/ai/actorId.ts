/** The audit trail takes an actor of at most 128 characters of `A-Za-z0-9_.:@+-`. */
const ACTOR_MAX = 128;

/** The audit actor for the AI: `ai:` and the adapter's id with every character the trail refuses made an underscore, cut to fit. */
export function aiActorOf(adapterId: string): string {
  const id = String(adapterId).replace(/[^A-Za-z0-9_.:@+-]/gu, '_').slice(0, ACTOR_MAX - 'ai:'.length);
  return `ai:${id === '' ? 'adapter' : id}`;
}

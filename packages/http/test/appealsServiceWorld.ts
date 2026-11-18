import { serviceRoutes } from '../src/service/index.js';
import type { ServiceOptions } from '../src/service/index.js';
import { ALICE, BOB, CAROL, HOUR, playerWorld } from './playerWorld.js';
import type { PlayerWorldOptions } from './playerWorld.js';
import { callerOver, KEY_A, KEY_B } from './serviceKit.js';
import type { CallOptions } from './serviceKit.js';
import type { KitResponse } from '../src/types.js';

// The service API (/v1) over the player world's kit (a real SQLite store, appeals on, real sanctions): for the appeal routes, the notice links and the door refusal links.

export const LANDING = 'https://game.example/appeal';
export { ALICE, BOB, CAROL, HOUR };

export interface AppealsServiceOptions extends PlayerWorldOptions {
  /** `false`: no `appeals.landingUrl` (no link can be made). Default: the landing options. */
  landing?: { landingUrl?: string; landingOrigins?: string[] } | false;
  service?: Partial<ServiceOptions>;
}

export async function appealsServiceWorld(over: AppealsServiceOptions = {}) {
  const landing = over.landing === undefined ? { landingUrl: LANDING, landingOrigins: ['https://game.example'] } : over.landing;
  const w = await playerWorld({ ...over, kit: { ...(landing === false ? {} : { appeals: landing }), ...(over.kit ?? {}) } });
  const routes = serviceRoutes(w.cw, { keys: [KEY_A, KEY_B], now: () => w.clock.t, logger: { warn: (event, detail) => void w.logged.push([event, detail]) }, rateLimit: { max: 1_000_000, windowMs: 10_000 }, ...over.service });
  const base = callerOver(routes);
  const recorded: Array<{ method: string; path: string; status: number; body: unknown }> = [];
  const call = async (method: string, path: string, o?: CallOptions): Promise<KitResponse> => {
    const res = await base(method, path, o);
    recorded.push({ method, path, status: res.status, body: JSON.parse(JSON.stringify(res.body ?? null)) });
    return res;
  };
  const tokenOf = (url: string): string => new URL(url).searchParams.get('t') as string;
  /** A service identity from a player of the world. */
  const idOf = (who: { clientKey?: string; accountId?: string; ip?: string | null }) => ({
    ...(who.clientKey === undefined ? {} : { clientKey: who.clientKey }),
    ...(who.accountId === undefined ? {} : { accountId: who.accountId }),
  });
  return { ...w, svcRoutes: routes, call, recorded, tokenOf, idOf };
}

export type AppealsServiceWorld = Awaited<ReturnType<typeof appealsServiceWorld>>;

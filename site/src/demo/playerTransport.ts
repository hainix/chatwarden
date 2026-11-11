// The player side of the demo. In a real game the player components (@chatwarden/player-react) call the kit's player routes over
// HTTP. Those routes read a request's headers and use Node's crypto, so they do not run in a visitor's browser, and the kit has
// no player route for filing a report (your server calls `cw.reports.submit` behind its own route). So the demo gives the
// components a small local transport that answers the same four calls from the kit directly, for one seat. It speaks the
// routes' shapes (`{ notices }`, `{ ok }`, `{ record }`), so the components cannot tell the difference.
import type { Transport, TransportRequest, TransportResponse } from '@chatwarden/player-react';
import type { DemoEngine } from './engine';

const json = (status: number, body: unknown): TransportResponse => ({ status, headers: { 'content-type': 'application/json' }, body });
const notFound = (): TransportResponse => json(404, { error: 'not_found', message: 'No such route.' });

/** The player routes for one seat, answered by the kit behind `engine`. Everything it reads is that seat's own. */
export function seatTransport(engine: Pick<DemoEngine, 'notices'>, seat: string): Transport {
  return async (req: TransportRequest): Promise<TransportResponse> => {
    if (req.method === 'GET' && req.path === '/notices') return json(200, { notices: await engine.notices.pending(seat) });
    if (req.method === 'GET' && req.path === '/record') return json(200, { record: await engine.notices.record(seat) });
    const ack = req.method === 'POST' ? /^\/notices\/([^/]+)\/ack$/.exec(req.path) : null;
    if (ack !== null) return json(200, { ok: await engine.notices.ack(seat, decodeURIComponent(ack[1] as string)) });
    return notFound();
  };
}

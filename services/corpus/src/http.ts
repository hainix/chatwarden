// Response and request helpers shared by the routes. Every answer is JSON, never cached, never sniffed, and carries no CORS header: this is a
// server-to-server API, so a browser page cannot call it.

const HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
} as const;

export function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
}

export const notFound = (): Response => json(404, { error: 'not_found' });
export const unauthorized = (): Response => json(401, { error: 'unauthorized' });
export const internal = (): Response => json(500, { error: 'internal' });
export const methodNotAllowed = (allow: string): Response => json(405, { error: 'method_not_allowed' }, { allow });
export const tooMany = (seconds: number): Response => json(429, { error: 'rate_limited' }, { 'retry-after': String(Math.max(1, Math.ceil(seconds))) });

/** Whether the request says it carries JSON (a parameter such as charset is allowed). */
export function isJson(request: Request): boolean {
  return /^application\/json\s*(;.*)?$/i.test(request.headers.get('content-type') ?? '');
}

/** The body, or null when it is over `max` bytes. It stops reading at the cap, and trusts a length header only to refuse early. */
export async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > max) return null;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

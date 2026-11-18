import type { KitRequest } from './types.js';

/** The most proxies `trustProxy` may name: more than this in front of a game server is a mistake in the setting. */
export const TRUST_PROXY_MAX = 10;

/** What an address from a forwarding header may look like: an IPv4 or IPv6 address (IPv4-mapped included), no port, no brackets, no zone. */
const ADDRESS_RE = /^[0-9A-Fa-f:.]{2,45}$/;
const HEADER_MAX = 400;

/** `RangeError` naming `label` (never the value) unless `value` is undefined or a whole number from 0 to 10. 0 and undefined both mean "no proxy". */
export function checkTrustProxy(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > TRUST_PROXY_MAX) throw new RangeError(`${label} must be a whole number from 0 to ${TRUST_PROXY_MAX}`);
  return value;
}

/**
 * The address of the person behind a request, or undefined when it is not known.
 *
 * With no proxy setting (`trustProxy` undefined or 0) it is the socket peer (`remoteAddress`) and never a header: a client can write any
 * header. With `trustProxy` = N, N proxies of your own sit in front of the server, and each appends the address it saw to `X-Forwarded-For`,
 * so the person is the N-th entry from the right (the entries to the left of that are whatever the client claimed, and are never read). When
 * the header is missing, has fewer than N entries or the entry is not an address, the answer is undefined: never the proxy's own address,
 * which would put every person in one bucket.
 */
export function clientAddressOf(req: KitRequest, trustProxy: number | undefined): string | undefined {
  if (trustProxy === undefined || trustProxy === 0) return typeof req.remoteAddress === 'string' && req.remoteAddress !== '' ? req.remoteAddress : undefined;
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw !== 'string' || raw.length > HEADER_MAX) return undefined;
  const entries = raw.split(',');
  if (entries.length < trustProxy) return undefined;
  const entry = (entries[entries.length - trustProxy] ?? '').trim();
  return ADDRESS_RE.test(entry) ? entry : undefined;
}

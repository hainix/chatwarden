import { isIP } from 'node:net';
import type { KitRequest } from './types.js';

/** The most proxies `trustProxy` may name: more than this in front of a game server is a mistake in the setting. */
export const TRUST_PROXY_MAX = 10;

/** One entry with a port: `203.0.113.7:443` (some cloud balancers write it). */
const IPV4_PORT_RE = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/;
/** `[2001:db8::7]` and `[2001:db8::7]:443`: the brackets and the port are dropped. */
const BRACKETED_RE = /^\[([0-9A-Fa-f:.]+)\](?::\d{1,5})?$/;
const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const MAPPED_RE = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

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
 * so the person is the N-th entry from the right (the entries to the left of that are whatever the client claimed, and are never read, however
 * many or however long: the scan starts at the right end and stops after N entries). When the header is missing, has fewer than N entries or
 * the entry is not an address, the answer is undefined: never the proxy's own address, which would put every person in one bucket. A port
 * after the address (`ip:port`, `[v6]:port`) is dropped, so one person is one address.
 */
export function clientAddressOf(req: KitRequest, trustProxy: number | undefined): string | undefined {
  if (trustProxy === undefined || trustProxy === 0) return typeof req.remoteAddress === 'string' && req.remoteAddress !== '' ? req.remoteAddress : undefined;
  const raw = req.headers['x-forwarded-for'];
  if (typeof raw !== 'string') return undefined;
  let end = raw.length;
  let entry = '';
  for (let i = 0; i < trustProxy; i++) {
    if (end < 0) return undefined; // fewer than N entries
    const comma = end === 0 ? -1 : raw.lastIndexOf(',', end - 1);
    entry = raw.slice(comma + 1, end);
    end = comma;
  }
  return bareAddress(entry.trim());
}

/** The address in one header entry (a port and brackets removed), or undefined when it is not an address. */
function bareAddress(entry: string): string | undefined {
  const address = BRACKETED_RE.exec(entry)?.[1] ?? IPV4_PORT_RE.exec(entry)?.[1] ?? entry;
  return !address.includes('%') && isIP(address) !== 0 ? address : undefined; // an IPv4 or IPv6 address (IPv4-mapped included), no zone
}

/** The eight 16-bit groups of an IPv6 address (no zone, no embedded IPv4), or undefined when it is not one. */
function groupsOf(address: string): number[] | undefined {
  if (!/^[0-9A-Fa-f:]{2,39}$/.test(address) || address.includes(':::')) return undefined;
  const halves = address.split('::');
  if (halves.length > 2) return undefined;
  const side = (text: string): number[] | undefined => {
    if (text === '') return [];
    const parts = text.split(':');
    return parts.every((p) => /^[0-9A-Fa-f]{1,4}$/.test(p)) ? parts.map((p) => Number.parseInt(p, 16)) : undefined;
  };
  const head = side(halves[0] ?? '');
  const tail = halves.length === 2 ? side(halves[1] ?? '') : [];
  if (head === undefined || tail === undefined) return undefined;
  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const missing = 8 - head.length - tail.length;
  return missing < 1 ? undefined : [...head, ...new Array<number>(missing).fill(0), ...tail];
}

/**
 * True for a loopback, private or link-local address: 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 0.0.0.0, `::1`, `::`,
 * fc00::/7 and fe80::/10 (an IPv4-mapped IPv6 form of any of these, and a `%zone` suffix, included). A socket peer like this, with no proxy setting, is
 * almost always your own reverse proxy, so it cannot tell people apart. Anything that is not an address is false.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.split('%', 1)[0] ?? '';
  const v4 = MAPPED_RE.exec(bare)?.[1] ?? bare;
  if (IPV4_RE.test(v4)) {
    const parts = v4.split('.').map(Number);
    if (parts.some((p) => p > 255)) return false;
    const [a = 0, b = 0] = parts;
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const groups = groupsOf(bare);
  if (groups === undefined) return false;
  const first = groups[0] ?? 0;
  const loopbackOrUnspecified = groups.slice(0, 7).every((g) => g === 0) && (groups[7] === 0 || groups[7] === 1);
  return loopbackOrUnspecified || (first >= 0xfc00 && first <= 0xfdff) || (first >= 0xfe80 && first <= 0xfebf);
}

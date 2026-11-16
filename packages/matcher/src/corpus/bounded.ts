import { isBytes } from './sign.js';

// Reading what a server sends, with a ceiling: the body is never held beyond `cap` bytes, however much the server declares or sends.
// Shared by the loader (a download) and the share client (an answer). Isomorphic.

const concat = (chunks: Uint8Array[], total: number): Uint8Array => {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

/** Cancelling a stream is not waited for: a server that is slow to hang up must not hold the caller (and the cancel of one half of a tee never ends alone). */
const release = (cancelled: Promise<void> | undefined): void => {
  try {
    cancelled?.catch(() => undefined);
  } catch {
    // nothing to release
  }
};

/**
 * The body of `res`, or null when it is larger than `cap` bytes (a declared length over the cap is refused before a byte is read, and
 * a stream is cancelled the moment it passes the cap). Throws a TypeError if the stream gives something that is not bytes.
 */
export async function readBounded(res: Response, cap: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > cap) {
    release(res.body?.cancel());
    return null;
  }
  const body = res.body;
  if (body !== null && body !== undefined && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!isBytes(value)) throw new TypeError('not bytes');
      total += value.length;
      if (total > cap) {
        release(reader.cancel());
        return null;
      }
      chunks.push(value);
    }
    return concat(chunks, total);
  }
  const all = new Uint8Array(await res.arrayBuffer());
  return all.length > cap ? null : all;
}

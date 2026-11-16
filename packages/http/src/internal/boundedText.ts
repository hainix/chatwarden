// Reading an answer from an outside host with a byte cap (K5 review): `res.text()` buffers the whole body before any size check can run, so a hostile or
// misconfigured host could make the kit hold an answer of any size. This reads a chunk at a time and gives up past the cap.

/** Throw away what is left of a body, so the connection is released. Never throws. */
export function discardBody(res: Response): void {
  try {
    void res.body?.cancel().catch(() => undefined);
  } catch {
    // nothing to release
  }
}

/**
 * The body as text, or `null` when it is longer than `maxBytes` (the rest is then never read and the body is cancelled). A body that cannot be read rejects,
 * which the caller treats as a failed attempt. Bytes that are not UTF-8 decode to the replacement character; they never throw. A `content-length` over the cap
 * ends it at once; one that is wrong or absent changes nothing, because the stream is counted either way.
 */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string | null> {
  const declared = res.headers.get('content-length');
  if (declared !== null && /^\d{1,15}$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    discardBody(res);
    return null;
  }
  const body = res.body;
  if (body === null) return '';
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let total = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore } from '@chatwarden/matcher/fixtures';
import { CORPUS_BASE_URL, CORPUS_KEYS, createCorpusLoader, parseIndex, type CorpusCache, type CorpusKey } from '@chatwarden/matcher/corpus';
import type { Clock } from '../deps.js';
import { parseArgs, UsageError, valueOf } from './args.js';
import type { ToolIo } from './io.js';

// `tools/verify-live.mjs` (design 7): fetch the PUBLIC urls and verify them end to end with the kit's own loader (signature of the index, the
// index, the signature of the release, its hash, the zip, the manifest, the rows), then sync the list into a throw-away LiveTerms. What a game would
// do, done by the maintainer right after a publish. A result holds a kind, a version, a verdict and a count: no word, no url.

export interface LiveCheck {
  kind: 'terms' | 'eval';
  version: string | null;
  ok: boolean;
  detail: string;
}
export interface LiveResult {
  ok: boolean;
  checks: LiveCheck[];
}

function memoryCache(): CorpusCache {
  const files = new Map<string, Uint8Array>();
  return {
    read: (name) => Promise.resolve(files.get(name) ?? null),
    write: (name, bytes) => Promise.resolve(void files.set(name, bytes.slice())),
    remove: (name) => Promise.resolve(void files.delete(name)),
  };
}

export async function verifyLive(options: { fetch: typeof fetch; baseUrl: string; keys: readonly CorpusKey[]; clock: Clock }): Promise<LiveResult> {
  const base = options.baseUrl.replace(/\/+$/, '');
  let index;
  try {
    const res = await options.fetch(`${base}/index.json`);
    if (!res.ok) throw new Error('index not served');
    // Read only to learn what is there; the loader below verifies the signature before it believes any of it.
    index = parseIndex(new Uint8Array(await res.arrayBuffer()), options.clock.now());
  } catch {
    return { ok: false, checks: [{ kind: 'terms', version: null, ok: false, detail: 'the index could not be fetched or read (missing, malformed or expired)' }] };
  }
  const checks: LiveCheck[] = [];
  for (const kind of ['terms', 'eval'] as const) {
    const version = index.latest[kind];
    if (version === undefined) continue;
    const entry = index.releases.find((r) => r.kind === kind && r.version === version);
    const languages = Object.keys(entry?.languages ?? {});
    const loader = createCorpusLoader({
      kind,
      select: { languages: languages.length > 0 ? languages : ['en'], minSeverity: 'rude' },
      cache: memoryCache(),
      clock: options.clock,
      baseUrl: base,
      keys: options.keys,
      fetch: options.fetch,
      follow: 'stable',
    } as Parameters<typeof createCorpusLoader>[0]);
    const { status } = await loader.refresh();
    if (status.state !== 'ready' || status.lastError !== null) {
      checks.push({ kind, version, ok: false, detail: `not verified (${status.lastError?.code ?? status.state})` });
      continue;
    }
    if (kind === 'terms') {
      const live = new LiveTerms({ store: new MemoryTermStore(), pack: null, clock: options.clock, logger: { warn: () => undefined } });
      const applied = (loader as ReturnType<typeof createCorpusLoader> & { applyTo: (t: LiveTerms) => { ok: boolean } | null }).applyTo(live);
      if (applied === null || !applied.ok) {
        checks.push({ kind, version, ok: false, detail: 'verified, but the list did not sync into a live list' });
        continue;
      }
      const rows = (loader as unknown as { release: () => { terms: unknown[] } | null }).release();
      checks.push({ kind, version, ok: true, detail: `${rows?.terms.length ?? 0} terms in ${languages.join(', ')}` });
    } else {
      const set = (loader as unknown as { release: () => { cases: unknown[] } | null }).release();
      checks.push({ kind, version, ok: true, detail: `${set?.cases.length ?? 0} cases in ${languages.join(', ')}` });
    }
  }
  if (checks.length === 0) checks.push({ kind: 'terms', version: null, ok: false, detail: 'the index lists no release' });
  return { ok: checks.every((c) => c.ok), checks };
}

const KEY_PAIR_RE = /^([A-Za-z0-9_.:-]{1,64})=([A-Za-z0-9_-]{43})$/;

export const VERIFY_USAGE = 'usage: verify-live [--base <url>] [--key id=publicKey[,id=publicKey]]';

export async function main(argv: readonly string[], io: ToolIo): Promise<number> {
  try {
    const args = parseArgs(argv, { base: 'value', key: 'value' });
    const keyText = valueOf(args, 'key');
    let keys: readonly CorpusKey[] = CORPUS_KEYS;
    if (keyText !== undefined) {
      keys = keyText.split(',').map((pair) => {
        const m = KEY_PAIR_RE.exec(pair);
        if (m === null) throw new UsageError('--key must be id=publicKey (base64url), comma separated');
        return { id: m[1] as string, publicKey: m[2] as string };
      });
    }
    if (keys.length === 0) {
      io.err('no_trusted_keys: the kit has no keys yet (CORPUS_KEYS is empty); pass --key id=publicKey');
      return 1;
    }
    const result = await verifyLive({ fetch: io.fetch, baseUrl: valueOf(args, 'base') ?? CORPUS_BASE_URL, keys, clock: io.clock });
    for (const c of result.checks) (c.ok ? io.out : io.err)(`${c.kind} ${c.version ?? '-'}: ${c.ok ? 'verified' : 'FAILED'}, ${c.detail}`);
    io.out(result.ok ? 'everything the public urls serve verifies.' : 'something does not verify: do not announce this release.');
    return result.ok ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(e.message);
      io.err(VERIFY_USAGE);
    } else {
      io.err('failed: the live release could not be checked');
    }
    return 1;
  }
}

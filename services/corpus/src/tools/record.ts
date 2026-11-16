// The SQL that tells the database a release is out (design 6.9). The tools never write to the live database: they write this file, the owner reads
// it and applies it (`wrangler d1 execute chatwarden-corpus --remote --file <it>`). Every value is checked against its own shape first, so that
// nothing but a plain literal is ever put into the text.

const KINDS = ['terms', 'eval'];
const VERSION_RE = /^\d{4}\.(?:0[1-9]|1[0-2])\.(?:0|[1-9]\d{0,2})$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const KEY_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const TERM_ID_RE = /^CWT-\d{4}-\d{5}$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DOI_RE = /^10\.\d{4,9}\/[A-Za-z0-9._-]{1,100}$/;
const CHUNK = 200;

export interface RecordInput {
  kind: 'terms' | 'eval';
  version: string;
  sequence: number;
  sha256: string;
  keyId: string;
  publishedAt: string;
  /** The ids of the terms that got their `since` from this release (the release summary's `stamped`). */
  stamped: readonly string[];
}

function need(ok: boolean): void {
  if (!ok) throw new RangeError('recordSql: a value is not the shape it must be');
}

export function recordSql(i: RecordInput): string {
  need(KINDS.includes(i.kind) && typeof i.version === 'string' && VERSION_RE.test(i.version));
  need(Number.isSafeInteger(i.sequence) && i.sequence >= 1);
  need(typeof i.sha256 === 'string' && SHA_RE.test(i.sha256) && typeof i.keyId === 'string' && KEY_ID_RE.test(i.keyId) && typeof i.publishedAt === 'string' && TIME_RE.test(i.publishedAt));
  need(Array.isArray(i.stamped) && i.stamped.every((id) => typeof id === 'string' && TERM_ID_RE.test(id)));
  const lines = [
    `-- Release ${i.kind} ${i.version}: applied by the owner after the publish (ids and hashes only).`,
    `INSERT INTO releases (kind, version, sequence, sha256, key_id, published_at, doi) VALUES ('${i.kind}', '${i.version}', ${i.sequence}, '${i.sha256}', '${i.keyId}', '${i.publishedAt}', NULL) ON CONFLICT (kind, version) DO NOTHING;`,
  ];
  if (i.kind === 'terms') {
    for (let n = 0; n < i.stamped.length; n += CHUNK) {
      const list = i.stamped
        .slice(n, n + CHUNK)
        .map((id) => `'${id}'`)
        .join(', ');
      lines.push(`UPDATE terms SET since = '${i.version}' WHERE since IS NULL AND id IN (${list});`);
      lines.push(`UPDATE submissions SET status = 'merged' WHERE status = 'accepted' AND term_id IN (${list});`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** The statement that records a release's DOI once Zenodo has it. */
export function doiSql(kind: 'terms' | 'eval', version: string, doi: string): string {
  need(KINDS.includes(kind) && typeof version === 'string' && VERSION_RE.test(version) && typeof doi === 'string' && DOI_RE.test(doi));
  return `UPDATE releases SET doi = '${doi}' WHERE kind = '${kind}' AND version = '${version}';\n`;
}

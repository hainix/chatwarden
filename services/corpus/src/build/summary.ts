import { createHash } from 'node:crypto';

// What the index needs to know about a release, computed once at build time and handed on to the signing and publishing tools.

export interface ReleaseSummary {
  kind: 'terms' | 'eval';
  version: string;
  sequence: number;
  /** The oldest kit that reads it. */
  minKit: string;
  /** Per language: `{ terms, exceptions }` for a term list, `{ cases }` for an eval set (the index's own shape). */
  languages: Record<string, Record<string, number>>;
  bytes: number;
  sha256: string;
  /** Paths below the base URL, as the index lists them. */
  zip: string;
  sig: string;
}

export const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function summarise(input: { kind: 'terms' | 'eval'; version: string; sequence: number; minKit: string; languages: Record<string, Record<string, number>>; zip: Uint8Array }): ReleaseSummary {
  const path = `${input.kind}/${input.version}/${input.kind}-${input.version}.zip`;
  return { kind: input.kind, version: input.version, sequence: input.sequence, minKit: input.minKit, languages: input.languages, bytes: input.zip.length, sha256: sha256Hex(input.zip), zip: path, sig: `${path}.sig` };
}

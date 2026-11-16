import type { TermRow6 } from '@chatwarden/matcher/corpus';
import type { GateFailure } from './gates.js';

// The human diff of a release (design 7): counts and ids, never the words unless the owner asks (`showWords`). Nothing here reads the database.

export interface TermsDiff {
  /** The release this one follows (its version), or null for the first. */
  previous: string | null;
  total: number;
  byStatus: Record<string, number>;
  added: string[];
  changed: { id: string; fields: string[] }[];
  unchanged: number;
  /** Ids that were in the previous release and are not in this one. */
  removed: string[];
  /** Terms the gates kept out of this release, by id and code. */
  held: GateFailure[];
}

const FIELDS = ['term', 'languages', 'category', 'target', 'severity', 'status', 'defaultActive', 'collidesWith', 'approvals'] as const;

/** What differs between a row of the previous release and the same row now, by field name (`lines` for the positive and negative lists). */
function changedFields(a: TermRow6, b: TermRow6): string[] {
  const out: string[] = FIELDS.filter((f) => JSON.stringify(a[f]) !== JSON.stringify(b[f]));
  if (JSON.stringify(a.positive) !== JSON.stringify(b.positive) || JSON.stringify(a.negative) !== JSON.stringify(b.negative)) out.push('lines');
  return out;
}

/** Compares the rows of the previous release (null for none: every row is added) with the rows of this one. Ids only. */
export function diffTerms(previousVersion: string | null, previous: readonly TermRow6[] | null, next: readonly TermRow6[], held: readonly GateFailure[]): TermsDiff {
  const before = new Map((previous ?? []).map((r) => [r.id, r]));
  const added: string[] = [];
  const changed: { id: string; fields: string[] }[] = [];
  let unchanged = 0;
  const byStatus: Record<string, number> = { accepted: 0, provisional: 0, disputed: 0, withdrawn: 0 };
  for (const row of next) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
    const old = before.get(row.id);
    if (old === undefined) {
      added.push(row.id);
      continue;
    }
    const fields = changedFields(old, row);
    if (fields.length === 0) unchanged += 1;
    else changed.push({ id: row.id, fields });
  }
  const now = new Set(next.map((r) => r.id));
  const removed = (previous ?? []).filter((r) => !now.has(r.id)).map((r) => r.id).sort();
  return { previous: previousVersion, total: next.length, byStatus, added, changed, unchanged, removed, held: [...held] };
}

/**
 * The diff as text for the owner to read: counts, then ids. With `words` (id to term; `--show-words`) the term is printed beside its id;
 * without it no word is printed.
 */
export function renderDiff(diff: TermsDiff, words?: ReadonlyMap<string, string>): string {
  const tag = (id: string): string => (words === undefined ? id : `${id} ${words.get(id) ?? ''}`.trimEnd());
  const lines = [
    `release follows ${diff.previous ?? 'nothing (the first release)'}`,
    `terms: ${diff.total} (accepted ${diff.byStatus.accepted}, provisional ${diff.byStatus.provisional}, disputed ${diff.byStatus.disputed}, withdrawn ${diff.byStatus.withdrawn})`,
    `added: ${diff.added.length}, changed: ${diff.changed.length}, unchanged: ${diff.unchanged}, held out by the gates: ${diff.held.length}`,
  ];
  if (diff.added.length > 0) lines.push('', 'added:', ...diff.added.map((id) => `  ${tag(id)}`));
  if (diff.removed.length > 0) lines.push('', `removed: ${diff.removed.length}`, ...diff.removed.map((id) => `  ${tag(id)}`));
  if (diff.changed.length > 0) lines.push('', 'changed:', ...diff.changed.map((c) => `  ${tag(c.id)}: ${c.fields.join(', ')}`));
  if (diff.held.length > 0) lines.push('', 'held out (fix, dispute or override them, then build again):', ...diff.held.map((h) => `  ${tag(h.id)}: ${h.code}`));
  return `${lines.join('\n')}\n`;
}

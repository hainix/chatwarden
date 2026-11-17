import type { NoticeOp } from '@chatwarden/core/notice-copy';
import { hasLength } from '../decision.js';
import type { SanctionGroupView, SanctionKind } from '../types.js';

// The ops the panel is asked about, built from the forms' own state. Small and eager (the panel's code is a lazy chunk, these are not): they carry only
// what `planNotices` accepts, so a reason, a gap note or a reference typed into a form cannot reach the panel (design 7). Core's types are imported as types only.

/** A direct sanction from the Person page: nothing until a kind is chosen. `choice` is the kind and the length the form resolved, or null. */
export function sanctionOp(choice: { kind: SanctionKind; durationMs: number | null } | null): NoticeOp | null {
  if (choice === null) return null;
  return choice.kind === 'note' ? { op: 'note' } : { op: 'sanction', kind: choice.kind, durationMs: hasLength(choice.kind) ? choice.durationMs : null };
}

/** The rename the Person page asks for, once a numbered rule is chosen. */
export function renameOp(rule: string): NoticeOp | null {
  return /^[1-9]\d*$/.test(rule) ? { op: 'rename', rule: Number(rule) } : null;
}

/** Revoking one sanction in force: what lifts for the player. */
export function revokeOp(s: Pick<SanctionGroupView, 'kind'>): NoticeOp {
  return { op: 'revoke', kind: s.kind };
}

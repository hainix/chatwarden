import { Audit } from '../screens/Audit.js';
import { Piece } from './Piece.js';
import type { PieceProps } from './Piece.js';

/**
 * The props of `AuditLog`.
 * @experimental
 */
export interface AuditLogProps extends PieceProps {
  /** A person an entry is about was chosen. Without it they are a plain tag. */
  onOpenPerson?: (person: string) => void;
  /** A report an entry is about was chosen. Without it it is a plain tag. */
  onOpenReport?: (reportId: string) => void;
}

/**
 * Who did what: every audited read and change by the staff, newest first, a page at a time, filterable by person and action. Needs the
 * `audit.read` permission (a senior or owner by default).
 *
 * ```tsx
 * <AuditLog />
 * ```
 * @experimental
 */
export function AuditLog({ className, onOpenPerson, onOpenReport }: AuditLogProps) {
  return (
    <Piece name="AuditLog" need="audit.read" className={className} links={{ onOpenPerson, onOpenReport }}>
      <Audit />
    </Piece>
  );
}

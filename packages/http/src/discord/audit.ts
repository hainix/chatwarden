import { safeWarn } from '@chatwarden/core';
import type { AuditAction, AuditTarget, Chatwarden, Logger, Role } from '@chatwarden/core';
import { AuditFailedError } from '../admin/context.js';

// The audit rows the bot writes: the same rows the staff routes write (history.view, suggest, report.decide), with the Discord actor and the kit role
// the adopter's map gave. A row that must exist (the lookup and the preview show data) is written in `required` mode: a failure throws, and nothing is
// shown. A row for a decision that has already committed is best-effort: a failure is logged by class and never undoes the decision.

/** Write a row or throw `AuditFailedError` (nothing is shown to the person when it cannot be recorded). */
export function auditRequired(cw: Chatwarden, who: { actor: string; role: Role }, action: AuditAction, target: AuditTarget): void {
  let written: boolean;
  try {
    written = cw.audit.record({ actor: who.actor, role: who.role, action, target });
  } catch {
    written = false;
  }
  if (!written) throw new AuditFailedError();
}

/** Write a row for something that has already happened; a failure is logged (class only) and returns false. */
export function auditBestEffort(cw: Chatwarden, logger: Logger | undefined, who: { actor: string; role: Role }, action: AuditAction, target: AuditTarget): boolean {
  try {
    auditRequired(cw, who, action, target);
    return true;
  } catch (err) {
    safeWarn(logger, 'chatwarden.discord_bot_failed', { op: 'audit', error: err instanceof Error ? err.name : 'Error' });
    return false;
  }
}

import { createHash } from 'node:crypto';
import type { ParsedSanction } from '../admin/apply.js';

/**
 * A fingerprint of a validated sanction: the SHA-256 (hex) of its fields in a fixed order, defaults filled in, so the same
 * request written with another key order or spacing gives the same value and any change to it gives another. The webhook
 * stores it with an idempotency key to refuse the key being reused for a different request. A hash: it holds no text.
 */
export function sanctionFingerprint(sanction: ParsedSanction): string {
  const { action, reason } = sanction;
  // `subject` is fingerprinted exactly as sent, on purpose (strict): a differently spelled subject is another request.
  // The gap note is fingerprinted TRIMMED, because the core trims it before it is stored: two spellings that store the
  // same note are the same request.
  const canonical = JSON.stringify([
    action.subject,
    action.kind,
    action.durationMs,
    action.rule,
    action.includeIp ?? false,
    action.gapNote?.trim() ?? null,
    reason,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

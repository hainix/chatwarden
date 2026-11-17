// Legal hold (0.2.0, design section 6): the closed list of reasons a senior may give, and the shapes a store keeps. A hold sits on ONE report; it protects the
// report and everything that hangs on it from every retention purge and from an erase. The service that places and releases a hold, and the bundle, are below
// (`createLegal`); this file's first half is plain data so `Store` can name it without importing the service.

/**
 * Why a report is held: a closed list. No free text ever: the code is the whole statement, and what it means is the adopter's own.
 * @experimental
 */
export const HOLD_CODES = ['law_enforcement_request', 'legal_proceeding', 'platform_request', 'safety_review', 'other'] as const;
export type HoldCode = (typeof HOLD_CODES)[number];

/** True for a code on the closed list. */
export function isHoldCode(value: unknown): value is HoldCode {
  return typeof value === 'string' && (HOLD_CODES as readonly string[]).includes(value);
}

/**
 * One hold as a store keeps it. `heldBy` and `releasedBy` are staff refs (audit class: staff channels only). A released hold keeps its row (so the audit
 * story is complete) until a new hold on the same report replaces it.
 * @experimental
 */
export interface HoldRow {
  reportId: string;
  code: HoldCode;
  heldBy: string;
  /** Epoch ms. */
  heldAt: number;
  releasedBy: string | null;
  releasedAt: number | null;
}

/**
 * Everything the open holds protect: the held report ids and the sanction groups decided from them (a group's rows, its notices and the appeals on it
 * share the group id). The AI reads, outcomes and actions of a held report are protected by its report id.
 * @experimental
 */
export interface HeldSet {
  reportIds: string[];
  groupIds: string[];
}

import type { Chatwarden } from '@chatwarden/core';

/** How many of a person's newest reports are looked through for a name. */
const HANDLE_REPORTS = 20;

/**
 * The name to show for a person: the handle on the newest report filed against them that recorded one (a blank handle is no name,
 * so an older report's is used). Null when none did. Staff only.
 */
export function latestHandle(cw: Chatwarden, person: string): string | null {
  for (const r of cw.reports.list({ person, limit: HANDLE_REPORTS }).items) if (r.targetHandle !== '') return r.targetHandle;
  return null;
}

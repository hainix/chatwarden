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

/**
 * Whether the hub should mask a handle until a moderator shows it (`names.maskInHub`, default on, read live once per call): a function that is
 * true only for a handle the matcher flags (`cw.names.flagged`: matcher only, nothing stored, never throws; a matcher failure reads as not
 * flagged). With the setting off it is false for everything, so no body carries a `handleFlagged` key. Staff only.
 */
export function handleFlags(cw: Chatwarden): (handle: string | null | undefined) => boolean {
  if (!cw.profile.names.maskInHub) return () => false;
  return (handle) => typeof handle === 'string' && handle !== '' && cw.names.flagged(handle);
}

/** `{ <key>: true }` when the handle is flagged, else nothing, so an unflagged body keeps exactly the keys it had. */
export function flagKey<K extends string>(flagged: (h: string | null | undefined) => boolean, key: K, handle: string | null | undefined): { [P in K]?: true } {
  return flagged(handle) ? ({ [key]: true } as { [P in K]?: true }) : {};
}

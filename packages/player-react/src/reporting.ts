import type { PlayerReporting, ReportFlow } from '@chatwarden/core';
import { isSafeHref } from './safeHref.js';

const FLOWS: readonly ReportFlow[] = ['one_tap', 'reason_first', 'reason_required'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';

/** The most help resources shown after a report, and the longest label or detail read (the server's own limits are 5, 60 and 200). */
const MAX_RESOURCES = 5;
const MAX_RESOURCE_TEXT = 200;

/** One help resource, or undefined when it has no label. The url is kept as it came (the dialog decides whether it is a link); a url that is not text is none. */
function resourceOf(raw: unknown): { label: string; detail: string; url: string | null } | undefined {
  if (!isObject(raw) || !text(raw.label) || raw.label.trim() === '') return undefined;
  return {
    label: raw.label.slice(0, MAX_RESOURCE_TEXT),
    detail: text(raw.detail) ? raw.detail.slice(0, MAX_RESOURCE_TEXT) : '',
    url: text(raw.url) && raw.url !== '' ? raw.url : null,
  };
}

/**
 * Whether a resource's url may become a link: an `https` address with a host and no credentials that also passes the package's `isSafeHref`. Anything else (`javascript:`, `http:`, `data:`, a relative path) is
 * shown as plain text.
 */
export function isResourceHref(url: string): boolean {
  if (!isSafeHref(url)) return false;
  try {
    // A relative path and a protocol-relative address do not parse on their own: only a full address with a secure scheme gets here.
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && parsed.hostname !== '' && parsed.username === '' && parsed.password === '';
  } catch {
    return false;
  }
}

/**
 * The reporting payload of `GET /rules` as the dialog may rely on it. Anything that is not the documented shape is dropped: a
 * reason needs a text id and label; the hint and group default to `''` and `asksNote` to false; an unknown flow is `one_tap` (the
 * default); a field the server should not send (a rule mapping, an enabled flag) is never copied. `undefined` when there is no
 * list of reasons at all (an older server, or something that is not the payload).
 */
export function readReporting(raw: unknown): PlayerReporting | undefined {
  if (!isObject(raw) || !Array.isArray(raw.reasons)) return undefined;
  const reasons = raw.reasons
    .filter(isObject)
    .filter((r) => text(r.id) && r.id !== '' && text(r.label) && r.label !== '')
    .map((r) => ({
      id: r.id as string,
      label: r.label as string,
      hint: text(r.hint) ? r.hint : '',
      group: text(r.group) ? r.group : '',
      asksNote: r.asksNote === true,
      // A reason's own thank-you (null: the general one) and whether it offers the help resources: only when they are well formed.
      thanks: text(r.thanks) ? r.thanks : null,
      showResources: r.showResources === true,
    }));
  const flow = FLOWS.find((f) => f === raw.flow) ?? 'one_tap';
  const resources = Array.isArray(raw.resources) ? raw.resources.map(resourceOf).filter((r): r is NonNullable<typeof r> => r !== undefined).slice(0, MAX_RESOURCES) : [];
  return { flow, reasons, thanks: text(raw.thanks) ? raw.thanks : '', resources };
}

export type ReasonItem = PlayerReporting['reasons'][number];

/** A heading (`''` for none) and the reasons under it. */
export interface ReasonGroup {
  name: string;
  items: ReasonItem[];
}

/**
 * The reasons grouped for the screen: a group is where its first reason is in the list, "Something else" (`other`) is always
 * last, and a group with no name has no heading.
 */
export function groupReasons(reasons: readonly ReasonItem[]): ReasonGroup[] {
  const groups: ReasonGroup[] = [];
  for (const r of reasons) {
    if (r.id === 'other') continue;
    const into = groups.find((g) => g.name === r.group);
    if (into === undefined) groups.push({ name: r.group, items: [r] });
    else into.items.push(r);
  }
  const other = reasons.find((r) => r.id === 'other');
  if (other !== undefined) {
    const last = groups.at(-1);
    if (last !== undefined && last.name === '') last.items.push(other);
    else groups.push({ name: '', items: [other] });
  }
  return groups;
}

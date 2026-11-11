import type { PlayerReporting, ReportFlow } from '@chatwarden/core';

const FLOWS: readonly ReportFlow[] = ['one_tap', 'reason_first', 'reason_required'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string';

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
    .map((r) => ({ id: r.id as string, label: r.label as string, hint: text(r.hint) ? r.hint : '', group: text(r.group) ? r.group : '', asksNote: r.asksNote === true }));
  const flow = FLOWS.find((f) => f === raw.flow) ?? 'one_tap';
  return { flow, reasons, thanks: text(raw.thanks) ? raw.thanks : '' };
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

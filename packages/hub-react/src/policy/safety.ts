import { DEFAULT_SAFETY_GUIDANCE, SAFETY_CONTACT_MAX, SAFETY_DETAIL_MAX, SAFETY_GUIDANCE_MAX, SAFETY_LABEL_MAX, SAFETY_RESOURCES_MAX, SAFETY_URL_MAX } from '@chatwarden/core';
import type { ResolvedSafety, SafetySettings } from '@chatwarden/core';
import type { Problem } from '../decision.js';
import type { Problems } from './panels.js';
import { charsOf } from './reporting.js';

// The draft of the "Safety and urgent cases" panel: the guidance a moderator reads on an urgent case, the studio contact line (staff only) and the resources a reporter is
// shown. What the owner typed, the checks the kit makes again on its side (so a refusal can be said before anything is sent), and the section a save carries. Pure.

export { SAFETY_CONTACT_MAX, SAFETY_DETAIL_MAX, SAFETY_GUIDANCE_MAX, SAFETY_LABEL_MAX, SAFETY_RESOURCES_MAX, SAFETY_URL_MAX, DEFAULT_SAFETY_GUIDANCE };

/** One resource as the panel edits it; `key` is the row's identity on the page and never reaches the kit. */
export interface ResourceDraft {
  key: string;
  label: string;
  detail: string;
  url: string;
}

export interface SafetyDraft {
  /** Empty means "the kit's default guidance": it is shown as the placeholder and never saved unless the owner types their own. */
  guidance: string;
  contact: string;
  resources: ResourceDraft[];
}

let keys = 0;
export const freshResource = (): ResourceDraft => ({ key: `s${(keys += 1)}`, label: '', detail: '', url: '' });

/** The draft the safety settings in force make: the default guidance reads as no guidance at all. */
export function safetyDraftOf(safety: ResolvedSafety | undefined): SafetyDraft {
  if (safety === undefined) return { guidance: '', contact: '', resources: [] };
  return {
    guidance: safety.guidance === DEFAULT_SAFETY_GUIDANCE ? '' : safety.guidance,
    contact: safety.contact,
    resources: safety.resources.map((r) => ({ key: `s${(keys += 1)}`, label: r.label, detail: r.detail, url: r.url ?? '' })),
  };
}

/** The section a save carries: only what is set (the default guidance is not written), or null when nothing is, so the section goes back to the profile in code. */
export function safetyLayer(d: SafetyDraft): SafetySettings | null {
  const out: SafetySettings = {};
  if (d.guidance.trim() !== '') out.guidance = d.guidance.trim();
  if (d.contact.trim() !== '') out.contact = d.contact.trim();
  if (d.resources.length > 0) {
    out.resources = d.resources.map((r) => ({ label: r.label.trim(), ...(r.detail.trim() === '' ? {} : { detail: r.detail.trim() }), ...(r.url.trim() === '' ? {} : { url: r.url.trim() }) }));
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** Whether the draft means something different from the settings in force. */
export const safetyDirty = (d: SafetyDraft, effective: ResolvedSafety | undefined): boolean => JSON.stringify(safetyLayer(d)) !== JSON.stringify(safetyLayer(safetyDraftOf(effective)));

/** What is wrong with a link, if anything: the three things the kit refuses, in the order a person meets them. */
function urlProblem(url: string): 'scheme' | 'credentials' | 'invalid' | null {
  if (!/^https:[/][/]/i.test(url)) return 'scheme';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'invalid';
  }
  if (parsed.username !== '' || parsed.password !== '') return 'credentials';
  if (parsed.hostname === '' || /\s/.test(url)) return 'invalid';
  return null;
}

const URL_KEYS = { scheme: 'hub.settings.safety.error.url.scheme', credentials: 'hub.settings.safety.error.url.credentials', invalid: 'hub.settings.safety.error.url.invalid' } as const;

/** Fields the kit would refuse, by field key, in words that name the field (a resource says which one). */
export function safetyProblems(d: SafetyDraft): Problems {
  const out: Record<string, Problem> = {};
  const g = charsOf(d.guidance.trim());
  if (g > SAFETY_GUIDANCE_MAX) out['guidance'] = { key: 'hub.settings.safety.error.guidance', params: { count: String(g), max: String(SAFETY_GUIDANCE_MAX) } };
  const c = charsOf(d.contact.trim());
  if (c > SAFETY_CONTACT_MAX) out['contact'] = { key: 'hub.settings.safety.error.contact', params: { count: String(c), max: String(SAFETY_CONTACT_MAX) } };
  if (d.resources.length > SAFETY_RESOURCES_MAX) out['resources'] = { key: 'hub.settings.safety.error.resources', params: { max: SAFETY_RESOURCES_MAX } };
  d.resources.forEach((r, i) => {
    const n = i + 1;
    const label = r.label.trim();
    if (label === '') out[`resource-${r.key}-label`] = { key: 'hub.settings.safety.error.label.empty', params: { n } };
    else if (charsOf(label) > SAFETY_LABEL_MAX) out[`resource-${r.key}-label`] = { key: 'hub.settings.safety.error.label.long', params: { n, max: SAFETY_LABEL_MAX } };
    if (charsOf(r.detail.trim()) > SAFETY_DETAIL_MAX) out[`resource-${r.key}-detail`] = { key: 'hub.settings.safety.error.detail.long', params: { n, max: SAFETY_DETAIL_MAX } };
    const url = r.url.trim();
    if (url !== '') {
      if (charsOf(url) > SAFETY_URL_MAX) out[`resource-${r.key}-url`] = { key: 'hub.settings.safety.error.url.long', params: { n, max: SAFETY_URL_MAX } };
      else {
        const bad = urlProblem(url);
        if (bad !== null) out[`resource-${r.key}-url`] = { key: URL_KEYS[bad], params: { n } };
      }
    }
  });
  return out;
}

/** The field a refusal of the kit names (`layer.safety.resources[1].url` is the second resource's link); null when it names none of them. */
export function safetyFieldKey(path: string, d: SafetyDraft): string | null {
  if (path === 'layer.safety.guidance') return 'guidance';
  if (path === 'layer.safety.contact') return 'contact';
  if (path === 'layer.safety.resources') return 'resources';
  const m = /^layer\.safety\.resources\[(\d+)\](?:\.(\w+))?$/.exec(path);
  if (m === null) return null;
  const row = d.resources[Number(m[1])];
  if (row === undefined) return 'resources';
  const part = m[2];
  return `resource-${row.key}-${part === 'detail' || part === 'url' ? part : 'label'}`;
}

/** The field to put the focus on first: the draft's order, top to bottom. */
export function firstSafetyField(d: SafetyDraft, problems: Problems): string | null {
  const order = ['guidance', 'contact', ...d.resources.flatMap((r) => [`resource-${r.key}-label`, `resource-${r.key}-detail`, `resource-${r.key}-url`]), 'resources'];
  return order.find((k) => problems[k] !== undefined) ?? null;
}

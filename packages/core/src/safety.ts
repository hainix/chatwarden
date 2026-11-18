import { cleanText, given, httpsUrl, plain } from './settingsCheck.js';
import { ProfileError } from './profileError.js';

// The safety settings: what a moderator is shown on an urgent case (the game's own guidance and contact line) and the resource list a
// reporter is shown after a report. Text the owner writes, in the game's own language. The kit never diagnoses, contacts anyone or
// forwards anything: see the design's section 3.

/** The most characters of guidance, of a contact line, of a resource label, of a resource detail and of a resource link. */
export const SAFETY_GUIDANCE_MAX = 1500;
export const SAFETY_CONTACT_MAX = 300;
export const SAFETY_LABEL_MAX = 60;
export const SAFETY_DETAIL_MAX = 200;
export const SAFETY_URL_MAX = 500;
/** The most resources one profile may list. */
export const SAFETY_RESOURCES_MAX = 5;

/**
 * What the "What to do" panel says when the owner has written nothing: four short paragraphs. A safe floor, not legal advice. Plain
 * text, paragraphs separated by a blank line.
 */
export const DEFAULT_SAFETY_GUIDANCE = [
  "You are not asked to judge whether anyone is at risk or whether a threat is real. Your part is to pass it on quickly, the way your studio has set it up.",
  "Your studio's contact line is shown below this text. If there is none, ask the owner to add one in Settings.",
  'Do not contact the player yourself from a personal account, and do not copy the chat anywhere outside the hub.',
  "If anything involves a child in danger or sexual material involving minors, stop. Do not save, copy or forward it, and follow your studio's legal procedure.",
].join('\n\n');

/**
 * One resource shown to a reporter. `label` is required; `detail` and `url` are optional (`url` is `https` only).
 */
export interface SafetyResourceInput {
  label: string;
  detail?: string;
  url?: string | null;
}

/**
 * What the owner writes. Every field optional.
 */
export interface SafetySettings {
  /** Text moderators read in the "What to do" panel, at most 1 500 characters; blank lines separate paragraphs; plain text. Unset or blank reads {@link DEFAULT_SAFETY_GUIDANCE}. */
  guidance?: string;
  /** One line for staff only: who to reach in the studio, at most 300 characters. Never sent to a player. */
  contact?: string;
  /** Up to 5 resources a reporter is shown after a report whose reason has `showResources`. A layer's list replaces the whole list. */
  resources?: SafetyResourceInput[];
}

/** One resource, every field filled in. */
export interface SafetyResource {
  label: string;
  detail: string;
  url: string | null;
}

/**
 * What the kit reads: every field filled in. The text has been cleaned (control, bidi and zero-width characters removed).
 */
export interface ResolvedSafety {
  guidance: string;
  contact: string;
  resources: SafetyResource[];
}

const KEYS = ['guidance', 'contact', 'resources'] as const;
const RESOURCE_KEYS = ['label', 'detail', 'url'] as const;

function resolveResource(v: unknown, path: string): SafetyResource {
  const r = plain(v, RESOURCE_KEYS, path);
  const label = cleanText(given(r, 'label'), `${path}.label`, 1, SAFETY_LABEL_MAX, true);
  const detailRaw = given(r, 'detail');
  const detail = detailRaw === undefined ? '' : cleanText(detailRaw, `${path}.detail`, 0, SAFETY_DETAIL_MAX, true);
  const urlRaw = given(r, 'url');
  const url = urlRaw === undefined || urlRaw === null ? null : httpsUrl(urlRaw, `${path}.url`, SAFETY_URL_MAX);
  return { label, detail, url };
}

/**
 * Validate, clean and fill. Throws ProfileError naming the field (`safety.resources[1].url`), never echoing the value. `path` names the
 * settings in the error (default `safety`). The result is a new object that shares nothing with the input; each value is read once.
 */
export function resolveSafety(input: SafetySettings | undefined, path = 'safety'): ResolvedSafety {
  const out: ResolvedSafety = { guidance: DEFAULT_SAFETY_GUIDANCE, contact: '', resources: [] };
  if (input === undefined) return out;
  const o = plain(input, KEYS, path);
  const guidance = given(o, 'guidance');
  if (guidance !== undefined) {
    const text = cleanText(guidance, `${path}.guidance`, 0, SAFETY_GUIDANCE_MAX, false);
    // Blank (or only invisible characters) reads as unset: an owner cannot blank out the safe floor by accident.
    if (text !== '') out.guidance = text;
  }
  const contact = given(o, 'contact');
  if (contact !== undefined) out.contact = cleanText(contact, `${path}.contact`, 0, SAFETY_CONTACT_MAX, true);
  const resources = given(o, 'resources');
  if (resources !== undefined) {
    const rp = `${path}.resources`;
    if (!Array.isArray(resources) || resources.length > SAFETY_RESOURCES_MAX) throw new ProfileError(rp, `must be a list of at most ${SAFETY_RESOURCES_MAX} resources`);
    out.resources = (resources as unknown[]).map((r, i) => resolveResource(r, `${rp}[${i}]`));
  }
  return out;
}

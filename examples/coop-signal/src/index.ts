import { createHmac } from 'node:crypto';

// A copy-in Coop plugin (K5 design 8.7): one numeric signal, "Chatwarden AI severity". Coop asks it about a reported item; it posts the reported thread to your kit's
// `POST /coop/signal` (the route `coop(cw, { signal })` adds), signed with the kit's HMAC scheme, and returns the severity the kit's `read` answers, 0 to 100.
// A Coop rule can then compare it with a threshold. A failure of any kind returns no score, never a made-up one.
//
// Coop's plugin types are DECLARED HERE, not imported, so this file runs with no @roostorg package. Coop's docs name them `@roostorg/coop-types`
// (IntegrationManifest, PluginSignalDescriptor, PluginSignalContext) and its example plugin imports `@roostorg/types`. UNVERIFIED against a running Coop 1.2.x (design
// section 15): the exact return shape of `createSignals`, whether a model card is required, the shape of `run`'s input and of a "disabled" answer, and whether a
// report job evaluates signals at routing time. Compare with the example plugin (github.com/roostorg/coop-integration-example) before relying on it.

/** What Coop gives `createSignals`: a way to read the org's saved config. UNVERIFIED shape. */
export interface PluginSignalContext {
  getCredential(orgId: string): Promise<Record<string, unknown> | null | undefined>;
}
export interface ConfigField {
  key: string;
  label: string;
  required: boolean;
  inputType: 'text' | 'password';
  placeholder?: string;
}
export interface Manifest {
  id: string;
  name: string;
  version: string;
  requiresConfig: boolean;
  configurationFields: ConfigField[];
  signalTypeIds: string[];
}
/** What `run` answers: a number Coop's rule compares with a threshold, or a disabled answer with no score. */
export type SignalResult = { outputType: { scalarType: 'NUMBER' }; score: number } | { disabled: true; disabledMessage: string };
/** What can be swapped in a test. */
export interface Deps {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const SIGNAL_TYPE = 'CHATWARDEN_AI_SEVERITY';
const MAX_LINES = 20;
const TEXT_MAX = 400;
const ANSWER_MAX = 1000;
const UNAVAILABLE: SignalResult = { disabled: true, disabledMessage: 'The Chatwarden signal is not available.' };

export const manifest: Manifest = {
  id: 'CHATWARDEN_AI_READ',
  name: 'Chatwarden AI read',
  version: '0.1.0',
  requiresConfig: true,
  configurationFields: [
    { key: 'kitUrl', label: 'Chatwarden kit URL', required: true, inputType: 'text', placeholder: 'https://game.example.com' },
    { key: 'secret', label: 'Signal secret', required: true, inputType: 'password' },
  ],
  signalTypeIds: [SIGNAL_TYPE],
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** `https`, or `http` on localhost and 127.0.0.1; no credentials, query or fragment. Returns the base without a trailing slash, or null. */
function kitBase(v: unknown): string | null {
  try {
    const url = new URL(String(v));
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** The text of the reported item and the labelled thread before it (the newest 20). Labels are the kit's own (`reporter`, `reported`, `other n`); ids are never read. */
function readInput(input: unknown): { lines: Array<{ label: string; text: string }>; item: string | null } {
  const root = isObject(input) ? input : {};
  const thread = isObject(root['context']) && isObject(root['context']['thread']) ? root['context']['thread']['messages'] : undefined;
  const lines: Array<{ label: string; text: string }> = [];
  for (const m of Array.isArray(thread) ? thread : []) {
    const data = isObject(m) && isObject(m['data']) ? m['data'] : undefined;
    if (typeof data?.['text'] !== 'string') continue;
    const author = data['author'];
    lines.push({ label: typeof author === 'string' && author.length > 0 && author.length <= 32 ? author : 'other', text: cut(data['text'], TEXT_MAX) });
  }
  const value = isObject(root['value']) ? root['value']['value'] : root['value'];
  const data = isObject(root['item']) && isObject(root['item']['data']) ? root['item']['data'] : undefined;
  const text = typeof data?.['text'] === 'string' ? data['text'] : typeof value === 'string' ? value : null;
  return { lines: lines.slice(-MAX_LINES), item: text === null ? null : cut(text, TEXT_MAX) };
}

/** The signal's `run`: sign and post, then read `{ severity }`. Every failure is the same disabled answer; nothing about it is logged or returned. */
async function severity(context: PluginSignalContext, deps: Deps, input: unknown): Promise<SignalResult> {
  try {
    const orgId = isObject(input) && typeof input['orgId'] === 'string' ? input['orgId'] : '';
    const config = await context.getCredential(orgId);
    const base = kitBase(config?.['kitUrl']);
    const secret = config?.['secret'];
    if (base === null || typeof secret !== 'string' || secret.length < 32) return UNAVAILABLE;
    const { lines, item } = readInput(input);
    if (lines.length === 0 && item === null) return UNAVAILABLE;
    const payload = lines.length === 0 ? { lines: [{ label: 'reported', text: item }] } : item === null ? { lines } : { lines, item: { text: item } };
    const body = JSON.stringify(payload);
    // The kit's scheme: HMAC-SHA256 over `<unix seconds>.<body>`, sent as `v1=<hex>`.
    const ts = Math.floor((deps.now ?? Date.now)() / 1000);
    const signature = `v1=${createHmac('sha256', secret).update(`${ts}.${body}`, 'utf8').digest('hex')}`;
    const res = await (deps.fetch ?? fetch)(`${base}/coop/signal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-chatwarden-timestamp': String(ts), 'x-chatwarden-signature': signature },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
    if (res.status !== 200) return UNAVAILABLE;
    const text = await res.text();
    const answer: unknown = text.length > ANSWER_MAX ? null : JSON.parse(text);
    const score = isObject(answer) ? answer['severity'] : undefined;
    if (typeof score !== 'number' || !Number.isFinite(score)) return UNAVAILABLE;
    return { outputType: { scalarType: 'NUMBER' }, score: Math.min(100, Math.max(0, score)) };
  } catch {
    return UNAVAILABLE;
  }
}

/** The plugin's signals. UNVERIFIED: the wrapper shape (`signalTypeId` plus `descriptor`); the descriptor's fields follow Coop's example plugin. */
export function createSignals(context: PluginSignalContext, deps: Deps = {}) {
  const descriptor = {
    id: { type: SIGNAL_TYPE },
    displayName: 'Chatwarden AI severity',
    description: 'How serious the reported thread is, 0 to 100, as read by your Chatwarden kit.',
    docsUrl: null,
    recommendedThresholds: { highPrecisionThreshold: 70, highRecallThreshold: 40 },
    supportedLanguages: 'ALL',
    pricingStructure: { type: 'FREE' },
    eligibleInputs: ['STRING', 'FULL_ITEM'],
    outputType: { scalarType: 'NUMBER' },
    needsMatchingValues: false,
    eligibleSubcategories: [] as string[],
    needsActionPenalties: false,
    integration: manifest.id,
    allowedInAutomatedRules: true,
    getCost: () => 0,
    // The thread is what makes the severity useful: ask Coop for the last 20 messages.
    contextNeeds: { includeThread: true, maxThreadMessages: MAX_LINES },
    run: (input: unknown): Promise<SignalResult> => severity(context, deps, input),
  };
  return [{ signalTypeId: SIGNAL_TYPE, descriptor }];
}

export default { manifest, createSignals };

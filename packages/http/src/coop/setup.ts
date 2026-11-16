import { errorClass, lengthLabel, safeWarn } from '@chatwarden/core';
import type { Chatwarden } from '@chatwarden/core';
import type { CoopDecision, ResolvedCoopOptions } from './options.js';
import { ITEM_FIELDS } from './wire.js';
import type { CoopField } from './wire.js';

// Setup (K5 design 8.5). Coop documents no write API for item types, policies or actions (they are read-only over the API), so the adopter creates them by hand:
// `checklist()` says exactly what, from the kit's own rules and the adapter's options. `verify()` is a read-only self-check: three GETs, then a comparison. Neither
// writes anywhere, and neither returns or logs a secret.

/** Each GET is aborted after this long. */
const VERIFY_TIMEOUT_MS = 10_000;
/** The most of an answer that is read. */
const ANSWER_MAX = 1_000_000;

export interface CoopChecklistItemType {
  key: 'user' | 'line' | 'report';
  /** The id the adapter is configured with (copied from Coop once the type exists). */
  id: string;
  name: string;
  kind: 'USER' | 'CONTENT';
  fields: CoopField[];
}

export interface CoopChecklist {
  itemTypes: CoopChecklistItemType[];
  /** One per active Community Rule: the name and the policy text to enter in Coop. */
  policies: Array<{ name: string; policyText: string }>;
  /** One per action the adapter maps. `callbackUrl` is a placeholder for your public URL; `strikes` is always false. */
  actions: Array<{ id: string; name: string; callbackUrl: string; strikes: false }>;
  notes: string[];
  /** The whole checklist as plain text, for a terminal or a runbook. */
  toText(): string;
}

/** What `setup.verify()` found. `ok` says Coop answered; `complete` says nothing is missing. */
export type CoopVerification =
  | {
      ok: true;
      complete: boolean;
      /** Configured policy ids (from `rules` and `policies`) that Coop does not list. */
      policies: { missing: string[] };
      /** `missing`: configured action ids Coop does not list. `unmapped`: Coop actions the adapter has no meaning for (their callbacks are ignored). */
      actions: { missing: string[]; unmapped: string[] };
      /** `missing`: which of `user`, `line`, `report` is not in Coop under the configured id. `fieldProblems`: one line each, never a value. */
      itemTypes: { missing: string[]; fieldProblems: string[] };
    }
  | { ok: false; status?: number; error?: string };

const CALLBACK_URL = '<your public URL>/coop/actions';

/** The name to give a Coop action that means `d`. */
function actionName(d: CoopDecision): string {
  switch (d.verdict) {
    case 'no_action':
      return 'Dismiss';
    case 'bad_faith':
      return 'Bad faith report';
    case 'noted':
      return 'Note';
    default:
      if (d.kind === 'warning') return 'Warn';
      if (d.kind === 'chat') return d.durationMs === undefined ? 'Restrict chat' : `Restrict chat for ${lengthLabel(d.durationMs)}`;
      if (d.kind === 'area') return d.durationMs === undefined ? 'Restrict area' : `Restrict area for ${lengthLabel(d.durationMs)}`;
      return d.durationMs === undefined ? 'Ban permanently' : `Ban for ${lengthLabel(d.durationMs)}`;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Setup {
  checklist(): CoopChecklist;
  verify(): Promise<CoopVerification>;
}

export function createSetup(cw: Chatwarden, o: ResolvedCoopOptions): Setup {
  const { logger } = o;
  const call = o.fetch ?? ((input: string | URL | Request, init?: RequestInit) => globalThis.fetch(input, init));

  const checklist = (): CoopChecklist => {
    const itemTypes: CoopChecklistItemType[] = [
      { key: 'user', id: o.itemTypes.user, name: 'Chatwarden player', kind: 'USER', fields: ITEM_FIELDS.user.map((f) => ({ ...f })) },
      { key: 'line', id: o.itemTypes.line, name: 'Chatwarden chat line', kind: 'CONTENT', fields: ITEM_FIELDS.line.map((f) => ({ ...f })) },
      { key: 'report', id: o.itemTypes.report, name: 'Chatwarden report', kind: 'CONTENT', fields: ITEM_FIELDS.report.map((f) => ({ ...f })) },
    ];
    const policies = cw.rules.active().map((r) => ({ name: `Community Rule ${r.number}: ${r.title}`, policyText: r.text }));
    const used = new Map<string, number>();
    const actions = [...o.actions].map(([id, decision]) => {
      const base = actionName(decision);
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      return { id, name: n === 1 ? base : `${base} (${n})`, callbackUrl: CALLBACK_URL, strikes: false as const };
    });
    const sends =
      o.evidence === 'excerpt'
        ? `Coop receives the chat lines of each reported excerpt${o.handles === 'shown' ? ', with handles' : ', labelled reporter, reported and other n, without handles'}`
        : 'Coop receives the category, rule, severity and room tags only, no chat lines';
    const notes = [
      'Coop has no API to create item types, policies or actions. Create them by hand in Coop, then copy their ids into the adapter options.',
      'Create the three item types with exactly these field names. Names are case sensitive.',
      'Create one policy for each Community Rule above. The name and the text come from the kit.',
      'Create the actions above. Set each callback URL to your public URL plus /coop/actions, and turn user strikes off. A rule or a strike threshold must never decide a case.',
      ...(o.callbackAuth === null ? [] : [`Set the header ${o.callbackAuth.header} on each action, with the value from your adapter options.`]),
      'Do not use Ignore to close a job. Coop sends no callback for Ignore (not confirmed for Coop 1.2.2), so the report would stay open in the kit. Use the Dismiss action.',
      'Copy the API key and the Webhook Signature Verification Key from Settings, API Keys. Keep both out of source control.',
      'A decision made in the kit first stands. A later Coop decision for the same report is ignored, and its job stays in Coop.',
      'Coop signs no time. If the verification key leaks, rotate it in Coop.',
      `${sends}.`,
      'Run setup.verify() when you are done. It only reads.',
    ];
    const toText = (): string => {
      const lines: string[] = ['Item types'];
      for (const t of itemTypes) {
        lines.push(`  ${t.name} (${t.kind})${t.fields.length === 0 ? ': no fields' : ':'}`);
        for (const f of t.fields) lines.push(`    ${f.name}  ${f.type}  ${f.required ? 'required' : 'optional'}`);
      }
      lines.push('', 'Policies');
      for (const p of policies) lines.push(`  ${p.name}`, `    ${p.policyText}`);
      lines.push('', 'Actions (user strikes off)');
      for (const a of actions) lines.push(`  ${a.name}  ->  ${a.callbackUrl}`);
      lines.push('', 'Notes');
      for (const n of notes) lines.push(`  ${n}`);
      return lines.join('\n');
    };
    return { itemTypes, policies, actions, notes, toText };
  };

  /** One GET with the key. The key is only ever in the request header. */
  const get = async (path: string): Promise<{ status: number; json?: unknown }> => {
    const controller = new AbortController();
    const cancel = o.schedule(() => controller.abort(), VERIFY_TIMEOUT_MS);
    try {
      const res = await call(`${o.baseUrl}${path}`, { method: 'GET', headers: { 'X-API-KEY': o.apiKey }, redirect: 'manual', signal: controller.signal });
      if (res.status < 200 || res.status >= 300) {
        try {
          void res.body?.cancel().catch(() => undefined);
        } catch {
          // nothing to release
        }
        return { status: res.status };
      }
      const text = await res.text();
      if (text.length > ANSWER_MAX) return { status: res.status };
      try {
        return { status: res.status, json: JSON.parse(text) as unknown };
      } catch {
        return { status: res.status };
      }
    } finally {
      cancel();
    }
  };

  const verify = async (): Promise<CoopVerification> => {
    const fail = (detail: { status?: number; error?: string }): CoopVerification => {
      safeWarn(logger, 'chatwarden.coop_failed', { op: 'verify', ...detail });
      return { ok: false, ...detail };
    };
    const lists: Record<'policies' | 'actions' | 'itemTypes', unknown[]> = { policies: [], actions: [], itemTypes: [] };
    try {
      for (const [key, path] of [['policies', '/api/v1/policies/'], ['actions', '/api/v1/actions/'], ['itemTypes', '/api/v1/item_types/']] as const) {
        const res = await get(path);
        if (res.status < 200 || res.status >= 300) return fail({ status: res.status });
        const list = isObject(res.json) ? res.json[key] : undefined;
        if (!Array.isArray(list)) return fail({ error: 'BadAnswer' });
        lists[key] = list;
      }
    } catch (err) {
      return fail({ error: errorClass(err) });
    }

    const idsOf = (list: unknown[]): Set<string> => new Set(list.flatMap((x) => (isObject(x) && typeof x['id'] === 'string' ? [x['id']] : [])));
    const policyIds = idsOf(lists.policies);
    const actionIds = idsOf(lists.actions);

    const wantedPolicies = new Set<string>([...o.rules.keys(), ...o.policyByReason.values(), ...o.policyByRule.values()]);
    const policiesMissing = [...wantedPolicies].filter((id) => !policyIds.has(id));
    const actionsMissing = [...o.actions.keys()].filter((id) => !actionIds.has(id));
    const unmapped = lists.actions.flatMap((x) => {
      if (!isObject(x) || typeof x['id'] !== 'string' || o.actions.has(x['id'])) return [];
      // Built-in actions are not the adapter's to map; a custom one with no meaning here is a callback that would be ignored.
      return x['actionType'] === undefined || x['actionType'] === 'CUSTOM_ACTION' ? [x['id']] : [];
    });

    const byId = new Map<string, unknown>();
    for (const t of lists.itemTypes) if (isObject(t) && typeof t['id'] === 'string') byId.set(t['id'], t);
    const typesMissing: string[] = [];
    const fieldProblems: string[] = [];
    for (const key of ['user', 'line', 'report'] as const) {
      const found = byId.get(o.itemTypes[key]);
      if (!isObject(found)) {
        typesMissing.push(key);
        continue;
      }
      const schema = Array.isArray(found['schema']) ? found['schema'].filter(isObject) : [];
      const present = new Map<string, boolean>();
      for (const f of schema) if (typeof f['name'] === 'string') present.set(f['name'], f['required'] === true);
      const sent = new Set(ITEM_FIELDS[key].map((f) => f.name));
      for (const f of ITEM_FIELDS[key]) if (!present.has(f.name)) fieldProblems.push(`${key}: field ${f.name} is missing`);
      for (const [name, required] of present) if (required && !sent.has(name)) fieldProblems.push(`${key}: field ${name} is required and the kit never sends it`);
    }

    return {
      ok: true,
      complete: policiesMissing.length === 0 && actionsMissing.length === 0 && unmapped.length === 0 && typesMissing.length === 0 && fieldProblems.length === 0,
      policies: { missing: policiesMissing },
      actions: { missing: actionsMissing, unmapped },
      itemTypes: { missing: typesMissing, fieldProblems },
    };
  };

  return { checklist, verify };
}

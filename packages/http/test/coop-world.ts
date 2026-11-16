import { createPrivateKey, createSign, generateKeyPairSync } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { Chatwarden } from '@chatwarden/core';
import { coop } from '../src/coop/index.js';
import type { CoopOptions } from '../src/coop/index.js';
import { createRouter } from '../src/router.js';
import type { KitRequest } from '../src/types.js';
import { world } from './world.js';
import type { WorldOptions } from './world.js';

// The fake Coop for the adapter's tests (K5 C1): a `fetch` that is as strict as Coop's documented API (https://docs.roost.tools/coop/latest/api/), an RSA key
// pair generated here (never a real key) and a maker of signed callbacks. Everything here is written from the documented wire format and does NOT import
// the adapter's own code, so a field the adapter gets wrong is refused here. No network: nothing in this file opens a socket.
// UNVERIFIED against a real Coop 1.2.2 (design section 15): the trailing slash on the GETs, `datetime` as a top-level thread field AND a data field, `creator`.

export const COOP_URL = 'https://coop.example.test';
export const API_KEY = 'coop-fake-api-key-0123456789';
export const TYPE_USER = 'type-user-0001';
export const TYPE_LINE = 'type-line-0001';
export const TYPE_REPORT = 'type-report-0001';
export const ITEM_TYPES = { user: TYPE_USER, line: TYPE_LINE, report: TYPE_REPORT } as const;
export const CALLBACK_PATH = '/coop/actions';

export interface RsaPair {
  publicPem: string;
  privateKey: KeyObject;
}

let shared: RsaPair | undefined;
/** A fresh RSA pair (2048 bits): the public key as PEM (what Settings shows) and the private key. */
export function newRsaPair(): RsaPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string, privateKey: createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' })) };
}
/** One pair for a whole test file (generating a key costs about 100 ms). */
export function sharedPair(): RsaPair {
  shared ??= newRsaPair();
  return shared;
}

// ---- the documented schemas ----

/** The data fields of the three item types as the setup checklist documents them (name -> Coop field type, required). */
export const DOCUMENTED_FIELDS: Record<'user' | 'line' | 'report', Array<{ name: string; type: string; required: boolean }>> = {
  user: [],
  line: [
    { name: 'text', type: 'STRING', required: true },
    { name: 'author', type: 'STRING', required: true },
    { name: 'datetime', type: 'DATETIME', required: true },
    { name: 'handle', type: 'STRING', required: false },
  ],
  report: [
    { name: 'category', type: 'STRING', required: true },
    { name: 'reportedReason', type: 'STRING', required: false },
    { name: 'rule', type: 'NUMBER', required: false },
    { name: 'aiSeverity', type: 'NUMBER', required: false },
    { name: 'room', type: 'STRING', required: false },
    { name: 'creator', type: 'RELATED_ITEM', required: true },
  ],
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function onlyKeys(problems: string[], where: string, o: Record<string, unknown>, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) problems.push(`${where}: unexpected key ${k}`);
}

function checkData(problems: string[], where: string, data: unknown, fields: ReadonlyArray<{ name: string; type: string; required: boolean }>): void {
  if (!isObj(data)) return void problems.push(`${where}.data: not an object`);
  onlyKeys(problems, `${where}.data`, data, fields.map((f) => f.name));
  for (const f of fields) {
    const v = data[f.name];
    if (v === undefined) {
      if (f.required) problems.push(`${where}.data.${f.name}: required`);
      continue;
    }
    if (f.type === 'STRING' && typeof v !== 'string') problems.push(`${where}.data.${f.name}: not a string`);
    if (f.type === 'NUMBER' && (typeof v !== 'number' || !Number.isFinite(v))) problems.push(`${where}.data.${f.name}: not a number`);
    if (f.type === 'DATETIME' && !(typeof v === 'string' && ISO_RE.test(v))) problems.push(`${where}.data.${f.name}: not an ISO datetime`);
    if (f.type === 'RELATED_ITEM' && !(isObj(v) && isStr(v['id']) && isStr(v['typeId']))) problems.push(`${where}.data.${f.name}: not an item reference`);
  }
}

/** Every way a `POST /api/v1/report` body departs from the documented schema (empty when it is valid). */
export function reportProblems(body: unknown, types: { user: string; line: string; report: string } = ITEM_TYPES): string[] {
  const problems: string[] = [];
  if (!isObj(body)) return ['body: not an object'];
  onlyKeys(problems, 'body', body, ['reporter', 'reportedAt', 'reportedItem', 'reportedForReason', 'reportedItemThread', 'reportedItemsInThread', 'additionalItems']);
  const reporter = body['reporter'];
  if (!isObj(reporter)) problems.push('reporter: required');
  else {
    onlyKeys(problems, 'reporter', reporter, ['kind', 'id', 'typeId']);
    if (reporter['kind'] !== 'user') problems.push('reporter.kind: must be user');
    if (!isStr(reporter['id'])) problems.push('reporter.id: required');
    if (reporter['typeId'] !== types.user) problems.push('reporter.typeId: not the user item type');
  }
  if (!(typeof body['reportedAt'] === 'string' && ISO_RE.test(body['reportedAt']) && !Number.isNaN(Date.parse(body['reportedAt'])))) problems.push('reportedAt: not an ISO datetime');
  const item = body['reportedItem'];
  if (!isObj(item)) problems.push('reportedItem: required');
  else {
    onlyKeys(problems, 'reportedItem', item, ['id', 'typeId', 'data']);
    if (!isStr(item['id'])) problems.push('reportedItem.id: required');
    if (item['typeId'] !== types.report) problems.push('reportedItem.typeId: not the report item type');
    checkData(problems, 'reportedItem', item['data'], DOCUMENTED_FIELDS['report']);
    const creator = isObj(item['data']) ? item['data']['creator'] : undefined;
    if (isObj(creator) && creator['typeId'] !== types.user) problems.push('reportedItem.data.creator.typeId: not the user item type');
  }
  const why = body['reportedForReason'];
  if (why !== undefined) {
    if (!isObj(why)) problems.push('reportedForReason: not an object');
    else {
      onlyKeys(problems, 'reportedForReason', why, ['policyId', 'reason', 'csam']);
      if (why['policyId'] !== undefined && !isStr(why['policyId'])) problems.push('reportedForReason.policyId: not a string');
      if (why['reason'] !== undefined && typeof why['reason'] !== 'string') problems.push('reportedForReason.reason: not a string');
      if (why['csam'] !== undefined) problems.push('reportedForReason.csam: must never be set by the kit');
      if (Object.keys(why).length === 0) problems.push('reportedForReason: empty');
    }
  }
  const thread = body['reportedItemThread'];
  if (thread !== undefined) {
    if (!Array.isArray(thread)) problems.push('reportedItemThread: not an array');
    else
      thread.forEach((t: unknown, i) => {
        if (!isObj(t)) return void problems.push(`reportedItemThread[${i}]: not an object`);
        onlyKeys(problems, `reportedItemThread[${i}]`, t, ['id', 'typeId', 'data', 'datetime']);
        if (!isStr(t['id'])) problems.push(`reportedItemThread[${i}].id: required`);
        if (t['typeId'] !== types.line) problems.push(`reportedItemThread[${i}].typeId: not the line item type`);
        if (!(typeof t['datetime'] === 'string' && ISO_RE.test(t['datetime']))) problems.push(`reportedItemThread[${i}].datetime: not ISO`);
        checkData(problems, `reportedItemThread[${i}]`, t['data'], DOCUMENTED_FIELDS['line']);
      });
  }
  const inThread = body['reportedItemsInThread'];
  if (inThread !== undefined) {
    if (!Array.isArray(inThread)) problems.push('reportedItemsInThread: not an array');
    else
      inThread.forEach((t: unknown, i) => {
        if (!isObj(t)) return void problems.push(`reportedItemsInThread[${i}]: not an object`);
        onlyKeys(problems, `reportedItemsInThread[${i}]`, t, ['id', 'typeId']);
        if (!isStr(t['id']) || t['typeId'] !== types.line) problems.push(`reportedItemsInThread[${i}]: bad reference`);
      });
  }
  if (body['additionalItems'] !== undefined) problems.push('additionalItems: the kit never sends any');
  return problems;
}

// ---- the fake server ----

export interface Call {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: string | undefined;
}

/** One scripted answer for the next `POST /api/v1/report`. */
export interface Scripted {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Never answer (the attempt is aborted by its signal). */
  hang?: boolean;
  /** Reject like a network failure. */
  fail?: boolean;
}

export interface FakeCoopOptions {
  apiKey?: string;
  policies?: Array<{ id: string; name: string }>;
  actions?: Array<{ id: string; name: string }>;
  itemTypes?: Array<{ id: string; name: string; kind: string; schema: Array<{ name: string; type: string; required: boolean }> }>;
}

/** A `fetch` that behaves like the documented Coop API. Records every call; refuses anything the docs do not allow. */
export function fakeCoop(options: FakeCoopOptions = {}) {
  const key = options.apiKey ?? API_KEY;
  const calls: Call[] = [];
  /** Problems the fake found in each report body it was sent (a body that is invalid is answered 400 too). */
  const schemaProblems: string[][] = [];
  /** Methods other than the documented ones, recorded and answered 405. */
  const refused: string[] = [];
  const script: Scripted[] = [];
  let n = 0;
  const jobs: string[] = [];

  const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

  const fn = ((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    let body: unknown;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url: url.toString(), path: url.pathname, headers, body, redirect: init?.redirect });
    const signal = init?.signal ?? undefined;
    if (headers['x-api-key'] !== key) return Promise.resolve(json(401, { error: 'unauthorized' }));
    const path = url.pathname.replace(/\/+$/, '');
    if (method === 'POST' && path === '/api/v1/report') {
      if (headers['content-type'] !== 'application/json') return Promise.resolve(json(400, { error: 'content-type' }));
      const next = script.shift();
      if (next?.fail === true) return Promise.reject(new TypeError('fetch failed'));
      if (next?.hang === true) {
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
        });
      }
      if (next !== undefined && next.status !== 201) return Promise.resolve(json(next.status, next.body ?? { error: 'scripted' }, next.headers));
      const problems = reportProblems(body);
      schemaProblems.push(problems);
      if (problems.length > 0) return Promise.resolve(json(400, { error: 'schema' }));
      const id = `coop-job-${++n}`;
      jobs.push(id);
      if (next?.body !== undefined) return Promise.resolve(json(201, next.body, next.headers));
      return Promise.resolve(json(201, { reportId: id }));
    }
    if (method === 'GET' && path === '/api/v1/policies') return Promise.resolve(json(200, { policies: options.policies ?? [] }));
    if (method === 'GET' && path === '/api/v1/actions') return Promise.resolve(json(200, { actions: options.actions ?? [] }));
    if (method === 'GET' && path === '/api/v1/item_types') return Promise.resolve(json(200, { itemTypes: options.itemTypes ?? [] }));
    refused.push(`${method} ${path}`);
    return Promise.resolve(json(405, { error: 'method' }));
  }) as unknown as typeof fetch;

  return { fetch: fn, calls, schemaProblems, refused, script, jobs, reports: () => calls.filter((c) => c.method === 'POST' && c.path.replace(/\/+$/, '') === '/api/v1/report') };
}
export type FakeCoop = ReturnType<typeof fakeCoop>;

// ---- callbacks ----

/** A moderator decision callback body for kit report `reportId` (override any field; `undefined` drops it). */
export function callbackBody(reportId: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    item: { id: reportId, typeId: TYPE_REPORT, typeName: 'Report' },
    action: { id: 'action-warn' },
    policies: [{ id: 'policy-harass', name: 'Harassment', penalty: 'LOW' }],
    rules: [],
    custom: {},
    actorEmail: 'drakkuun@example.test',
    decisionReason: 'zorbak vlemmo is not allowed',
  };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

export type SigShape = 'plain' | 'v1-body' | 'v1-tbody';

export interface SignedOptions {
  pair?: RsaPair;
  shape?: SigShape;
  /** The `t` of the `t=,v1=` shapes. */
  t?: string;
  /** Header name as sent (default `coop-signature`). */
  headerName?: string;
  /** Send this body instead of the signed one. */
  sendRaw?: string;
  /** Replace or drop headers (undefined drops). */
  headers?: Record<string, string | undefined>;
  /** Replace the signature value. */
  signature?: string;
}

/** Sign `text` as Coop does: RSASSA-PKCS1-v1_5 over SHA-256, base64. */
export function rsaSign(pair: RsaPair, text: string): string {
  return createSign('RSA-SHA256').update(Buffer.from(text, 'utf8')).sign(pair.privateKey).toString('base64');
}

/** A callback request signed with `pair` in the given header shape. */
export function signedCallback(rawBody: string, o: SignedOptions = {}): KitRequest {
  const pair = o.pair ?? sharedPair();
  const shape = o.shape ?? 'plain';
  const t = o.t ?? '1800000000';
  const value =
    o.signature ??
    (shape === 'plain' ? rsaSign(pair, rawBody) : shape === 'v1-body' ? `t=${t},v1=${rsaSign(pair, rawBody)}` : `t=${t},v1=${rsaSign(pair, `${t}.${rawBody}`)}`);
  const headers: Record<string, string> = { [o.headerName ?? 'coop-signature']: value };
  for (const [k, v] of Object.entries(o.headers ?? {})) {
    if (v === undefined) delete headers[k];
    else headers[k] = v;
  }
  return { method: 'POST', path: CALLBACK_PATH, query: {}, headers, body: undefined, rawBody: o.sendRaw ?? rawBody };
}

/** A body (object or text) signed and ready to send. */
export const callbackRequest = (body: unknown, o: SignedOptions = {}): KitRequest => signedCallback(typeof body === 'string' ? body : JSON.stringify(body), o);

/** A recording logger. */
export function recordingLogger() {
  const logged: Array<[string, Record<string, string | number | boolean> | undefined]> = [];
  return { logged, logger: { warn: (event: string, detail?: Record<string, string | number | boolean>) => void logged.push([event, detail]) } };
}

// ---- a whole adapter on a real kit ----

/** The Coop action ids the tests map. */
export const ACTION = {
  warn: 'action-warn',
  chat: 'action-chat',
  ban7: 'action-ban7',
  banPerm: 'action-banperm',
  note: 'action-note',
  dismiss: 'action-dismiss',
  badFaith: 'action-badfaith',
} as const;

export interface CoopWorldOptions {
  options?: Record<string, unknown>;
  world?: WorldOptions;
  fake?: FakeCoopOptions;
  /** Wrap the kit the ADAPTER sees (a proxy that fails a call); the test still reads the real one through `cw` and `w`. */
  wrapKit?: (cw: Chatwarden) => Chatwarden;
}

type W = Awaited<ReturnType<typeof world>>;

/** An adapter on kit world `w` (the kit keeps its own clock), with a fake Coop and a recording logger. */
export function makeCoop(w: W, over: CoopWorldOptions = {}) {
  const fake = fakeCoop(over.fake);
  const { logged, logger } = recordingLogger();
  const active = w.cw.rules.active();
  const ruleA = active[0]!.number;
  const ruleB = active[1]!.number;
  const kit = over.wrapKit === undefined ? w.cw : over.wrapKit(w.cw);
  const adapter = coop(kit, {
    baseUrl: COOP_URL,
    apiKey: API_KEY,
    webhookPublicKey: sharedPair().publicPem,
    itemTypes: { ...ITEM_TYPES },
    evidence: 'excerpt',
    actions: {
      [ACTION.warn]: { verdict: 'upheld', kind: 'warning' },
      [ACTION.chat]: { verdict: 'upheld', kind: 'chat', durationMs: 86_400_000 },
      [ACTION.ban7]: { verdict: 'upheld', kind: 'ban', durationMs: 7 * 86_400_000 },
      [ACTION.banPerm]: { verdict: 'upheld', kind: 'ban' },
      [ACTION.note]: { verdict: 'noted' },
      [ACTION.dismiss]: { verdict: 'no_action' },
      [ACTION.badFaith]: { verdict: 'bad_faith' },
    },
    rules: { 'policy-harass': ruleA, 'policy-spam': ruleB },
    fetch: fake.fetch,
    clock: w.clock,
    random: () => 0.5,
    logger,
    ...over.options,
  } as unknown as CoopOptions);
  const router = createRouter(adapter.routes);
  return { w, cw: w.cw, fake, adapter, logged, router, send: (req: KitRequest) => router(req), ruleA, ruleB };
}

/** A kit world with an adapter already subscribed. */
export async function coopWorld(over: CoopWorldOptions = {}) {
  const w = await world(over.world);
  return makeCoop(w, over);
}
export type CoopWorld = Awaited<ReturnType<typeof coopWorld>>;

/** Wait (real timers) until `check` holds. */
export async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > 4000) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

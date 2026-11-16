import { CORPUS_ZIP_PASSWORD } from '@chatwarden/matcher/corpus';
import { ATTRIBUTION } from '../build/texts.js';
import { ToolError } from './errors.js';

// The Zenodo archive (design 11): a new version of the project's record for every release, with the zip, its signature and its manifest, a CC BY 4.0
// licence, the content warning and the signing keys' fingerprints in the description. Zenodo's REST deposit workflow, in the order its documentation
// gives: new version, the draft, drop the carried-over files, upload to the draft's bucket, set the metadata, publish. The token is sent in the
// Authorization header only, and an answer from Zenodo is never passed on: an error is a fixed sentence with the step and the HTTP status.

export interface ZenodoRelease {
  kind: 'terms' | 'eval';
  version: string;
  zip: Uint8Array;
  /** The signature file's bytes. */
  sig: Uint8Array;
  /** `manifest.json` out of the zip, as a plain file. */
  manifest: Uint8Array;
  /** The public keys' ids and SHA-256 fingerprints (hex), for the description. */
  keys: readonly { id: string; fingerprint: string }[];
}

export interface ZenodoOptions {
  fetch: typeof fetch;
  token: string;
  /** The deposition id of the latest published version of the project's record. */
  record: number;
  /** Default `https://zenodo.org`; the sandbox is `https://sandbox.zenodo.org`. */
  baseUrl?: string;
  /** `YYYY-MM-DD`, from the injected clock. */
  today: string;
  creator?: string;
}

export interface ZenodoResult {
  kind: 'terms' | 'eval';
  version: string;
  doi: string;
  fileUrl: string;
  recordId: number;
  depositionId: number;
}

export interface ZenodoMetadata {
  upload_type: 'dataset';
  title: string;
  description: string;
  creators: { name: string }[];
  access_right: 'open';
  license: 'cc-by-4.0';
  version: string;
  publication_date: string;
  keywords: string[];
}

const DEFAULT_BASE = 'https://zenodo.org';
const STEP_MESSAGE = (step: string, how: string): string => `zenodo step "${step}" failed (${how}); nothing was added to the index`;

export function zenodoMetadata(release: ZenodoRelease, options: { today: string; creator?: string }): ZenodoMetadata {
  const what = release.kind === 'terms' ? 'community term list' : 'eval and calibration set';
  const files = release.kind === 'terms' ? 'terms.json, exceptions.json, negative.[language].json and positive.json' : 'cases.[language].json';
  const keys = release.keys.map((k) => `<li><code>${k.id}</code>: <code>${k.fingerprint}</code></li>`).join('');
  const description = [
    `<p><strong>CONTENT WARNING.</strong> This archive is a ${what} for content moderation. It contains abusive words and lines, kept so that software can filter them and so that moderators can be calibrated. It is made for moderation and research, and is not an endorsement of any word in it.</p>`,
    `<p>Release ${release.version}. The zip holds manifest.json, ${files}, README.txt and LICENSE.txt, encrypted with the public password <code>${CORPUS_ZIP_PASSWORD}</code> (scanner hygiene, not secrecy). ${ATTRIBUTION}</p>`,
    `<p>How to check it: the signature file is an Ed25519 signature over <code>chatwarden-corpus/1</code>, a zero byte, <code>zip</code>, a zero byte and the zip's bytes. The signing keys are listed here by the SHA-256 fingerprint of the raw public key; compare them with the project's docs page and with <code>packages/matcher/src/corpus/keys.ts</code>.</p>`,
    `<ul>${keys}</ul>`,
    `<p>The loader in <code>@chatwarden/matcher/corpus</code> verifies the signature before it reads a byte of the zip.</p>`,
  ].join('\n');
  return {
    upload_type: 'dataset',
    title: release.kind === 'terms' ? `Chatwarden community term list ${release.version}` : `Chatwarden eval and calibration set ${release.version}`,
    description,
    creators: [{ name: options.creator ?? 'Chatwarden maintainers' }],
    access_right: 'open',
    license: 'cc-by-4.0',
    version: release.version,
    publication_date: options.today,
    keywords: ['content moderation', 'word filter', 'chat', 'dataset'],
  };
}

interface Answer {
  status: number;
  json: Record<string, unknown>;
}

export async function publishToZenodo(o: ZenodoOptions, release: ZenodoRelease): Promise<ZenodoResult> {
  const base = (o.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const stem = `${release.kind}-${release.version}`;
  const names = { zip: `${stem}.zip`, sig: `${stem}.zip.sig`, manifest: `${stem}.manifest.json` };

  const call = async (step: string, method: string, url: string, body?: Uint8Array | Record<string, unknown>): Promise<Answer> => {
    if (!url.startsWith(`${base}/`)) throw new ToolError('zenodo', STEP_MESSAGE(step, 'a link that is not on Zenodo'));
    const headers: Record<string, string> = { authorization: `Bearer ${o.token}`, 'user-agent': 'chatwarden-corpus-tools' };
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array) {
      headers['content-type'] = 'application/octet-stream';
      payload = body;
    } else if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await o.fetch(url, { method, headers, ...(payload === undefined ? {} : { body: payload }), redirect: 'error' });
    } catch {
      throw new ToolError('zenodo', STEP_MESSAGE(step, 'no answer'));
    }
    if (!res.ok) throw new ToolError('zenodo', STEP_MESSAGE(step, `HTTP ${res.status}`));
    let json: Record<string, unknown> = {};
    if (res.status !== 204) {
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch {
        throw new ToolError('zenodo', STEP_MESSAGE(step, 'an answer that is not JSON'));
      }
    }
    return { status: res.status, json };
  };
  const link = (step: string, json: Record<string, unknown>, name: string): string => {
    const links = json.links as Record<string, unknown> | undefined;
    const url = links?.[name];
    if (typeof url !== 'string') throw new ToolError('zenodo', STEP_MESSAGE(step, `no ${name} link`));
    return url;
  };
  const published = (json: Record<string, unknown>): ZenodoResult | null => {
    const meta = json.metadata as { version?: unknown } | undefined;
    if (json.submitted !== true || meta?.version !== release.version || typeof json.doi !== 'string') return null;
    const id = Number(json.id);
    const recordId = Number(json.record_id ?? json.id);
    return { kind: release.kind, version: release.version, doi: json.doi, fileUrl: `${base}/records/${recordId}/files/${names.zip}?download=1`, recordId, depositionId: id };
  };

  // 1. The record the owner named: if it already is this version, there is nothing to do.
  const depositions = `${base}/api/deposit/depositions`;
  const current = await call('lookup', 'GET', `${depositions}/${o.record}`);
  const already = published(current.json);
  if (already !== null) return already;

  // 2. A new version: the draft. (Zenodo allows one unpublished draft at a time, and gives the same one again until it is published: a run that stopped part-way is finished by running it again.)
  const made = await call('newversion', 'POST', `${depositions}/${o.record}/actions/newversion`);
  const draftUrl = link('newversion', made.json, 'latest_draft');
  const draft = (await call('draft', 'GET', draftUrl)).json;
  const done = published(draft);
  if (done !== null) return done;
  const draftId = Number(draft.id);
  if (!Number.isSafeInteger(draftId) || draftId < 1) throw new ToolError('zenodo', STEP_MESSAGE('draft', 'no draft id'));
  const bucket = link('draft', draft, 'bucket');

  // 3. The draft starts with the previous version's files; the new version has exactly its own.
  const carried = Array.isArray(draft.files) ? (draft.files as { id?: unknown }[]) : [];
  for (const f of carried) {
    if (typeof f.id !== 'string' || !/^[\w-]+$/.test(f.id)) throw new ToolError('zenodo', STEP_MESSAGE('delete', 'a file id it cannot use'));
    await call('delete', 'DELETE', `${depositions}/${draftId}/files/${f.id}`);
  }
  for (const [name, bytes] of [[names.zip, release.zip], [names.sig, release.sig], [names.manifest, release.manifest]] as const) {
    await call('upload', 'PUT', `${bucket}/${name}`, bytes);
  }
  await call('metadata', 'PUT', `${depositions}/${draftId}`, { metadata: zenodoMetadata(release, { today: o.today, ...(o.creator === undefined ? {} : { creator: o.creator }) }) });
  const out = await call('publish', 'POST', `${depositions}/${draftId}/actions/publish`);
  const result = published({ ...out.json, submitted: out.json.submitted ?? true, metadata: { version: release.version } });
  if (result === null) throw new ToolError('zenodo', STEP_MESSAGE('publish', 'an answer with no DOI'));
  return result;
}

// A fake of the part of Zenodo's REST API the tool uses (https://developers.zenodo.org, deposit workflow for a new version). It checks what a real
// server checks (the bearer token in the header, never in a url; the required metadata) and records every call, with the token replaced by a marker,
// so a test can assert the exact call sequence. A failure can be injected at any step, and its body then echoes the token, to prove it never travels on.

export const TOKEN = 'zenodo-test-token-9f3a7c1e5b2d4086';
export const ZENODO = 'https://zenodo.org';

export type Step = 'lookup' | 'newversion' | 'draft' | 'delete' | 'upload' | 'metadata' | 'publish';

interface Deposition {
  id: number;
  conceptrecid: string;
  state: 'done' | 'unsubmitted';
  submitted: boolean;
  metadata: Record<string, unknown>;
  files: { id: string; filename: string; filesize: number }[];
  doi?: string;
  record_id?: number;
}

export interface FakeCall {
  method: string;
  path: string;
  /** For a JSON body, the parsed body; for bytes, their length. */
  body?: unknown;
}

export class FakeZenodo {
  depositions = new Map<number, Deposition>();
  calls: FakeCall[] = [];
  /** Fail the next call of this step with this status (the body echoes the token). */
  failing = new Map<Step, number>();
  /** Every Authorization header seen was this one, and no url held the token. */
  badAuth = 0;
  tokenInUrl = 0;
  uploaded = new Map<string, Uint8Array>();
  private nextId = 2000;
  private fileCounter = 0;
  draftOf = new Map<number, number>();

  constructor(first: { id: number; version: string; files?: string[] }) {
    this.depositions.set(first.id, {
      id: first.id,
      conceptrecid: '999',
      state: 'done',
      submitted: true,
      metadata: { title: 'old', version: first.version, upload_type: 'dataset' },
      files: (first.files ?? ['old.zip']).map((filename, i) => ({ id: `f${i}`, filename, filesize: 10 })),
      doi: `10.5281/zenodo.${first.id}`,
      record_id: first.id,
    });
  }

  private resource(d: Deposition): Record<string, unknown> {
    const draft = this.draftOf.get(d.id);
    return {
      id: d.id,
      conceptrecid: d.conceptrecid,
      state: d.state,
      submitted: d.submitted,
      metadata: d.metadata,
      files: d.files,
      ...(d.doi === undefined ? {} : { doi: d.doi, doi_url: `https://doi.org/${d.doi}`, record_id: d.record_id }),
      links: { bucket: `${ZENODO}/api/files/bucket-${d.id}`, ...(draft === undefined ? {} : { latest_draft: `${ZENODO}/api/deposit/depositions/${draft}` }) },
    };
  }

  private fail(step: Step): Response | null {
    const status = this.failing.get(step);
    if (status === undefined) return null;
    this.failing.delete(step);
    return new Response(JSON.stringify({ message: `error, token ${TOKEN} was seen`, status }), { status });
  }

  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    if (url.includes(TOKEN)) this.tokenInUrl += 1;
    if (headers.get('authorization') !== `Bearer ${TOKEN}`) {
      this.badAuth += 1;
      return new Response('{"message":"unauthorized"}', { status: 401 });
    }
    if (!url.startsWith(ZENODO)) return new Response('no', { status: 404 });
    const path = url.slice(ZENODO.length);
    const raw = init?.body;
    const json = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : undefined;
    this.calls.push({ method, path, ...(json !== undefined ? { body: json } : raw !== undefined && raw !== null ? { body: (raw as Uint8Array).length } : {}) });

    let m: RegExpExecArray | null;
    if ((m = /^\/api\/deposit\/depositions\/(\d+)$/.exec(path)) && method === 'GET') {
      const d = this.depositions.get(Number(m[1]));
      const isDraft = d !== undefined && d.state === 'unsubmitted';
      const failed = this.fail(isDraft ? 'draft' : 'lookup');
      if (failed !== null) return failed;
      return d === undefined ? new Response('{}', { status: 404 }) : Response.json(this.resource(d));
    }
    if ((m = /^\/api\/deposit\/depositions\/(\d+)\/actions\/newversion$/.exec(path)) && method === 'POST') {
      const failed = this.fail('newversion');
      if (failed !== null) return failed;
      const d = this.depositions.get(Number(m[1]));
      if (d === undefined) return new Response('{}', { status: 404 });
      if (!this.draftOf.has(d.id)) {
        const id = (this.nextId += 1);
        this.depositions.set(id, { id, conceptrecid: d.conceptrecid, state: 'unsubmitted', submitted: false, metadata: { ...d.metadata, version: undefined }, files: d.files.map((f) => ({ ...f })) });
        this.draftOf.set(d.id, id);
      }
      return Response.json(this.resource(d), { status: 201 });
    }
    if ((m = /^\/api\/deposit\/depositions\/(\d+)\/files\/([\w-]+)$/.exec(path)) && method === 'DELETE') {
      const failed = this.fail('delete');
      if (failed !== null) return failed;
      const d = this.depositions.get(Number(m[1]));
      if (d === undefined || d.submitted) return new Response('{}', { status: 403 });
      d.files = d.files.filter((f) => f.id !== m![2]);
      return new Response(null, { status: 204 });
    }
    if ((m = /^\/api\/files\/bucket-(\d+)\/([\w.-]+)$/.exec(path)) && method === 'PUT') {
      const failed = this.fail('upload');
      if (failed !== null) return failed;
      const d = this.depositions.get(Number(m[1]));
      if (d === undefined || d.submitted) return new Response('{}', { status: 403 });
      const bytes = raw as Uint8Array;
      this.uploaded.set(m[2] as string, bytes.slice());
      d.files = [...d.files.filter((f) => f.filename !== m![2]), { id: `up${(this.fileCounter += 1)}`, filename: m[2] as string, filesize: bytes.length }];
      return Response.json({ key: m[2], size: bytes.length });
    }
    if ((m = /^\/api\/deposit\/depositions\/(\d+)$/.exec(path)) && method === 'PUT') {
      const failed = this.fail('metadata');
      if (failed !== null) return failed;
      const d = this.depositions.get(Number(m[1]));
      const md = (json as { metadata?: Record<string, unknown> } | undefined)?.metadata;
      if (d === undefined || d.submitted || md === undefined) return new Response('{}', { status: 400 });
      for (const k of ['upload_type', 'title', 'creators', 'description']) if (md[k] === undefined) return new Response(`{"message":"${k} required"}`, { status: 400 });
      d.metadata = md;
      return Response.json(this.resource(d));
    }
    if ((m = /^\/api\/deposit\/depositions\/(\d+)\/actions\/publish$/.exec(path)) && method === 'POST') {
      const failed = this.fail('publish');
      if (failed !== null) return failed;
      const d = this.depositions.get(Number(m[1]));
      if (d === undefined || d.submitted) return new Response('{}', { status: 400 });
      d.state = 'done';
      d.submitted = true;
      d.record_id = d.id;
      d.doi = `10.5281/zenodo.${d.id}`;
      return Response.json(this.resource(d), { status: 202 });
    }
    return new Response('{"message":"no such route"}', { status: 404 });
  };

  /** The call sequence as `METHOD path` lines, ids replaced by `:id`. */
  sequence(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/bucket-\d+/, 'bucket-:id')}`);
  }
  get published(): Deposition[] {
    return [...this.depositions.values()].filter((d) => d.submitted);
  }
  get drafts(): Deposition[] {
    return [...this.depositions.values()].filter((d) => !d.submitted);
  }
}

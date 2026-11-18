import { describe, expect, it } from 'vitest';
import { errorOf, world } from './world.js';

// L2: `matchMode` on the term routes. POST /terms and PATCH /terms/:id take it (validated), GET /terms returns it for a row that has one, POST /terms/check answers for a mode, and a mode that does not fit is the
// same 400 `invalid_term` every other refused term is. Invented strings only.

const FRAGMENT = '\u5c14\u5df4\u5c3c';
const INSIDE = '\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38';
const OUTSIDE = '\u4f60\u597d\uff0c\u5c14\u5df4\u5c3c\u3002\u518d\u89c1';
const HAN = '\u4f50\u5c14\u5df4\u514b';

type W = Awaited<ReturnType<typeof world>>;
interface Row {
  id: string;
  term: string;
  matchMode?: string;
}
const rows = async (w: W): Promise<Row[]> => ((await w.call('GET', '/terms')).body as { terms: Row[] }).terms;
const post = (w: W, body: unknown, role: 'moderator' | 'senior' | 'owner' = 'moderator') => w.call('POST', '/terms', { role, body });
const patch = (w: W, id: string, body: unknown) => w.call('PATCH', `/terms/${id}`, { role: 'moderator', body });
const blockedBy = async (w: W, text: string): Promise<string | null> => ((await w.call('POST', '/terms/test', { role: 'moderator', body: { text } })).body as { termId: string | null }).termId;

describe('POST /terms', () => {
  it('takes matchMode: a Han term with contains is stored and blocks inside the longer word; with none it is a segment and does not', async () => {
    const w = await world();
    const a = await post(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' });
    expect(a.status).toBe(200);
    const idA = (a.body as { id: string }).id;
    expect(await blockedBy(w, INSIDE)).toBe(idA);
    const w2 = await world();
    const b = await post(w2, { term: FRAGMENT, language: 'zh' });
    expect(b.status).toBe(200);
    expect(await blockedBy(w2, INSIDE)).toBeNull();
    expect(await blockedBy(w2, OUTSIDE)).toBe((b.body as { id: string }).id);
  });

  it('null is no mode, and word is fine on a Latin term', async () => {
    const w = await world();
    expect((await post(w, { term: HAN, language: 'zh', matchMode: null })).status).toBe(200);
    expect((await post(w, { term: 'glarnish', language: 'en', matchMode: 'word' })).status).toBe(200);
    expect((await post(w, { term: 'tarvonish', language: 'en', matchMode: null })).status).toBe(200);
  });

  it('a mode that does not fit, an unknown mode and a mode of the wrong type are 400 invalid_term, and nothing is added', async () => {
    const w = await world();
    const before = (await rows(w)).length;
    for (const body of [
      { term: 'glarnish', language: 'en', matchMode: 'segment' },
      { term: 'glarnish', language: 'en', matchMode: 'contains' },
      { term: HAN, language: 'zh', matchMode: 'word' },
      { term: HAN, language: 'zh', matchMode: 'fuzzy' },
      { term: HAN, language: 'zh', matchMode: '' },
      { term: HAN, language: 'zh', matchMode: 5 },
      { term: HAN, language: 'zh', matchMode: {} },
      { term: HAN, language: 'zh', matchMode: ['contains'] },
      { term: HAN, language: 'en' },
      { term: HAN.slice(0, 2), language: 'zh', matchMode: 'contains' },
    ]) {
      const res = await post(w, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res), JSON.stringify(body)).toBe('invalid_term');
      expect(JSON.stringify(res.body)).not.toContain(HAN);
    }
    expect(await rows(w)).toHaveLength(before);
  });

  it('needs terms.write, and the audit rows hold the id, never the text or the mode', async () => {
    const w = await world({ permissions: { 'terms.write': 'owner' } });
    expect((await post(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' }, 'moderator')).status).toBe(403);
    expect((await post(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' }, 'owner')).status).toBe(200);
    const routeRows = w.routeAudit().filter((r) => r.action === 'term.add');
    expect(routeRows).toHaveLength(1);
    expect(JSON.stringify(routeRows)).not.toContain(FRAGMENT);
  });
});

describe('GET /terms', () => {
  it('returns matchMode for a row that has one, and no key at all for a row that has none', async () => {
    const w = await world();
    const added = (await post(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' })).body as { id: string };
    const plain = (await post(w, { term: HAN, language: 'zh' })).body as { id: string };
    const list = await rows(w);
    expect(list.find((r) => r.id === added.id)?.matchMode).toBe('contains');
    expect(Object.hasOwn(list.find((r) => r.id === plain.id) as object, 'matchMode')).toBe(false);
    expect(Object.hasOwn(list.find((r) => r.term === 'zorbak') as object, 'matchMode')).toBe(false);
  });
});

describe('PATCH /terms/:id', () => {
  it('sets the mode, and the matcher follows at once; null clears it back to the default', async () => {
    const w = await world();
    const { id } = (await post(w, { term: FRAGMENT, language: 'zh' })).body as { id: string };
    expect(await blockedBy(w, INSIDE)).toBeNull();
    expect((await patch(w, id, { matchMode: 'contains' })).status).toBe(200);
    expect(await blockedBy(w, INSIDE)).toBe(id);
    expect((await rows(w)).find((r) => r.id === id)?.matchMode).toBe('contains');
    expect((await patch(w, id, { matchMode: null })).status).toBe(200);
    expect(await blockedBy(w, INSIDE)).toBeNull();
    expect(Object.hasOwn((await rows(w)).find((r) => r.id === id) as object, 'matchMode')).toBe(false);
  });

  it('a mode alone is a change (not the empty patch of 400 invalid_request), and a bad one is 400 invalid_term with the old mode kept', async () => {
    const w = await world();
    const { id } = (await post(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' })).body as { id: string };
    for (const matchMode of ['word', 'fuzzy', 5, {}]) {
      const res = await patch(w, id, { matchMode });
      expect(res.status, JSON.stringify(matchMode)).toBe(400);
      expect(errorOf(res)).toBe('invalid_term');
    }
    expect((await rows(w)).find((r) => r.id === id)?.matchMode).toBe('contains');
    expect(errorOf(await patch(w, id, {}))).toBe('invalid_request');
  });

  it('a Latin term cannot be given segment or contains, and an unknown id is still 404', async () => {
    const w = await world();
    const zorbak = (await rows(w)).find((r) => r.term === 'zorbak') as Row;
    expect(errorOf(await patch(w, zorbak.id, { matchMode: 'contains' }))).toBe('invalid_term');
    expect((await patch(w, 'syn:nothing', { matchMode: 'contains' })).status).toBe(404);
  });

  it('a mode together with a word and a language changes all three', async () => {
    const w = await world();
    const { id } = (await post(w, { term: FRAGMENT, language: 'zh' })).body as { id: string };
    expect((await patch(w, id, { term: HAN, language: 'ja', matchMode: 'contains' })).status).toBe(200);
    expect((await rows(w)).find((r) => r.id === id)).toMatchObject({ term: HAN, language: 'ja', matchMode: 'contains' });
  });
});

describe('POST /terms/check', () => {
  const check = (w: W, body: unknown) => w.call('POST', '/terms/check', { role: 'moderator', body });
  const lines = [INSIDE, OUTSIDE, '\u4f60\u597d\u518d\u89c1'];

  it('answers per mode: the hits of that mode and the mode used; no mode is segment', async () => {
    const w = await world({ recentLines: () => lines });
    const segment = await check(w, { term: FRAGMENT, language: 'zh' });
    expect(segment.body).toEqual({ hits: [OUTSIDE], matchMode: 'segment' });
    expect((await check(w, { term: FRAGMENT, language: 'zh', matchMode: 'segment' })).body).toEqual({ hits: [OUTSIDE], matchMode: 'segment' });
    const contains = (await check(w, { term: FRAGMENT, language: 'zh', matchMode: 'contains' })).body as { hits: string[]; matchMode: string };
    expect(contains.matchMode).toBe('contains');
    expect(contains.hits.sort()).toEqual([INSIDE, OUTSIDE].sort());
    expect(contains.hits.length).toBeGreaterThan((segment.body as { hits: string[] }).hits.length);
  });

  it('a Latin term answers as it always did (no mode key), and a bad mode or a mode that does not fit is 400 invalid_term', async () => {
    const w = await world({ recentLines: () => ['you glarnish'] });
    expect((await check(w, { term: 'glarnish', language: 'en' })).body).toEqual({ hits: ['you glarnish'] });
    expect((await check(w, { term: 'glarnish', language: 'en', matchMode: 'word' })).body).toEqual({ hits: ['you glarnish'] });
    for (const body of [{ term: 'glarnish', language: 'en', matchMode: 'contains' }, { term: HAN, language: 'zh', matchMode: 'word' }, { term: HAN, language: 'zh', matchMode: 'fuzzy' }, { term: HAN, language: 'zh', matchMode: 5 }]) {
      const res = await check(w, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(errorOf(res)).toBe('invalid_term');
    }
  });

  it('is terms.read, writes no audit row, and the term is not in a log line', async () => {
    const w = await world({ permissions: { 'terms.read': 'owner' } });
    expect((await w.call('POST', '/terms/check', { role: 'moderator', body: { term: FRAGMENT, language: 'zh' } })).status).toBe(403);
    expect((await w.call('POST', '/terms/check', { role: 'owner', body: { term: FRAGMENT, language: 'zh' } })).status).toBe(200);
    expect(w.routeAudit().filter((r) => r.action.startsWith('term.'))).toEqual([]);
    expect(JSON.stringify(w.logged)).not.toContain(FRAGMENT);
  });
});

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { adminRoutes, createRouter, playerRoutes } from '@chatwarden/http';
import type { KitRequest } from '@chatwarden/http';

// The team's working principles never reach a player: the note, a tier's description and a tier's outcome are staff-only. A tier's title and examples are public
// (they are in the code of conduct). Synthetic words only.

const NOTE = 'zorbak staff only working note';
const DESCRIPTION = 'quissel staff description';
const OUTCOME = 'snerp staff outcome';
const TITLE = 'vlemmo public tier title';
const EXAMPLE = 'drakkuun public example line';
const STAFF = [NOTE, DESCRIPTION, OUTCOME];

const ALICE: RawWho = { clientKey: 'raw-key-alice-0001-secret', ip: '203.0.113.11' };
const NOW = 1_800_000_000_000;

async function setup() {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const clock = { t: NOW, now: () => clock.t };
  const cw = await createChatwarden({
    store,
    secret: 'principles-secret',
    platform: { identify: (ctx: unknown) => ctx as RawWho },
    clock,
    retention: false,
    overrides: { teamNotes: [{ text: NOTE }] },
  });
  const saved = cw.policy.save(
    {
      guidelines: {
        tiers: [{ title: TITLE, description: DESCRIPTION, examples: [EXAMPLE], covers: ['banter', 'rude', 'hostile', 'severe'], outcome: OUTCOME }],
      },
    },
    { version: 0, actor: 'owner_ann', reason: 'principles' },
  );
  expect(saved.ok).toBe(true);
  const player = createRouter(playerRoutes(cw, { identify: (req: KitRequest) => ({ clientKey: req.headers['x-key'] ?? '' }) as RawWho, now: () => clock.t }));
  const staff = createRouter(adminRoutes(cw, { authorize: () => ({ actor: 'owner_ann', role: 'owner' }) }));
  const get = (path: string, query: Record<string, string> = {}) => player({ method: 'GET', path, query, headers: { 'x-key': ALICE.clientKey as string }, body: undefined });
  return { cw, get, staff };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : JSON.stringify(v));

describe('what a player can read never carries the staff-only principles', () => {
  it('GET /code-of-conduct in markdown, html and text holds none of the three strings, but does hold the tier title and example (control)', async () => {
    const { get } = await setup();
    for (const format of ['markdown', 'html', 'text']) {
      const res = await get('/code-of-conduct', { format });
      expect(res.status, format).toBe(200);
      const body = text(res.body);
      for (const s of STAFF) expect(body, `${format}: ${s}`).not.toContain(s);
      expect(body, `${format} title`).toContain(TITLE);
      expect(body, `${format} example`).toContain(EXAMPLE);
    }
    const dflt = await get('/code-of-conduct');
    for (const s of STAFF) expect(text(dflt.body)).not.toContain(s);
  });

  it('GET /rules, GET /notices and GET /record hold none either', async () => {
    const { get } = await setup();
    for (const path of ['/rules', '/notices', '/record']) {
      const res = await get(path);
      expect(res.status, path).toBe(200);
      const body = text(res.body);
      for (const s of STAFF) expect(body, `${path}: ${s}`).not.toContain(s);
    }
  });

  it('control: GET /policy for staff DOES carry the note in profile.teamNotes and in documents.moderatorGuide', async () => {
    const { staff } = await setup();
    const res = await staff({ method: 'GET', path: '/policy', query: {}, headers: {}, body: undefined });
    expect(res.status).toBe(200);
    const body = res.body as { profile: { teamNotes: Array<{ text: string }> }; documents: { moderatorGuide: string; agentBrief: string } };
    expect(body.profile.teamNotes.map((n) => n.text)).toEqual([NOTE]);
    expect(body.documents.moderatorGuide).toContain(NOTE);
    expect(body.documents.moderatorGuide).toContain(DESCRIPTION);
    expect(body.documents.agentBrief).toContain(NOTE);
  });
});

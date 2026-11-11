import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '@chatwarden/core';
import { DAY, errorOf, world } from './world.js';

describe('GET /policy', () => {
  it('returns the profile, rules, summary and the three generated documents, and audits policy.view with no target', async () => {
    const { call, cw, routeAudit, clock } = await world({ gameName: 'Quissel Quest' });
    const res = await call('GET', '/policy', { actor: 'ann', role: 'moderator' });
    expect(res.status).toBe(200);
    const body = res.body as {
      profile: unknown;
      rules: unknown;
      summary: string;
      documents: { codeOfConduct: string; moderatorGuide: string; agentBrief: string };
    };
    expect(Object.keys(body).sort()).toEqual(['documents', 'profile', 'rules', 'summary']);
    expect(Object.keys(body.documents).sort()).toEqual(['agentBrief', 'codeOfConduct', 'moderatorGuide']);
    expect(body.profile).toEqual(JSON.parse(JSON.stringify(cw.profile)));
    expect(body.rules).toEqual(JSON.parse(JSON.stringify(cw.rules.all())));
    expect(body.summary).toBe(cw.summary);
    expect(body.documents.codeOfConduct).toBe(cw.documents.codeOfConduct({ format: 'markdown', gameName: 'Quissel Quest' }));
    expect(body.documents.moderatorGuide).toBe(cw.documents.moderatorGuide({ format: 'markdown' }));
    expect(body.documents.agentBrief).toBe(cw.documents.agentBrief());
    expect(body.documents.codeOfConduct).toContain('Quissel Quest');
    expect(routeAudit()).toEqual([
      { id: expect.any(String), at: clock.t, actor: 'ann', role: 'moderator', action: 'policy.view' },
    ]);
  });

  it('has a default game name when none is configured', async () => {
    const { call } = await world();
    const res = await call('GET', '/policy');
    expect(res.status).toBe(200);
    expect((res.body as { documents: { codeOfConduct: string } }).documents.codeOfConduct.length).toBeGreaterThan(50);
  });

  it('a configured contact link reaches the code of conduct', async () => {
    const { call } = await world({ contactUrl: 'https://example.test/appeal' });
    const res = await call('GET', '/policy');
    expect((res.body as { documents: { codeOfConduct: string } }).documents.codeOfConduct).toContain('https://example.test/appeal');
  });

  it('?format picks the rendering (markdown default, html, text); anything else is 400 invalid_query', async () => {
    const { call, cw } = await world({ gameName: 'Quissel Quest' });
    for (const format of ['markdown', 'html', 'text'] as const) {
      const res = await call('GET', '/policy', { query: { format } });
      expect((res.body as { documents: { moderatorGuide: string } }).documents.moderatorGuide).toBe(cw.documents.moderatorGuide({ format }));
    }
    const bad = await call('GET', '/policy', { query: { format: 'pdf' } });
    expect([bad.status, errorOf(bad)]).toEqual([400, 'invalid_query']);
  });

  it('?omit leaves the named sections out of the moderator guide only, and the default is the whole guide', async () => {
    const { call, cw } = await world();
    const guide = async (omit?: string) =>
      ((await call('GET', '/policy', omit === undefined ? {} : { query: { omit } })).body as { documents: { moderatorGuide: string; codeOfConduct: string }; rules: unknown[] }).documents.moderatorGuide;
    expect(await guide()).toBe(cw.documents.moderatorGuide({ format: 'markdown' }));
    expect(await guide('rules')).toBe(cw.documents.moderatorGuide({ format: 'markdown', omitSections: ['rules'] }));
    expect(await guide('ladder')).toBe(cw.documents.moderatorGuide({ format: 'markdown', omitSections: ['ladder'] }));
    expect(await guide('rules,ladder')).toBe(cw.documents.moderatorGuide({ format: 'markdown', omitSections: ['rules', 'ladder'] }));
    expect(await guide('ladder,rules')).toBe(await guide('rules,ladder'));
    expect(await guide('')).toBe(await guide());
    expect(await guide('rules,ladder')).not.toContain('## Community Rules');
    // The data is still all there: only the generated document changes.
    const res = (await call('GET', '/policy', { query: { omit: 'rules,ladder' } })).body as { rules: unknown[]; profile: { ladder: unknown[] } };
    expect(res.rules).toHaveLength(cw.rules.all().length);
    expect(res.profile.ladder).toHaveLength(cw.profile.ladder.length);
  });

  it('?omit with a section it does not know is 400 invalid_query and writes no audit row', async () => {
    const { call, routeAudit } = await world();
    for (const bad of ['levels', 'rules,levels', 'rules;ladder', ' rules', 'Rules']) {
      const res = await call('GET', '/policy', { query: { omit: bad } });
      expect([res.status, errorOf(res)], bad).toEqual([400, 'invalid_query']);
    }
    expect(routeAudit()).toEqual([]);
  });

  it('a custom profile and rules are what is shown', async () => {
    const { call, cw } = await world();
    const res = await call('GET', '/policy');
    expect((res.body as { rules: Array<{ number: number }> }).rules.map((r) => r.number)).toEqual(cw.rules.all().map((r) => r.number));
    expect((res.body as { profile: { name?: string } }).profile).toEqual(JSON.parse(JSON.stringify(cw.profile)));
  });

  it('is gated by policy.read, and fails closed (500) when the view cannot be audited', async () => {
    const raised = await world({ permissions: { 'policy.read': 'senior' } });
    expect((await raised.call('GET', '/policy', { role: 'moderator' })).status).toBe(403);
    expect((await raised.call('GET', '/policy', { role: 'senior' })).status).toBe(200);
    expect((await raised.call('GET', '/policy', { role: null })).status).toBe(401);
    const failing = await world({ wrap: (cw) => ({ ...cw, audit: { ...cw.audit, record: () => false } }) });
    const res = await failing.call('GET', '/policy');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
  });
});

describe('GET /audit', () => {
  /** Eleven rows from three actors, with the clock moving so the order is clear. */
  async function seeded() {
    const w = await world();
    const { cw, clock } = w;
    const rec = (actor: string, action: (typeof AUDIT_ACTIONS)[number], ref?: string) => {
      clock.t += 1000;
      cw.audit.record({ actor, role: 'senior', action, ...(ref === undefined ? {} : { target: { type: 'sanction', ref } }) });
    };
    for (let i = 0; i < 5; i++) rec('ann', 'sanction.apply', `g${i}`);
    for (let i = 0; i < 4; i++) rec('bob', 'sanction.revoke', `g${i}`);
    rec('cy', 'policy.view');
    rec('ann', 'report.view');
    return w;
  }

  it('is a page of rows, newest first, with ids, actor, role, action and target only', async () => {
    const { call } = await seeded();
    const res = await call('GET', '/audit', { role: 'senior' });
    expect(res.status).toBe(200);
    const body = res.body as { items: Array<Record<string, unknown>>; next: string | null };
    expect(body.items).toHaveLength(11);
    expect(body.next).toBeNull();
    expect(body.items[0]).toMatchObject({ actor: 'ann', action: 'report.view' });
    const times = body.items.map((r) => r.at as number);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(body.items[1]).toEqual({ id: expect.any(String), at: expect.any(Number), actor: 'cy', role: 'senior', action: 'policy.view' });
    for (const row of body.items) expect(Object.keys(row).every((k) => ['id', 'at', 'actor', 'role', 'action', 'target'].includes(k))).toBe(true);
  });

  it('pages with limit and cursor without gaps or repeats', async () => {
    const { call } = await seeded();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const res = await call('GET', '/audit', { role: 'senior', query: { limit: '4', ...(cursor === undefined ? {} : { cursor }) } });
      expect(res.status).toBe(200);
      const body = res.body as { items: Array<{ id: string }>; next: string | null };
      expect(body.items.length).toBeLessThanOrEqual(4);
      seen.push(...body.items.map((r) => r.id));
      if (body.next === null) break;
      cursor = body.next;
    }
    expect(seen).toHaveLength(11);
    expect(new Set(seen).size).toBe(11);
  });

  it('filters by actor and by action, and by both', async () => {
    const { call } = await seeded();
    const byActor = (await call('GET', '/audit', { role: 'senior', query: { actor: 'bob' } })).body as { items: Array<{ actor: string }> };
    expect(byActor.items).toHaveLength(4);
    expect(byActor.items.every((r) => r.actor === 'bob')).toBe(true);
    const byAction = (await call('GET', '/audit', { role: 'senior', query: { action: 'sanction.apply' } })).body as { items: Array<{ action: string }> };
    expect(byAction.items).toHaveLength(5);
    const both = (await call('GET', '/audit', { role: 'senior', query: { actor: 'ann', action: 'report.view' } })).body as { items: unknown[] };
    expect(both.items).toHaveLength(1);
    const none = (await call('GET', '/audit', { role: 'senior', query: { actor: 'nobody' } })).body as { items: unknown[] };
    expect(none.items).toEqual([]);
  });

  it('a bad limit, cursor, action or actor is 400 (AuditQueryError and RangeError map to 400), never echoed', async () => {
    const { call } = await seeded();
    const queries: Array<Record<string, string>> = [
      { limit: '0' },
      { limit: '201' },
      { limit: '-1' },
      { limit: '1.5' },
      { limit: 'abc' },
      { limit: '' },
      { limit: '1e3' },
      { limit: '12345678901' },
      { cursor: 'not-a-cursor-secret' },
      { cursor: '' },
      { action: 'secret.action' },
      { action: 'term.edit' },
      { actor: '' },
    ];
    for (const query of queries) {
      const res = await call('GET', '/audit', { role: 'senior', query });
      expect(res.status, JSON.stringify(query)).toBe(400);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
  });

  it('writes no audit row of its own (reading the trail does not grow it)', async () => {
    const { call, audit } = await seeded();
    const before = audit().length;
    await call('GET', '/audit', { role: 'senior' });
    await call('GET', '/audit', { role: 'senior', query: { action: 'policy.view' } });
    expect(audit()).toHaveLength(before);
  });

  it('is senior by default: a moderator is 403, owner and senior are 200, no authz is 401; an override applies', async () => {
    const { call } = await world();
    expect((await call('GET', '/audit', { role: 'moderator' })).status).toBe(403);
    expect((await call('GET', '/audit', { role: 'senior' })).status).toBe(200);
    expect((await call('GET', '/audit', { role: 'owner' })).status).toBe(200);
    expect((await call('GET', '/audit', { role: null })).status).toBe(401);
    const lowered = await world({ permissions: { 'audit.read': 'moderator' } });
    expect((await lowered.call('GET', '/audit', { role: 'moderator' })).status).toBe(200);
    const raised = await world({ permissions: { 'audit.read': 'owner' } });
    expect((await raised.call('GET', '/audit', { role: 'senior' })).status).toBe(403);
  });

  it('shows what the other routes wrote: sanction.apply then sanction.revoke by the same actor', async () => {
    const { call, person, clock } = await world();
    clock.t += DAY;
    const made = await call('POST', '/sanctions', { actor: 'ann', body: { subject: person(), kind: 'chat', durationMs: DAY, rule: 2 } });
    const { groupId } = made.body as { groupId: string };
    clock.t += 1000;
    await call('POST', `/sanctions/${groupId}/revoke`, { actor: 'ann', body: { reason: 'secret-reason' } });
    const res = await call('GET', '/audit', { role: 'senior', query: { actor: 'ann' } });
    const items = (res.body as { items: Array<{ action: string; target?: { ref: string } }> }).items;
    expect(items.map((r) => r.action)).toEqual(['sanction.revoke', 'sanction.apply']);
    expect(items.every((r) => r.target?.ref === groupId)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('a store failure is a plain 500', async () => {
    const { call } = await world({
      wrap: (cw) => ({
        ...cw,
        audit: {
          ...cw.audit,
          list: () => {
            throw new Error('db gone');
          },
        },
      }),
    });
    const res = await call('GET', '/audit', { role: 'senior' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'internal' });
  });
});

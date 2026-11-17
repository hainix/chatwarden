import { describe, expect, it } from 'vitest';
import type { Matcher } from '@chatwarden/core';
import { parseDecision } from '../src/admin/apply.js';
import { errorOf, world } from './world.js';
import type { Role } from '@chatwarden/http';

// `POST /reports/:id/decide` with `rename: { rule }` (0.2.0): an upheld decision that also asks the reported person to choose a new name.
// The decision is written as before; the rename follows it and answers `rename: { status, error? }`.

const matcher: Matcher = { match: (t) => (/zorbak/i.test(t) ? { termId: 'syn:zorbak' } : null) };
const REASON = 'The name breaks the rules.';

type W = Awaited<ReturnType<typeof world>>;

const renameWorld = (names: Record<string, unknown> = { renames: true }, over: Parameters<typeof world>[0] = {}) =>
  world({ matcher, ...over, overrides: { names, ...(over.overrides ?? {}) } });

const warning = (subject: string, over: Record<string, unknown> = {}) => ({ subject, kind: 'warning', durationMs: null, rule: 2, ...over });
const body = (over: Record<string, unknown> = {}) => ({ verdict: 'upheld', actions: [], reason: REASON, rename: { rule: 7 }, ...over });
const decide = (w: W, id: string, b: unknown, o: { role?: Role | null; actor?: string } = {}) =>
  w.call('POST', `/reports/${id}/decide`, { role: o.role === undefined ? 'senior' : o.role, actor: o.actor ?? 'ann', body: b });
const answer = (res: { body: unknown }) => res.body as { ok: boolean; replay: boolean; groups: unknown[]; rename?: { status: string; error?: string } };
const kindsOf = (w: W, key: string) => w.cw.notices.pending({ clientKey: key }).map((n) => n.kind);
/** The route audit actions, sorted by name (rows written in the same millisecond have no stable order). */
const actionsOf = (w: W) => w.routeAudit().map((r) => r.action).sort();
/** Every notice row in the order it was written. */
const writtenKinds = (w: W): string[] => (w.db.prepare('SELECT kind FROM kit_notices ORDER BY rowid').all() as Array<{ kind: string }>).map((r) => r.kind);

describe('POST /reports/:id/decide with rename', () => {
  it('rename alone (verdict upheld, no actions) is accepted: the person is pending a rename, status asked, the reporter is not thanked', async () => {
    const w = await renameWorld();
    const f = await w.file();
    const res = await decide(w, f.id, body());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, replay: false, groups: [], rename: { status: 'asked' } });
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(true);
    expect(w.cw.notices.pending({ clientKey: f.key }).find((n) => n.kind === 'rename_required')?.rule).toBe(7);
    expect(w.cw.reports.get(f.id)?.status).not.toBe('open');
    // Only the one notice exists: the reporter is not thanked with one.
    expect(writtenKinds(w)).toEqual(['rename_required']);
  });

  it('the sanction notice and the rename notice are both written, sanction first; status asked; two audit rows (decision and name.rename_required)', async () => {
    const w = await renameWorld();
    const f = await w.file();
    const res = await decide(w, f.id, body({ actions: [warning(f.target)] }));
    expect(res.status).toBe(200);
    expect(answer(res).rename).toEqual({ status: 'asked' });
    expect(answer(res).groups).toHaveLength(1);
    const kinds = writtenKinds(w);
    expect(kinds).toContain('warning');
    expect(kinds.indexOf('warning')).toBeLessThan(kinds.indexOf('rename_required'));
    expect(kindsOf(w, f.key)).toContain('rename_required');
    expect(actionsOf(w)).toEqual(['name.rename_required', 'report.decide']);
    expect(w.routeAudit().find((r) => r.action === 'name.rename_required')?.target).toEqual({ type: 'person', ref: f.target });
    expect(JSON.stringify(w.audit())).not.toContain(REASON);
  });

  it('a repeated body is replay true and the rename answers already', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect(answer(await decide(w, f.id, body())).rename).toEqual({ status: 'asked' });
    const again = await decide(w, f.id, body());
    expect(again.status).toBe(200);
    expect(answer(again)).toMatchObject({ ok: true, replay: true, rename: { status: 'already' } });
    expect(writtenKinds(w).filter((k) => k === 'rename_required')).toHaveLength(1);
  });

  it('a decision without rename is answered exactly as before: no rename field, no rename notice, one audit row', async () => {
    const w = await renameWorld();
    const f = await w.file();
    const plain = { ...body({ actions: [warning(f.target)] }), rename: undefined };
    const res = await decide(w, f.id, plain);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['groups', 'ok', 'replay']);
    expect(writtenKinds(w)).not.toContain('rename_required');
    expect(actionsOf(w)).toEqual(['report.decide']);
  });

  it('a decision without rename is the same while renames are off', async () => {
    const w = await renameWorld({});
    const f = await w.file();
    const plain = { ...body({ actions: [warning(f.target)] }), rename: undefined };
    expect((await decide(w, f.id, plain)).status).toBe(200);
  });
});

describe('rename on decide: refused before any write', () => {
  const untouched = (w: W, f: { id: string; key: string }) => {
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    expect(w.routeAudit()).toEqual([]);
    expect(writtenKinds(w)).toEqual([]);
  };

  it.each([
    ['no_action', { verdict: 'no_action' }],
    ['noted', { verdict: 'noted' }],
    ['bad_faith', { verdict: 'bad_faith' }],
  ])('rename with %s is 400', async (_n, over) => {
    const w = await renameWorld();
    const f = await w.file();
    const res = await decide(w, f.id, body(over));
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe('invalid_request');
    untouched(w, f);
  });

  it('an action on the reporter is 400, and so is an action on the target next to one on the reporter', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect((await decide(w, f.id, body({ actions: [warning(f.reporter)] }))).status).toBe(400);
    expect((await decide(w, f.id, body({ actions: [warning(f.target), warning(f.reporter)] }))).status).toBe(400);
    untouched(w, f);
  });

  it.each([
    ['no rule', { rename: {} }],
    ['a non-integer rule', { rename: { rule: 1.5 } }],
    ['a string rule', { rename: { rule: '7' } }],
    ['a zero rule', { rename: { rule: 0 } }],
    ['a negative rule', { rename: { rule: -2 } }],
    ['null rename', { rename: null }],
    ['a rename that is not an object', { rename: 7 }],
    ['an extra key in rename', { rename: { rule: 7, reason: 'x' } }],
  ])('%s is 400', async (_n, over) => {
    const w = await renameWorld();
    const f = await w.file();
    const res = await decide(w, f.id, body(over));
    expect(res.status).toBe(400);
    untouched(w, f);
  });

  it('without sanctions.apply it is 403 and nothing is written (even with no actions)', async () => {
    const w = await renameWorld({ renames: true }, { permissions: { 'sanctions.apply': 'owner' } });
    const f = await w.file();
    for (const role of ['moderator', 'senior'] as const) {
      const res = await decide(w, f.id, body(), { role });
      expect(res.status, role).toBe(403);
    }
    untouched(w, f);
    // A decision with no rename still needs only reports.decide.
    const plain = { ...body(), rename: undefined };
    expect((await decide(w, f.id, plain, { role: 'moderator' })).status).toBe(200);
  });

  it('renames off is 404 and nothing is written; the check comes before the body is judged', async () => {
    const w = await renameWorld({});
    const f = await w.file();
    expect((await decide(w, f.id, body())).status).toBe(404);
    expect((await decide(w, f.id, body({ verdict: 'no_action' }))).status).toBe(404);
    untouched(w, f);
  });

  it('no authz is 401', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect((await decide(w, f.id, body(), { role: null })).status).toBe(401);
    untouched(w, f);
  });

  it('an unknown report is 404', async () => {
    const w = await renameWorld();
    expect((await decide(w, 'no-such-report', body())).status).toBe(404);
  });
});

describe('rename on decide: faults and claims', () => {
  it('a throw in the rename step leaves the decision written and answers failed', async () => {
    const w = await renameWorld(
      { renames: true },
      {
        wrap: (cw) => ({
          ...cw,
          names: {
            ...cw.names,
            requireRename: () => {
              throw new Error('store fault');
            },
          },
        }),
      },
    );
    const f = await w.file();
    const res = await decide(w, f.id, body({ actions: [warning(f.target)] }));
    expect(res.status).toBe(200);
    expect(answer(res)).toMatchObject({ ok: true, replay: false, rename: { status: 'failed' } });
    expect(answer(res).rename).not.toHaveProperty('error');
    expect(w.cw.reports.get(f.id)?.status).not.toBe('open');
    expect(actionsOf(w)).toEqual(['report.decide']);
    expect(JSON.stringify(res.body)).not.toContain('store fault');
  });

  it('a rename the core answers off, invalid or not_found for is failed with that error', async () => {
    for (const error of ['invalid', 'not_found', 'off'] as const) {
      const w = await renameWorld(
        { renames: true },
        { wrap: (cw) => ({ ...cw, names: { ...cw.names, requireRename: () => ({ ok: false as const, error }) } }) },
      );
      const f = await w.file();
      const res = await decide(w, f.id, body());
      expect(answer(res).rename, error).toEqual({ status: 'failed', error });
      expect(actionsOf(w)).toEqual(['report.decide']);
    }
  });

  it('the claim gate runs once and a claimed case is refused before any write', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect((await w.call('POST', `/cases/${f.target}/claim`, { actor: 'bea', role: 'moderator' })).status).toBe(200);
    const refused = await decide(w, f.id, body(), { actor: 'ann' });
    expect(refused.status).toBe(409);
    expect(errorOf(refused)).toBe('claimed');
    expect(w.cw.reports.get(f.id)?.status).toBe('open');
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    expect(w.routeAudit()).toEqual([]);
    // The holder may decide: nothing else was refused or audited on the way.
    const ok = await decide(w, f.id, body(), { actor: 'bea', role: 'moderator' });
    expect(ok.status).toBe(200);
    expect(answer(ok).rename).toEqual({ status: 'asked' });
    expect(actionsOf(w)).toEqual(['name.rename_required', 'report.decide']);
  });

  it('a failing audit row for the rename does not turn the answer into an error', async () => {
    const w = await renameWorld(
      { renames: true },
      {
        wrap: (cw) => ({
          ...cw,
          audit: { ...cw.audit, record: (e: Parameters<typeof cw.audit.record>[0]) => (e.action === 'name.rename_required' ? false : cw.audit.record(e)) },
        }),
      },
    );
    const f = await w.file();
    const res = await decide(w, f.id, body());
    expect(res.status).toBe(200);
    expect(answer(res).rename).toEqual({ status: 'asked' });
    expect(w.logged.map(([e]) => e)).toContain('chatwarden.http_audit_failed');
  });
});

describe('a replay does not ask again once the player has renamed', () => {
  const renames = (w: W) => writtenKinds(w).filter((k) => k === 'rename_required').length;

  it('asked, the player renames, then the same body again: replay true, no second notice, no second audit row, nothing pending', async () => {
    const w = await renameWorld();
    const f = await w.file();
    expect(answer(await decide(w, f.id, body())).rename).toEqual({ status: 'asked' });
    expect(w.cw.names.renamed({ clientKey: f.key })).toBe(true);
    w.clock.t += 60_000;
    const again = await decide(w, f.id, body());
    expect(again.status).toBe(200);
    expect(answer(again)).toMatchObject({ ok: true, replay: true, rename: { status: 'already' } });
    expect(renames(w)).toBe(1);
    expect(w.cw.names.pendingRename({ clientKey: f.key })).toBe(false);
    expect(w.cw.notices.pending({ clientKey: f.key }).map((n) => n.kind)).not.toContain('rename_required');
    expect(actionsOf(w).filter((a) => a === 'name.rename_required')).toHaveLength(1);
    expect(w.cw.names.renamesOf(f.target)).toHaveLength(1);
  });

  it('with a sanction beside the rename, a retry after the rename writes no second rename and no second sanction', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await decide(w, f.id, body({ actions: [warning(f.target)] }));
    w.cw.names.renamed({ clientKey: f.key });
    const again = await decide(w, f.id, body({ actions: [warning(f.target)] }));
    expect(answer(again)).toMatchObject({ replay: true, rename: { status: 'already' } });
    expect(renames(w)).toBe(1);
    expect(writtenKinds(w).filter((k) => k === 'warning')).toHaveLength(1);
  });

  it('several replays in a row stay the same', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await decide(w, f.id, body());
    w.cw.names.renamed({ clientKey: f.key });
    for (let i = 0; i < 3; i++) expect(answer(await decide(w, f.id, body())).rename).toEqual({ status: 'already' });
    expect(renames(w)).toBe(1);
  });

  it('control: the decision is not a replay and the player had renamed for an earlier request: a rename is asked', async () => {
    const w = await renameWorld();
    const first = await w.file();
    // An earlier request, from the Person page, that the player has since obeyed; then a new decision for the same person.
    expect((await w.call('POST', `/people/${first.target}/rename`, { role: 'senior', actor: 'ann', body: { reason: REASON, rule: 7 } })).status).toBe(200);
    w.cw.names.renamed({ clientKey: first.key });
    w.clock.t += 60_000;
    const second = await w.fileAgainst(first, 'x');
    const res = await decide(w, second.id, body());
    expect(answer(res)).toMatchObject({ replay: false, rename: { status: 'asked' } });
    expect(renames(w)).toBe(2);
  });

  it('control: a replay whose first call carried no rename asks for it (the earlier request predates the decision)', async () => {
    const w = await renameWorld();
    const first = await w.file();
    await w.call('POST', `/people/${first.target}/rename`, { role: 'senior', actor: 'ann', body: { reason: REASON, rule: 7 } });
    w.cw.names.renamed({ clientKey: first.key });
    w.clock.t += 60_000;
    const second = await w.fileAgainst(first, 'x');
    const plain = { ...body(), rename: undefined };
    expect(Object.keys((await decide(w, second.id, plain)).body as object).sort()).toEqual(['groups', 'ok', 'replay']);
    w.clock.t += 60_000;
    const again = await decide(w, second.id, body());
    expect(answer(again)).toMatchObject({ replay: true, rename: { status: 'asked' } });
    expect(renames(w)).toBe(2);
  });

  it('control: still waiting on the rename, the replay answers already and writes nothing', async () => {
    const w = await renameWorld();
    const f = await w.file();
    await decide(w, f.id, body());
    expect(answer(await decide(w, f.id, body())).rename).toEqual({ status: 'already' });
    expect(renames(w)).toBe(1);
  });
});

describe('the shared decision parser stays strict', () => {
  it('a decision body that carries rename is refused by parseDecision (the webhook and decideAs callers send none)', () => {
    expect(() => parseDecision({ verdict: 'upheld', actions: [], reason: 'x', rename: { rule: 7 } })).toThrow();
    expect(parseDecision({ verdict: 'upheld', actions: [], reason: 'x' })).toMatchObject({ verdict: 'upheld' });
  });
});

import { describe, expect, it } from 'vitest';
import { SANCTION_SOURCES, SanctionError } from '../src/sanctions.js';
import * as sanctionsModule from '../src/sanctions.js';
import * as index from '../src/index.js';
import type { DecisionInput } from '../src/decide.js';
import type { SanctionInput } from '../src/sanctions.js';
import { world } from './reportingWorld.js';

// Only the kit's own AI actor may write a sanction with `source: 'ai'` (design 6.1). A caller (an adopter's code, a route, a plugin) that passes it
// is refused before anything is written: `cw.decide` answers `invalid`, `cw.sanctions.apply` rejects with the usual sanction error. The other
// sources still work, and a filter by source `ai` (a read) still works.

async function filed() {
  const w = await world();
  const r = await w.file();
  return { w, r };
}

const rows = (w: Awaited<ReturnType<typeof filed>>['w']) => w.store.listSubjectSanctions({ limit: 50 });

const decision = (reportId: string, target: string, over: Partial<DecisionInput> = {}): DecisionInput => ({
  reportId,
  verdict: 'upheld',
  actor: 'mod_ann',
  reason: 'a decision about vlemmo',
  actions: [{ subject: target, kind: 'warning', durationMs: null, rule: 2 }],
  ...over,
});

const apply = (subject: string, over: Partial<SanctionInput> = {}): SanctionInput => ({
  kind: 'warning',
  subject,
  includeIp: false,
  durationMs: null,
  reason: 'a reason about tarvo',
  actor: 'mod_ann',
  source: 'moderator',
  automated: false,
  rule: 2,
  ...over,
});

describe('cw.decide refuses source ai with invalid and writes nothing', () => {
  it.each(['upheld', 'noted', 'no_action', 'bad_faith'] as const)('verdict %s', async (verdict) => {
    const { w, r } = await filed();
    const actions =
      verdict === 'upheld'
        ? [{ subject: r.target, kind: 'warning' as const, durationMs: null, rule: 2 }]
        : verdict === 'noted'
          ? [{ subject: r.target, kind: 'note' as const, durationMs: null, rule: 2 }]
          : [];
    const extra = verdict === 'bad_faith' ? { evidence: 'filed the same false report three times' } : {};
    const res = await w.cw.decide({ reportId: r.id, verdict, actor: 'mod_ann', reason: 'a decision about vlemmo', source: 'ai', actions, ...extra });
    expect(res).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
    expect(rows(w)).toEqual([]);
  });

  it('with an actor that looks like the AI', async () => {
    const { w, r } = await filed();
    expect(await w.cw.decide(decision(r.id, r.target, { actor: 'ai:fake', source: 'ai' }))).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('an inherited source ai is read as an ordinary property and refused too', async () => {
    const { w, r } = await filed();
    const input = Object.create({ source: 'ai' }, Object.getOwnPropertyDescriptors(decision(r.id, r.target))) as DecisionInput;
    expect(await w.cw.decide(input)).toEqual({ ok: false, error: 'invalid' });
    expect(w.cw.reports.get(r.id)?.status).toBe('open');
  });

  it('writes no decision row: the same report can still be decided as a moderator afterwards', async () => {
    const { w, r } = await filed();
    expect(await w.cw.decide(decision(r.id, r.target, { source: 'ai' }))).toEqual({ ok: false, error: 'invalid' });
    const ok = await w.cw.decide(decision(r.id, r.target));
    expect(ok.ok).toBe(true);
    expect(w.cw.reports.get(r.id)?.status).toBe('actioned');
  });

  it.each(['AI', 'ai ', 'Ai', 'robot', ''])('a look-alike or unknown source %j is invalid as well (control)', async (source) => {
    const { w, r } = await filed();
    expect(await w.cw.decide(decision(r.id, r.target, { source: source as DecisionInput['source'] }))).toEqual({ ok: false, error: 'invalid' });
  });

  it.each(['moderator', 'api', 'coop', 'auto_filter'] as const)('control: source %s still decides, and the sanction carries it', async (source) => {
    const { w, r } = await filed();
    const res = await w.cw.decide(decision(r.id, r.target, { source }));
    expect(res.ok).toBe(true);
    expect(rows(w).map((s) => s.source)).toEqual([source]);
  });

  it('control: an absent source is moderator', async () => {
    const { w, r } = await filed();
    expect((await w.cw.decide(decision(r.id, r.target))).ok).toBe(true);
    expect(rows(w).map((s) => s.source)).toEqual(['moderator']);
  });
});

describe('cw.sanctions.apply refuses source ai', () => {
  it.each(['warning', 'chat', 'note', 'ban'] as const)('kind %s rejects with a sanction error and writes nothing', async (kind) => {
    const { w, r } = await filed();
    const durationMs = kind === 'warning' || kind === 'note' ? null : 3_600_000;
    await expect(w.cw.sanctions.apply(apply(r.target, { kind, durationMs, source: 'ai' }))).rejects.toBeInstanceOf(SanctionError);
    expect(rows(w)).toEqual([]);
  });

  it('with automated true as well, and with an uncovered rule', async () => {
    const { w, r } = await filed();
    await expect(w.cw.sanctions.apply(apply(r.target, { source: 'ai', automated: true }))).rejects.toBeInstanceOf(SanctionError);
    await expect(w.cw.sanctions.apply(apply(r.target, { source: 'ai', rule: 'uncovered' }))).rejects.toBeInstanceOf(SanctionError);
    expect(rows(w)).toEqual([]);
  });

  it('emits no sanction.applied event for the refused call', async () => {
    const { w, r } = await filed();
    const seen: string[] = [];
    w.cw.on('*', (e) => void seen.push(e.type));
    await expect(w.cw.sanctions.apply(apply(r.target, { source: 'ai' }))).rejects.toBeInstanceOf(SanctionError);
    expect(seen).not.toContain('sanction.applied');
  });

  it.each(['moderator', 'api', 'coop', 'auto_filter'] as const)('control: source %s still applies', async (source) => {
    const { w, r } = await filed();
    await w.cw.sanctions.apply(apply(r.target, { source }));
    expect(rows(w).map((s) => s.source)).toEqual([source]);
  });
});

describe('the internal source stays internal', () => {
  it('isInternalSource is true for ai and nothing else, and is not exported from the package index', () => {
    const fn = (sanctionsModule as unknown as { isInternalSource?: (s: unknown) => boolean }).isInternalSource;
    expect(typeof fn).toBe('function');
    expect(fn?.('ai')).toBe(true);
    for (const s of ['moderator', 'api', 'coop', 'auto_filter', 'AI', '', null, undefined, 1]) expect(fn?.(s)).toBe(false);
    expect(Object.keys(index)).not.toContain('isInternalSource');
  });

  it('SANCTION_SOURCES still lists ai (it is what a stored row and a read filter may carry)', () => {
    expect(SANCTION_SOURCES).toContain('ai');
  });
});

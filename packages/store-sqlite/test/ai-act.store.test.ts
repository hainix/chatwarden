import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatwarden, createFakeModerationAI, fakeRead } from '@chatwarden/core';
import type { AiActionRow, AIReadInput, RawWho } from '@chatwarden/core';
import { openStore } from '../src/index.js';
import type { SqliteStore } from '../src/index.js';

// What is specific to SQLite in the shadow release (migration 25): the plans the indexes give, two connections racing for one report, the state surviving a reopen, and the
// whole shadow path over a real database: it records an action row and writes nothing to a person. The behaviour both stores share is in test/contract/ai-shadow.contract.ts.

const MIN = 60_000;
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const fileDb = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'cw-ai-act-store-'));
  dirs.push(d);
  return join(d, 'kit.db');
};
const open = (path: string): SqliteStore => {
  const s = openStore({ path });
  stores.push(s);
  return s;
};

let n = 0;
const row = (report: string, over: Partial<AiActionRow> = {}): AiActionRow => {
  n += 1;
  return {
    id: `act-${n}`, reportId: report, readId: `read-${report}`, confirmReadId: null, rule: '2', severity: 'hostile', state: 'queued', refusedCode: null, notBefore: NOW + 10 * MIN, createdAt: NOW,
    groupId: null, kind: null, durationMs: null, actedAt: null, reviewDueAt: null, reviewedAt: null, reviewedBy: null, undoCode: null, undoNote: null, adapter: 'fake:model', promptVersion: 5, ...over,
  };
};

describe('two connections to one file', () => {
  it('race to queue one report: exactly one insert wins, and the other is told so', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const results = [a.insertAiAction(row('r1')), b.insertAiAction(row('r1')), a.insertAiAction(row('r1'))];
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(a.listAiActions({ limit: 10 })).toHaveLength(1);
    expect(b.loadAiAction('r1')?.id).toBe(a.loadAiAction('r1')?.id);
  });

  it('race to move one row: of two transitions from queued, exactly one changes it', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const r = row('r1');
    a.insertAiAction(r);
    const wins = [a.transitionAiAction(r.id, ['queued'], { state: 'shadow', actedAt: NOW }), b.transitionAiAction(r.id, ['queued'], { state: 'refused', refusedCode: 'cap_hour' })];
    expect(wins).toEqual([true, false]);
    expect(b.loadAiAction('r1')).toMatchObject({ state: 'shadow', refusedCode: null, actedAt: NOW });
  });

  it('race to start acting: of two owners starting shadow from off, exactly one moves the state', () => {
    const path = fileDb();
    const a = open(path);
    const b = open(path);
    const off = { mode: 'off' as const, paused: false };
    const next = (by: string) => ({ mode: 'shadow' as const, modeSince: NOW, modeBy: by, paused: false, pausedSince: null, pausedBy: null });
    expect([a.setAiActingState(off, next('owner_a')), b.setAiActingState(off, next('owner_b'))]).toEqual([true, false]);
    expect(b.aiActingState().modeBy).toBe('owner_a');
  });
});

describe('the state is the file\'s', () => {
  it('survives a reopen: the acting state and every action row', () => {
    const path = fileDb();
    const a = open(path);
    a.setAiActingState({ mode: 'off', paused: false }, { mode: 'shadow', modeSince: NOW, modeBy: 'owner_ann', paused: true, pausedSince: NOW + 5, pausedBy: 'sen_bo' });
    a.insertAiAction(row('r1', { state: 'shadow', kind: 'chat', durationMs: DAY, actedAt: NOW + 1, confirmReadId: 'c1', undoNote: null }));
    a.insertAiAction(row('r2', { state: 'refused', refusedCode: 'gate_failed:volume' }));
    a.close();
    stores.length = 0;
    const b = open(path);
    expect(b.aiActingState()).toEqual({ mode: 'shadow', modeSince: NOW, modeBy: 'owner_ann', paused: true, pausedSince: NOW + 5, pausedBy: 'sen_bo' });
    expect(b.loadAiAction('r1')).toMatchObject({ state: 'shadow', kind: 'chat', durationMs: DAY, actedAt: NOW + 1, confirmReadId: 'c1' });
    expect(b.aiActionCounts(0)).toEqual({ byState: { shadow: 1, refused: 1 }, refused: { 'gate_failed:volume': 1 } });
  });

  it('refuses a state or an undo code the table does not know (a CHECK, not just the code)', () => {
    const s = open(fileDb());
    expect(() => s.insertAiAction(row('r1', { state: 'acted' as never }))).toThrow(/CHECK/);
    expect(() => s.insertAiAction(row('r2', { state: 'undone', undoCode: 'because' as never }))).toThrow(/CHECK/);
    expect(() => s.setAiActingState({ mode: 'off', paused: false }, { mode: 'acting' as never, modeSince: 1, modeBy: 'x', paused: false, pausedSince: null, pausedBy: null })).toThrow(/CHECK/);
  });
});

describe('the plans', () => {
  const plan = (db: DatabaseSync, sql: string, ...args: Array<string | number>): string =>
    (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((p) => p.detail).join('\n');

  it('the due rows read the state index, the unreviewed rows and the counts read an index and never scan the table whole', () => {
    const db = new DatabaseSync(':memory:');
    openStore({ db });
    const due = plan(db, "SELECT * FROM kit_ai_actions WHERE state = 'queued' AND not_before <= ? ORDER BY not_before, id LIMIT ?", 1, 5);
    expect(due).toMatch(/kit_ai_actions_by_state/);
    const unreviewed = plan(db, "SELECT COUNT(*) AS n, MIN(acted_at) AS oldest FROM kit_ai_actions WHERE state = 'active'");
    expect(unreviewed).toMatch(/kit_ai_actions_by_(state|review)/);
    const byReport = plan(db, 'SELECT * FROM kit_ai_actions WHERE report_id = ?', 'r1');
    expect(byReport).toMatch(/sqlite_autoindex_kit_ai_actions|USING (COVERING )?INDEX/);
    db.close();
  });
});

describe('the shadow path over a real database', () => {
  it('records one shadow row for a report the AI would act on, and writes no sanction, notice, strike, mute or decision', async () => {
    const store = open(fileDb());
    const clock = { t: NOW, now: () => NOW + 0 };
    const time = { t: NOW };
    clock.now = () => time.t;
    const adapter = createFakeModerationAI((input: AIReadInput) => ({
      output: fakeRead(input, { severity: 'hostile', rule: 2, confidence: 'high', recommendation: { verdict: 'upheld', severity: 'hostile', rule: 2, evidence: [input.lines.find((l) => l.who === 'P1')?.ref ?? 'L1'] } }),
    }));
    const cw = await createChatwarden({
      store,
      secret: 'sqlite-act-secret',
      platform: { identify: (ctx) => ctx as RawWho },
      clock,
      retention: false,
      profile: 'strict',
      overrides: { ai: { level: 2 }, appeals: { enabled: true } } as never,
      ai: { adapter, maxLevel: 3, act: {} },
    });
    // the cell has earned it on paper
    for (let i = 0; i < 120; i += 1) {
      store.insertAiOutcome({
        reportId: `seed-${i}`, readId: null, decidedAt: NOW - Math.floor((i / 119) * 60 * DAY), level: 2, verdict: 'upheld', rule: '2', severity: 'hostile', aiVerdict: 'upheld', agreement: 'agree',
        detail: { verdict: true, rule: true, lines: 1, outcome: 'same', oneClick: false }, badFaith: false, example: null, aiRule: '2', aiSeverity: 'hostile', aiConfidence: 'high',
        decidedBy: i % 2 === 0 ? 'mod_a' : 'mod_b', source: 'human',
      });
    }
    expect(cw.ai.acting.startShadow('owner_ann', { confirm: 'ACT', reason: 'we are ready' })).toMatchObject({ ok: true });
    // file reports until one is queued (a fifth are held back)
    let queued: string | null = null;
    for (let i = 0; i < 40 && queued === null; i += 1) {
      cw.rooms.seat(`room-${i}`, 'p1', { clientKey: `key-reporter-${i}` }, 'Rep');
      cw.rooms.seat(`room-${i}`, 'p2', { clientKey: `key-target-${i}` }, 'Tgt');
      for (const text of ['you are trash', 'uninstall the game']) {
        time.t += 6000;
        cw.chat.accept(`room-${i}`, 'p2', text);
      }
      time.t += 1000;
      const res = await cw.reports.submit({ roomId: `room-${i}`, reporterSeat: 'p1', targetSeat: 'p2' });
      if (!res.ok) throw new Error(res.refused);
      await cw.ai.idle();
      if (store.loadAiAction(res.reportId)?.state === 'queued') queued = res.reportId;
    }
    expect(queued).not.toBeNull();
    const id = queued as string;
    time.t = (store.loadAiAction(id) as AiActionRow).notBefore + 1;
    await cw.ai.sweep();
    await cw.ai.idle();
    expect(store.loadAiAction(id)).toMatchObject({ state: 'shadow', kind: 'chat', durationMs: DAY, actedAt: time.t });
    expect(cw.reports.get(id)?.status).toBe('open');
    expect(cw.audit.list({ limit: 200 }).items.filter((a) => a.action === 'ai.act')).toHaveLength(1);
    // nothing was written to a person, in any table that could hold it
    const db = (store as unknown as { db: DatabaseSync }).db;
    for (const table of ['kit_sanctions', 'kit_notices', 'kit_strikes', 'kit_mutes', 'kit_decisions']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    cw.ai.close();
    await cw.ai.idle();
  });
});

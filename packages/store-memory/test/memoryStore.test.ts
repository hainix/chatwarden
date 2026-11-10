import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SanctionRow, StoredReport } from '@chatwarden/core';
import * as pkg from '../src/index.js';
import { createMemoryStore, MemoryStore, VERSION } from '../src/index.js';

// What is specific to MemoryStore. The behaviour it shares with SqliteStore is in the shared contract suite
// (test/contract, run by contract.test.ts).

const NOW = 1_800_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

const gapRow = (groupId: string, refCode: string): SanctionRow => ({
  id: `row-${groupId}`,
  groupId,
  refCode,
  kind: 'ban',
  targetType: 'subject',
  value: 's_a',
  startsAt: NOW,
  endsAt: null,
  reason: 'r',
  rule: 'uncovered',
  gapNote: 'a note about a gap',
  gapStatus: 'open',
  roomId: null,
  actor: 'mod',
  source: 'moderator',
  automated: false,
  pending: false,
});

const report = (id: string, over: Partial<StoredReport> = {}): StoredReport => ({
  id,
  createdAt: NOW,
  roomId: `ROOM-${id}`,
  tags: {},
  reporterSubject: `s_rep_${id}`,
  reporterSeat: 'p1',
  reporterHandle: 'Rep',
  targetSubject: 's_tgt',
  targetSeat: 'p2',
  targetHandle: 'Tgt',
  category: 'harassment',
  note: null,
  lineId: null,
  excerpt: [],
  people: ['s_tgt'],
  status: 'open',
  ...over,
});

describe('the package', () => {
  it('exports VERSION, MemoryStore and createMemoryStore, and nothing else at runtime', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(Object.keys(pkg).sort()).toEqual(['MemoryStore', 'VERSION', 'createMemoryStore']);
  });

  it('src has no node: specifier and no import of a Node builtin (it has to bundle for a browser)', () => {
    const dir = new URL('../src/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(2);
    for (const f of files) {
      // Comments may talk about node: modules; code may not import them.
      const text = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(text, f).not.toMatch(/['"`]node:/);
      expect(text, f).not.toMatch(/\b(from|import)\s*\(?\s*['"](crypto|fs|path|os|util|buffer|stream)['"]/);
    }
  });
});

describe('createMemoryStore', () => {
  it('returns a MemoryStore that starts empty', async () => {
    const s = createMemoryStore();
    expect(s).toBeInstanceOf(MemoryStore);
    expect(await s.loadSubjects()).toEqual({ subjects: [], ids: [] });
    expect(s.rawReports()).toEqual([]);
    expect(s.schemaVersion()).toBe(0);
  });

  it('each call is a separate store: nothing is shared between two', () => {
    const a = createMemoryStore();
    const b = createMemoryStore();
    a.insertReport(report('r1'));
    expect(a.rawReports()).toHaveLength(1);
    expect(b.rawReports()).toEqual([]);
    expect(b.insertReport(report('r1'))).toBe(true);
  });
});

describe('the inspection helpers return copies', () => {
  it('changing what rawReports, rawSanctions, rawStrikes, rawMutes, rawNotices or rawDecisions return changes nothing', () => {
    const s = createMemoryStore();
    s.insertReport(report('r1'));
    s.insertSanctionGroup([gapRow('g1', 'M-AAAAA')]);
    s.insertStrike({ id: 'k1', at: NOW, subject: 's_a', roomId: 'R', termId: 't', rawLine: 'line' });
    s.upsertMute({ viewer: 'v', target: 't', createdAt: NOW });
    s.insertNotice({ id: 'n1', subject: 's_a', groupId: 'g1', kind: 'ban', rule: '1', until: null, refCode: 'M-AAAAA', excerpt: [], createdAt: NOW, ackedAt: null, withdrawnAt: null });
    s.insertDecision('d1', 'r1', NOW, '{}');
    s.rawReports()[0]!.status = 'dismissed';
    s.rawSanctions()[0]!.reason = 'tampered';
    s.rawStrikes()[0]!.rawLine = 'tampered';
    s.rawMutes()[0]!.target = 'tampered';
    s.rawNotices()[0]!.kind = 'warning';
    s.rawDecisions()[0]!.resultJson = 'tampered';
    expect(s.rawReports()[0]?.status).toBe('open');
    expect(s.rawSanctions()[0]?.reason).toBe('r');
    expect(s.rawStrikes()[0]?.rawLine).toBe('line');
    expect(s.rawMutes()[0]?.target).toBe('t');
    expect(s.rawNotices()[0]?.kind).toBe('ban');
    expect(s.rawDecisions()[0]?.resultJson).toBe('{}');
  });
});

describe('the gap.close audit entry id', () => {
  it('is 22 base64url characters, and different for every close', () => {
    const s = createMemoryStore();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      s.insertSanctionGroup([gapRow(`g${i}`, `M-${String(i).padStart(5, '0')}`)]);
      expect(s.closeGap(`g${i}`, 'not_a_rule', null, 'boss', NOW + i)).toBe(true);
    }
    for (const e of s.listAudit({ limit: 200 })) {
      expect(e.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      seen.add(e.id);
    }
    expect(seen.size).toBe(50);
  });

  it('needs a secure random source; without one closeGap throws and the gap stays open (nothing half-done)', () => {
    const s = createMemoryStore();
    s.insertSanctionGroup([gapRow('g1', 'M-AAAAA')]);
    vi.stubGlobal('crypto', undefined);
    expect(() => s.closeGap('g1', 'ruled', '7', 'boss', NOW + 1)).toThrow(/secure random/);
    vi.unstubAllGlobals();
    expect(s.listGaps()[0]?.gapStatus).toBe('open');
    expect(s.listAudit({ limit: 10 })).toEqual([]);
    expect(s.closeGap('g1', 'ruled', '7', 'boss', NOW + 2)).toBe(true);
  });
});

describe('subclassing for failure injection (how the core tests use it)', () => {
  it('a subclass can override one method and the rest keeps working', () => {
    class NoStrikes extends MemoryStore {
      override insertStrike(): void {
        throw new Error('disk full');
      }
    }
    const s = new NoStrikes();
    expect(() => s.insertStrike()).toThrow('disk full');
    expect(s.insertReport(report('r1'))).toBe(true);
  });

  it('a failure inside a transaction undoes the writes made before it', () => {
    class NoStrikes extends MemoryStore {
      override insertStrike(): void {
        throw new Error('disk full');
      }
    }
    const s = new NoStrikes();
    expect(() =>
      s.transaction(() => {
        s.insertReport(report('r1'));
        s.insertStrike();
      }),
    ).toThrow('disk full');
    expect(s.rawReports()).toEqual([]);
  });
});

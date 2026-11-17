import { describe, expect, it } from 'vitest';
import { AI_GATE_ROWS_SQL, aiGateRowsArgs } from '../src/sqliteStore.js';

// node:sqlite on Node 22.13 throws "column index out of range" when more values are bound than a statement has placeholders (newer Node tolerates it), and numbered
// parameters (`?1`) count differently there. So every new statement uses plain `?` and binds exactly as many values as it has, in order. This counts them.

const placeholders = (sql: string): number => (sql.replace(/'[^']*'/g, '').match(/\?/g) ?? []).length;

describe('SQL placeholders and bound values agree (Node 22.13 binds strictly)', () => {
  it('the gate query uses plain ? placeholders, no numbered or named ones', () => {
    expect(AI_GATE_ROWS_SQL).not.toMatch(/\?\d/);
    expect(AI_GATE_ROWS_SQL).not.toMatch(/\s[:@$][a-z]\w*/i);
  });

  it('the gate query binds exactly as many values as it has placeholders', () => {
    expect(placeholders(AI_GATE_ROWS_SQL)).toBe(3);
    expect(aiGateRowsArgs(10, 20)).toHaveLength(placeholders(AI_GATE_ROWS_SQL));
  });

  it('in SQL order: the window start, then the recent window start twice', () => {
    expect(aiGateRowsArgs(10, 20)).toEqual([10, 20, 20]);
    const since = AI_GATE_ROWS_SQL.indexOf('decided_at >= ?');
    const recent = AI_GATE_ROWS_SQL.indexOf('decided_at >= ?', since + 1);
    expect(since).toBeGreaterThan(0);
    expect(recent).toBeGreaterThan(since);
    expect(placeholders(AI_GATE_ROWS_SQL.slice(0, recent))).toBe(1);
  });

  it('the counter itself sees a surplus (a control)', () => {
    expect(placeholders('SELECT ? , ?')).toBe(2);
    expect(placeholders("SELECT '?' , ?")).toBe(1);
  });
});

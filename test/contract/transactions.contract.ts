import { describe, expect, it } from 'vitest';
import type { Store } from '@chatwarden/core';

// The contract of the lifecycle methods of the Store: transaction (return value, rethrow, nesting), schemaVersion and
// close. Writes are done through the audit trail, which both stores keep synchronously. One suite, run against every Store.

const entry = (id: string) => ({
  id,
  at: 1,
  actor: 'alice',
  role: 'moderator' as const,
  action: 'report.view' as const,
  target: { type: 'report' as const, ref: id },
});
const ids = (s: Store) => s.listAudit({ limit: 50 }).map((r) => r.id).sort();

export function transactionsContract(name: string, make: () => Store): void {
  describe(`transactions contract: ${name}`, () => {
    it('returns what the function returns and commits its writes', () => {
      const s = make();
      const out = s.transaction(() => {
        s.insertAudit(entry('a'));
        return 42;
      });
      expect(out).toBe(42);
      expect(ids(s)).toEqual(['a']);
    });

    it('rethrows the very error the function threw, and undoes every write', () => {
      const s = make();
      s.insertAudit(entry('keep'));
      const boom = new Error('boom');
      let caught: unknown;
      try {
        s.transaction(() => {
          s.insertAudit(entry('x'));
          s.insertAudit(entry('y'));
          throw boom;
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBe(boom);
      expect(ids(s)).toEqual(['keep']);
    });

    it('nested: an inner failure the outer function catches undoes only the inner writes', () => {
      const s = make();
      s.transaction(() => {
        s.insertAudit(entry('outer-1'));
        try {
          s.transaction(() => {
            s.insertAudit(entry('inner'));
            throw new Error('inner boom');
          });
        } catch {
          // the outer function carries on
        }
        s.insertAudit(entry('outer-2'));
      });
      expect(ids(s)).toEqual(['outer-1', 'outer-2']);
    });

    it('nested: a successful inner call is still undone when the outer function fails', () => {
      const s = make();
      expect(() =>
        s.transaction(() => {
          s.transaction(() => {
            s.insertAudit(entry('inner'));
          });
          s.insertAudit(entry('outer'));
          throw new Error('outer boom');
        }),
      ).toThrow('outer boom');
      expect(ids(s)).toEqual([]);
    });

    it('nested three deep: only the failing level is undone', () => {
      const s = make();
      s.transaction(() => {
        s.insertAudit(entry('l1'));
        s.transaction(() => {
          s.insertAudit(entry('l2'));
          try {
            s.transaction(() => {
              s.insertAudit(entry('l3'));
              throw new Error('l3 boom');
            });
          } catch {
            // swallowed at level 2
          }
        });
      });
      expect(ids(s)).toEqual(['l1', 'l2']);
    });

    it('a failed transaction leaves the store usable', () => {
      const s = make();
      expect(() =>
        s.transaction(() => {
          s.insertAudit(entry('x'));
          throw new Error('boom');
        }),
      ).toThrow('boom');
      s.insertAudit(entry('after'));
      expect(ids(s)).toEqual(['after']);
      expect(s.transaction(() => 'again')).toBe('again');
    });

    it('a write that throws on its own (a duplicate id) inside a transaction undoes the earlier writes of that transaction', () => {
      const s = make();
      s.insertAudit(entry('dup'));
      expect(() =>
        s.transaction(() => {
          s.insertAudit(entry('fresh'));
          s.insertAudit(entry('dup'));
        }),
      ).toThrow();
      expect(ids(s)).toEqual(['dup']);
    });

    it('schemaVersion is a non-negative integer', () => {
      const v = make().schemaVersion();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    });

    it('close does not throw', () => {
      expect(() => make().close()).not.toThrow();
    });
  });
}

import { describe, expect, it } from 'vitest';
import { purge, RETENTION_DEFAULTS } from '../src/retention.js';
import { DAY, NOW, legalWorld, seedFullReport } from './legalWorld.js';

// Retention (`cw.purge` and `purge(store, ...)`) leaves the held set alone at every age and starts removing it again once the hold is released. The store skips the
// held rows itself (the contract in test/contract/legal.contract.ts); this proves the whole retention pass, with its real policy numbers, honours it.

const SENIOR = 'senior_gus';

describe('purge skips the held set through the real retention pass', () => {
  it('a held report past every clock survives cw.purge(): the report, decision, sanction group, notice, appeal and audit rows; the unheld twin goes', async () => {
    const w = await legalWorld();
    const old = NOW - 2 * 365 * DAY;
    seedFullReport(w, 'rHeld', old);
    seedFullReport(w, 'rGone', old);
    await w.cw.legal.hold('rHeld', { code: 'legal_proceeding', actor: SENIOR });
    w.clock.t = NOW + 2 * 365 * DAY;
    const result = await w.cw.purge();
    expect(result.reports).toBe(1);
    expect(w.store.loadReport('rHeld')).not.toBeNull();
    expect(w.store.loadReport('rGone')).toBeNull();
    expect(w.store.sanctionGroupsOfReport('rHeld')).toEqual(['g-rHeld']);
    expect(w.store.sanctionGroupsOfReport('rGone')).toEqual([]);
    expect(w.store.loadAppeal('ap-rHeld')).not.toBeNull();
    expect(w.store.loadAppeal('ap-rGone')).toBeNull();
    expect(w.store.listAudit({ limit: 50 }).map((r) => r.id).sort()).toEqual(['au-d-rHeld', 'au-g-rHeld', 'au-r-rHeld']);
  });

  it('at every age: the same purge a day, a year and ten years on keeps a held report', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'rHeld', NOW - DAY);
    await w.cw.legal.hold('rHeld', { code: 'other', actor: SENIOR });
    for (const days of [1, 91, 366, 3650]) {
      w.clock.t = NOW + days * DAY;
      await w.cw.purge();
      expect(w.store.loadReport('rHeld'), `${days} days`).not.toBeNull();
      expect(w.store.sanctionGroupsOfReport('rHeld').length, `${days} days`).toBe(1);
    }
  });

  it('after release the next purge removes what is past retention, and one audit trail of the release is the caller\'s', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'rHeld', NOW - 2 * 365 * DAY);
    await w.cw.legal.hold('rHeld', { code: 'other', actor: SENIOR });
    w.clock.t = NOW + 2 * 365 * DAY;
    await w.cw.purge();
    expect(w.store.loadReport('rHeld')).not.toBeNull();
    await w.cw.legal.release('rHeld', { actor: 'owner_ann' });
    const result = await w.cw.purge();
    expect(result.reports).toBe(1);
    expect(w.store.loadReport('rHeld')).toBeNull();
  });

  it('the pure purge() with a policy of zero days (everything past retention) also keeps the held report', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'rHeld', NOW - DAY);
    await w.cw.legal.hold('rHeld', { code: 'other', actor: SENIOR });
    const r = await purge(w.store, NOW + 1000 * DAY, { ...RETENTION_DEFAULTS, reportsMs: 0, sanctionAfterEndMs: 0, noticesMs: 0, auditMs: 0, appealsMs: 0 });
    expect(r.reports).toBe(0);
    expect(w.store.loadReport('rHeld')).not.toBeNull();
  });

  it('a hold on one report does not keep another report of the same person', async () => {
    const w = await legalWorld();
    seedFullReport(w, 'rHeld', NOW - 2 * 365 * DAY);
    seedFullReport(w, 'rOther', NOW - 2 * 365 * DAY);
    await w.cw.legal.hold('rHeld', { code: 'other', actor: SENIOR });
    w.clock.t = NOW + 2 * 365 * DAY;
    await w.cw.purge();
    expect(w.store.loadReport('rOther')).toBeNull();
    expect(w.store.loadReport('rHeld')).not.toBeNull();
  });
});

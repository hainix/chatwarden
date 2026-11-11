import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { ReportQueryError } from '../src/staffReports.js';
import type { RuleRef } from '../src/rules.js';
import type { Store } from '../src/types.js';
import { OWNER, world } from './reportingWorld.js';
import type { World } from './reportingWorld.js';

// What staff see of the reported reason: the record, the `reason` filter on the queue, and how accurate a reporter's reasons were.

type Filed = Awaited<ReturnType<World['file']>>;

const decide = (
  w: World,
  f: Filed,
  verdict: 'upheld' | 'noted' | 'no_action' | 'bad_faith',
  rule: RuleRef | null,
  over: { kind?: 'warning' | 'note' | 'chat'; on?: string } = {},
) => {
  const kind = over.kind ?? (verdict === 'noted' ? 'note' : 'warning');
  return w.cw.decide({
    reportId: f.id,
    verdict,
    actor: 'mod_1',
    reason: 'looked at it',
    ...(verdict === 'bad_faith' ? { evidence: 'abuse of the tool' } : {}),
    actions:
      rule === null
        ? []
        : [
            {
              subject: over.on ?? f.target,
              kind,
              durationMs: kind === 'chat' ? 3_600_000 : null,
              rule,
              ...(rule === 'uncovered' ? { gapNote: 'not covered by any rule' } : {}),
            },
          ],
  });
};

const record = (w: World, f: Filed) => w.cw.reports.reporterRecord(f.reporter);

describe('reporterRecord: reasonMatched and reasonDecided', () => {
  it('a reporter with no reports has 0 and 0, and the old fields are unchanged', async () => {
    const w = await world();
    const t = w.table();
    expect(w.cw.reports.reporterRecord(t.reporter)).toEqual({
      reports: 0, open: 0, actioned: 0, dismissed: 0, badFaith: 0, suspendedUntil: null, reasonMatched: 0, reasonDecided: 0,
    });
  });

  it('a decided report whose rule is in the reason rules matched', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'upheld', 1);
    expect(record(w, f)).toMatchObject({ reasonMatched: 1, reasonDecided: 1, actioned: 1 });
  });

  it('a decided report under another rule is decided but not matched', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'upheld', 2);
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 1 });
  });

  it('a dismissal (no_action) is decided and never matched', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'no_action', null);
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 1, dismissed: 1 });
  });

  it('a bad-faith dismissal is decided and never matched', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'bad_faith', null);
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 1, badFaith: 1 });
  });

  it('a noted decision under the matching rule matched (a note cites the rule too)', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    await decide(w, f, 'noted', 2);
    expect(record(w, f)).toMatchObject({ reasonMatched: 1, reasonDecided: 1 });
  });

  it('a report with no reason is left out of both counts, decided or not', async () => {
    const w = await world();
    const f = await w.file({});
    await decide(w, f, 'upheld', 2);
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 0, actioned: 1 });
  });

  it('an open report is left out', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 0, open: 1 });
  });

  it('counts add up over many reports, and another reporter is not mixed in', async () => {
    const w = await world();
    const hit = await w.file({ reason: 'hate' });
    const miss = await w.file({ reason: 'hate' });
    const dismissed = await w.file({ reason: 'spam' });
    const open = await w.file({ reason: 'cheating' });
    const none = await w.file({});
    const other = await w.file({ reason: 'hate' }, { reporter: 'key-someone-else' });
    await decide(w, hit, 'upheld', 1);
    await decide(w, miss, 'upheld', 6);
    await decide(w, dismissed, 'no_action', null);
    await decide(w, none, 'upheld', 2);
    await decide(w, other, 'upheld', 1);
    expect(record(w, hit)).toMatchObject({ reports: 5, reasonMatched: 1, reasonDecided: 3 });
    expect(w.cw.reports.reporterRecord(other.reporter)).toMatchObject({ reports: 1, reasonMatched: 1, reasonDecided: 1 });
    void open;
  });

  it('any of several rules matches; uncovered never does; a reason with no rules cannot be judged and is left out', async () => {
    const w = await world({
      overrides: { reporting: { reasons: [{ id: 'abuse', label: 'Abuse', rules: [3, 4] }, { id: 'vague', label: 'Vague', rules: [] }, { id: 'other', label: 'Else' }] } },
    });
    const a = await w.file({ reason: 'abuse' });
    const b = await w.file({ reason: 'abuse' });
    const c = await w.file({ reason: 'abuse' });
    const d = await w.file({ reason: 'vague' });
    await decide(w, a, 'upheld', 3);
    await decide(w, b, 'upheld', 4);
    await decide(w, c, 'upheld', 'uncovered');
    await decide(w, d, 'upheld', 2);
    expect(record(w, a)).toMatchObject({ reasonMatched: 2, reasonDecided: 3 });
  });

  it('other (no rules by default) and a legacy other report are left out: an honest "something else" is never inaccurate', async () => {
    const w = await world();
    const a = await w.file({ reason: 'other' });
    const b = await w.file({ category: 'bogus' });
    const c = await w.file({ reason: 'hate' });
    await decide(w, a, 'upheld', 2);
    await decide(w, b, 'upheld', 2);
    await decide(w, c, 'upheld', 1);
    expect(record(w, a)).toMatchObject({ reasonMatched: 1, reasonDecided: 1, actioned: 3 });
  });

  it('other with rules the studio gave it is judged like any reason', async () => {
    const w = await world();
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'other' ? { ...r, rules: [8] } : { ...r }));
    w.cw.policy.save({ reporting: { reasons } }, { version: 0, ...OWNER });
    const a = await w.file({ reason: 'other' });
    await decide(w, a, 'upheld', 8);
    expect(record(w, a)).toMatchObject({ reasonMatched: 1, reasonDecided: 1 });
  });

  it('the old disruption id counts as griefing (rule 6)', async () => {
    const w = await world();
    const f = await w.file({ category: 'disruption' });
    await decide(w, f, 'upheld', 6);
    expect(record(w, f)).toMatchObject({ reasonMatched: 1, reasonDecided: 1 });
  });

  it('only a rule cited against the reported person counts: one cited against the reporter does not', async () => {
    const w = await world();
    const f = await w.file({ reason: 'harassment' });
    await decide(w, f, 'no_action', 2, { on: f.reporter });
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 1 });
  });

  it('a reason switched off still counts; one removed from the list cannot be judged and is left out', async () => {
    const w = await world();
    const f = await w.file({ reason: 'afk' });
    const g = await w.file({ reason: 'sexual' });
    await decide(w, f, 'upheld', 6);
    await decide(w, g, 'upheld', 3);
    const reasons = w.cw.profile.reporting.reasons;
    w.cw.policy.save(
      { reporting: { reasons: reasons.filter((r) => r.id !== 'sexual').map((r) => (r.id === 'afk' ? { ...r, enabled: false } : { ...r })) } },
      { version: 0, ...OWNER },
    );
    expect(record(w, f)).toMatchObject({ reasonMatched: 1, reasonDecided: 1 });
  });

  it('is read against the rules in force now: changing the mapping changes the count', async () => {
    const w = await world();
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'upheld', 2);
    expect(record(w, f)).toMatchObject({ reasonMatched: 0, reasonDecided: 1 });
    const reasons = w.cw.profile.reporting.reasons.map((r) => (r.id === 'hate' ? { ...r, rules: [1, 2] } : { ...r }));
    w.cw.policy.save({ reporting: { reasons } }, { version: 0, ...OWNER });
    expect(record(w, f)).toMatchObject({ reasonMatched: 1, reasonDecided: 1 });
  });

  it('a store without the method reports 0 and 0 and the rest as before', async () => {
    const inner = new MemoryStore();
    const store = new Proxy(inner, {
      get(target, key) {
        if (key === 'loadReporterDecisions') return undefined;
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as Store;
    const w = await world({}, store);
    const f = await w.file({ reason: 'hate' });
    await decide(w, f, 'upheld', 1);
    expect(record(w, f)).toMatchObject({ reports: 1, actioned: 1, reasonMatched: 0, reasonDecided: 0 });
  });
});

describe('the reason filter on the queue', () => {
  async function seeded() {
    const w = await world();
    const ids: Record<string, string> = {};
    for (const [name, reason] of [['hate1', 'hate'], ['hate2', 'hate'], ['spam1', 'spam'], ['grief', 'griefing'], ['none1', undefined], ['none2', undefined], ['other1', 'other']] as const) {
      w.clock.t += 1000;
      ids[name] = (await w.file(reason === undefined ? {} : { reason })).id;
    }
    return { w, ids };
  }
  const idsOf = (page: { items: Array<{ id: string }> }): string[] => page.items.map((i) => i.id);

  it('keeps only the reports with that reason, newest first', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(w.cw.reports.list({ reason: 'hate' }))).toEqual([ids.hate2, ids.hate1]);
    expect(idsOf(w.cw.reports.list({ reason: 'spam' }))).toEqual([ids.spam1]);
    expect(idsOf(w.cw.reports.list({ reason: 'other' }))).toEqual([ids.other1]);
  });

  it('null means no reason given', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(w.cw.reports.list({ reason: null }))).toEqual([ids.none2, ids.none1]);
  });

  it('no filter lists everything, and an unknown but well-formed reason lists nothing', async () => {
    const { w } = await seeded();
    expect(w.cw.reports.list({}).items).toHaveLength(7);
    expect(w.cw.reports.list({ reason: 'gone_reason' }).items).toHaveLength(0);
  });

  it('the old disruption id finds griefing reports', async () => {
    const { w, ids } = await seeded();
    expect(idsOf(w.cw.reports.list({ reason: 'disruption' }))).toEqual([ids.grief]);
  });

  it('combines with status and pages correctly with a cursor', async () => {
    const { w, ids } = await seeded();
    await w.cw.decide({ reportId: ids.hate1 as string, verdict: 'no_action', actions: [], actor: 'mod_1', reason: 'fine' });
    expect(idsOf(w.cw.reports.list({ reason: 'hate', status: 'open' }))).toEqual([ids.hate2]);
    expect(idsOf(w.cw.reports.list({ reason: 'hate', status: 'dismissed' }))).toEqual([ids.hate1]);
    const first = w.cw.reports.list({ reason: null, limit: 1 });
    expect(idsOf(first)).toEqual([ids.none2]);
    expect(first.next).not.toBeNull();
    const second = w.cw.reports.list({ reason: null, limit: 1, before: first.next });
    expect(idsOf(second)).toEqual([ids.none1]);
  });

  it('a bad reason is a ReportQueryError on the reason field', async () => {
    const { w } = await seeded();
    for (const reason of ['Bad Id', '', 5, {}, 'x'.repeat(40), 'none']) {
      let caught: unknown;
      try {
        w.cw.reports.list({ reason: reason as never });
      } catch (err) {
        caught = err;
      }
      expect(caught, String(reason)).toBeInstanceOf(ReportQueryError);
      expect((caught as ReportQueryError).field).toBe('reason');
    }
  });

  it('does not combine with a person query (like status and before)', async () => {
    const { w } = await seeded();
    const p = w.cw.reports.list({ limit: 1 }).items[0]!.targetPerson;
    expect(() => w.cw.reports.list({ person: p, reason: 'hate' })).toThrow(ReportQueryError);
  });

  it('a store that ignores the filter is filtered again here', async () => {
    class Lax extends MemoryStore {
      override listReports(q: Parameters<MemoryStore['listReports']>[0]) {
        const { reason: _ignored, ...rest } = q as { reason?: unknown } & typeof q;
        void _ignored;
        return super.listReports(rest);
      }
    }
    const w = await world({}, new Lax());
    await w.file({ reason: 'hate' });
    await w.file({ reason: 'spam' });
    expect(w.cw.reports.list({ reason: 'hate' }).items.map((i) => i.reportedReason)).toEqual(['hate']);
  });
});

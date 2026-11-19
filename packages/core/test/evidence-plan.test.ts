import { describe, expect, it } from 'vitest';
import { planNotices } from '../src/noticeCopy.js';
import type { NoticeOp, PlanContext } from '../src/noticeCopy.js';

// planNotices carries the evidence kind (0.2.2): the hub's "What the player sees" panel words the notice the way the server will.

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const ctx: PlanContext = { now: () => NOW, ruleLabel: (r) => `Community Rule ${r}`, reporterFeedback: true, appeals: true, refCode: 'REF' };
const warn = { person: 'P-bob', kind: 'warning' as const, durationMs: null, rule: 6, lines: [] };
const decide = (over: Record<string, unknown> = {}): NoticeOp => ({ op: 'decide', verdict: 'upheld', target: 'P-bob', reporter: 'P-rep', actions: [warn], rename: null, ...over }) as NoticeOp;

describe('plan: decide', () => {
  it.each(['chat', 'play', 'name'] as const)('the sanction notice carries %s and the reporter thank-you carries none', (kind) => {
    const plan = planNotices(decide({ evidenceKind: kind }), ctx);
    expect(plan.notices[0]?.notice.evidence).toBe(kind);
    expect(plan.notices[1]?.notice.kind).toBe('report_outcome');
    expect(plan.notices[1]?.notice.evidence).toBeUndefined();
  });
  it('no kind, a null kind and an unknown kind read as none, with no key', () => {
    for (const evidence of [undefined, null, 'moon', 4]) {
      const n = planNotices(decide({ evidenceKind: evidence }), ctx).notices[0]?.notice as object;
      expect(Object.hasOwn(n, 'evidence'), String(evidence)).toBe(false);
    }
  });
  it('a rename notice carries none', () => {
    const plan = planNotices(decide({ evidenceKind: 'name', rename: { rule: 7 } }), ctx);
    const rename = plan.notices.find((n) => n.notice.kind === 'rename_required');
    expect(rename?.notice.evidence).toBeUndefined();
  });
});

describe('plan: an appeal that reduces the sanction', () => {
  const original = { kind: 'chat' as const, startsAt: NOW - DAY, endsAt: NOW + 6 * DAY, rule: 6, refCode: 'M-AAAAA' };
  it('the replacement sanction keeps the original kind; the outcome message has none', () => {
    const plan = planNotices({ op: 'appeal', outcome: 'reduce', original: { ...original, evidenceKind: 'play' }, to: { kind: 'warning', durationMs: null } } as NoticeOp, ctx);
    const replacement = plan.notices.find((n) => n.notice.kind === 'warning');
    expect(replacement?.notice.evidence).toBe('play');
    expect(plan.notices.find((n) => n.notice.kind === 'appeal_reduced')?.notice.evidence).toBeUndefined();
  });
  it('an original with no kind makes a replacement with none', () => {
    const plan = planNotices({ op: 'appeal', outcome: 'reduce', original, to: { kind: 'warning', durationMs: null } } as NoticeOp, ctx);
    expect(plan.notices.find((n) => n.notice.kind === 'warning')?.notice.evidence).toBeUndefined();
  });
});

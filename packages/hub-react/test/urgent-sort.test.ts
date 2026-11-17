// @vitest-environment node
import type { ReportSummary } from '@chatwarden/http/admin';
import { describe, expect, it } from 'vitest';
import { groupQueue } from '../src/queue.js';
import { MINUTE } from './world.js';
import { rig, settle } from './headless/kit.js';

// The queue pins urgent cases above every other group in every sort (design 5.2), the habitual-reporter rank-down never applies to one,
// and an urgent report older than the pages the queue loaded is found by `GET /reports?urgent=1`.

const NOW = 1_800_000_000_000;
let seq = 0;
function report(over: Partial<ReportSummary> = {}): ReportSummary {
  seq += 1;
  return {
    id: over.id ?? `r${String(seq).padStart(4, '0')}`,
    createdAt: NOW - 10 * MINUTE,
    roomId: 'room-a',
    tags: {},
    category: 'harassment',
    reportedReason: 'harassment',
    reportedReasonLabel: 'Insults or harassment',
    status: 'open',
    badFaith: false,
    targetPerson: 'person-a',
    reporterPerson: 'rep-1',
    actionedAt: null,
    actionedBy: null,
    targetHandle: null,
    reporterHandle: null,
    claim: null,
    viewing: [],
    ...over,
  };
}
const habitual = { decided: 20, unfounded: 18, falseRate: 0.9, habitual: true } as const;
const people = (items: ReportSummary[], sort: 'latest' | 'oldest' | 'reports' | 'priority', rankDown = false): string[] =>
  groupQueue(items, { sort, now: NOW, ...(rankDown ? { rankDown: { now: NOW } } : {}) }).map((g) => g.person);

/** Three ordinary cases and one urgent one that sorts LAST in every plain order. */
function fixture(): ReportSummary[] {
  return [
    report({ targetPerson: 'old', createdAt: NOW - 50 * MINUTE }),
    report({ targetPerson: 'old', createdAt: NOW - 49 * MINUTE }),
    report({ targetPerson: 'mid', createdAt: NOW - 40 * MINUTE }),
    report({ targetPerson: 'new', createdAt: NOW - 30 * MINUTE }),
    report({ targetPerson: 'threat', createdAt: NOW - 1 * MINUTE, urgent: true }),
  ];
}

describe('an urgent group sorts first under every sort', () => {
  it.each(['latest', 'oldest', 'reports', 'priority'] as const)('%s', (sort) => {
    expect(people(fixture(), sort)[0]).toBe('threat');
  });

  it('keeps the chosen order inside each part (urgent first, the rest as the sort puts them)', () => {
    const rest = (sort: 'latest' | 'oldest' | 'reports') => people(fixture(), sort).slice(1);
    expect(rest('oldest')).toEqual(['old', 'mid', 'new']);
    expect(rest('reports')).toEqual(['old', 'new', 'mid']);
    expect(rest('latest')).toEqual(['new', 'mid', 'old']);
  });

  it('two urgent groups keep the sort between them', () => {
    const items = [...fixture(), report({ targetPerson: 'threat2', createdAt: NOW - 45 * MINUTE, urgent: true })];
    expect(people(items, 'oldest').slice(0, 2)).toEqual(['threat2', 'threat']);
    expect(people(items, 'latest').slice(0, 2)).toEqual(['threat', 'threat2']);
  });

  it('a decided urgent report does not pin its person (only an open one does)', () => {
    const items = [...fixture().filter((r) => r.urgent !== true), report({ targetPerson: 'done', status: 'actioned', urgent: true, createdAt: NOW - 1 * MINUTE })];
    expect(people(items, 'oldest')).not.toContain('threat');
    expect(groupQueue(items, { sort: 'oldest', now: NOW }).find((g) => g.person === 'done')?.urgent).toBeUndefined();
  });

  it('with no urgent report the order and the groups are exactly what they were (no key appears)', () => {
    const plain = fixture().filter((r) => r.urgent !== true);
    const groups = groupQueue(plain, { sort: 'oldest', now: NOW });
    expect(groups.map((g) => g.person)).toEqual(['old', 'mid', 'new']);
    for (const g of groups) {
      expect(g).not.toHaveProperty('urgent');
      expect(g).not.toHaveProperty('urgentOpen');
      expect(g).not.toHaveProperty('oldestUrgentAt');
    }
  });

  it('counts the open urgent reports and the oldest wait of each group', () => {
    const items = [
      report({ targetPerson: 'p', urgent: true, createdAt: NOW - 20 * MINUTE }),
      report({ targetPerson: 'p', urgent: true, createdAt: NOW - 5 * MINUTE }),
      report({ targetPerson: 'p', createdAt: NOW - 90 * MINUTE }),
    ];
    const g = groupQueue(items, { now: NOW })[0];
    expect(g?.urgent).toBe(true);
    expect(g?.urgentOpen).toBe(2);
    expect(g?.oldestUrgentAt).toBe(NOW - 20 * MINUTE);
  });
});

describe('the habitual-reporter mark never applies to an urgent group', () => {
  it('a rankedLow group that is urgent is not demoted and carries no mark; the same group without urgent is demoted', () => {
    const ordinary = [
      report({ targetPerson: 'habit', createdAt: NOW - 1 * MINUTE, reporterAccuracy: habitual }),
      report({ targetPerson: 'calm', createdAt: NOW - 2 * MINUTE }),
    ];
    expect(people(ordinary, 'latest', true)).toEqual(['calm', 'habit']);
    const urgent = [report({ targetPerson: 'habit', createdAt: NOW - 1 * MINUTE, reporterAccuracy: habitual, urgent: true }), ordinary[1] as ReportSummary];
    const groups = groupQueue(urgent, { sort: 'latest', now: NOW, rankDown: { now: NOW } });
    expect(groups.map((g) => g.person)).toEqual(['habit', 'calm']);
    expect(groups[0]?.rankedLow).toBe(false);
  });
});

describe('an urgent report older than the loaded pages', () => {
  it('is fetched by urgent=1 and merged into the queue; GET /changes carries the count', async () => {
    const r = await rig();
    const urgent = await r.w.file({ target: 'Threatener', reason: 'threat' });
    r.w.clock.t += MINUTE;
    await r.w.file({ target: 'Alpha' });
    // The open pages the queue reads do not reach the old report (as with a queue of more than 1 000 reports): the server's
    // plain open listing leaves it out, the urgent listing still has it.
    r.w.intercept.fn = async (req) => {
      if (req.method === 'GET' && req.path === '/reports' && req.query?.['urgent'] === undefined) {
        const real = await r.w.direct.listReports({ status: 'open' });
        return { status: 200, body: { items: real.items.filter((i) => i.id !== urgent.id), next: null } };
      }
      return undefined;
    };
    await r.controller.start();
    await settle();
    const s = r.controller.queue.getSnapshot();
    expect(s.groups[0]?.person).toBe(urgent.person);
    expect(s.groups[0]?.urgent).toBe(true);
    expect(s.urgent).toBe(1);
    expect(r.count('GET', '/reports')).toBe(2);
  });

  it('asks for the urgent list only when the count says there is one', async () => {
    const r = await rig();
    await r.w.file({ target: 'Alpha' });
    await r.controller.start();
    await settle();
    const asked = r.w.sent.filter((q) => q.method === 'GET' && q.path === '/reports' && q.query?.['urgent'] !== undefined);
    expect(asked).toHaveLength(0);
    expect(r.controller.queue.getSnapshot().urgent).toBe(0);
  });

  it('a failed urgent read does not take the queue down: the ordinary list shows, the count still reads', async () => {
    const r = await rig();
    const u = await r.w.file({ target: 'Threatener', reason: 'threat' });
    r.w.intercept.fn = (req) => (req.path === '/reports' && req.query?.['urgent'] !== undefined ? { status: 500, body: { error: 'boom', message: 'x' } } : undefined);
    await r.controller.start();
    await settle();
    const s = r.controller.queue.getSnapshot();
    expect(s.status).toBe('ready');
    expect(s.groups.map((g) => g.person)).toEqual([u.person]);
    expect(s.urgent).toBe(1);
  });
});

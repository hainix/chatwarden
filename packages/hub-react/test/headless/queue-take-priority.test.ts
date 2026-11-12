// @vitest-environment node
import { fakeRead } from '@chatwarden/core';
import type { AIReadInput } from '@chatwarden/core';
import { describe, expect, it } from 'vitest';
import type { DecideInput } from '../../src/types.js';
import { loadAiRank } from '../../src/headless/index.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// The hub's queue is in `priority` order once it holds AI reads, and Take next then means the case at the top of that list, not the one that
// waited longest (the maintainer's ruling, design addenda). Over the real routes with the scripted fake behind them, without a React hub.

const OK: DecideInput = { verdict: 'no_action', reason: 'Nothing to act on.', actions: [] };
const ME = 'ann@example.test';

const reading = (severity: 'banter' | 'rude' | 'hostile' | 'severe') => (input: AIReadInput) => {
  const base = fakeRead(input);
  return { output: { ...base, severity, recommendation: { ...base.recommendation, severity } } };
};
/** The i-th read the fake gives is of this severity (reports are read in the order they are filed). */
const bySeq = (severities: Array<'banter' | 'rude' | 'hostile' | 'severe'>) => {
  let n = 0;
  return (input: AIReadInput) => reading(severities[Math.min(n++, severities.length - 1)] as 'banter')(input);
};

/** Cases filed oldest first, each read by the AI before the next is filed; the first is the mildest. */
async function aiRig(severities: Array<'banter' | 'rude' | 'hostile' | 'severe'>, names = ['Alpha', 'Bravo', 'Charlie']) {
  const r = await rig({ world: { ai: { level: 1, script: bySeq(severities) } } });
  const files = [];
  for (const target of names.slice(0, severities.length)) {
    files.push(await r.w.file({ target }));
    await r.w.aiIdle();
    r.w.clock.t += MINUTE;
  }
  await r.controller.start();
  await settle();
  return { r, files };
}
const order = (r: Rig): string[] => r.controller.queue.getSnapshot().rows.map((x) => x.group.person);
const group = (r: Rig, person: string) => r.controller.queue.getSnapshot().groups.find((g) => g.person === person);
const claimsOf = (r: Rig): string[] => r.w.sent.filter((s) => s.method === 'POST' && /\/claim$/.test(s.path)).map((s) => decodeURIComponent(s.path.split('/')[2] as string));

describe('the headless queue ranks by priority once the server sends AI reads', () => {
  it('loadAiRank is on the headless entry, and gives the three names', async () => {
    const m = await loadAiRank();
    expect(Object.keys(m).sort()).toEqual(['RANK_WEIGHTS', 'priorityScore', 'reporterSignal']);
    expect(typeof m.priorityScore).toBe('function');
  });

  it('a severe case filed last is listed first, and the queue says it is ranked (no HubProvider anywhere)', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    expect(order(r)).toEqual([files[2]!.person, files[1]!.person, files[0]!.person]);
    expect(r.controller.queue.getSnapshot().ranked).toBe(true);
  });

  it('with no AI read in the queue it is the longest wait first, and not ranked', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo' });
    await r.controller.start();
    await settle();
    expect(order(r)).toEqual([a.person, b.person]);
    expect(r.controller.queue.getSnapshot().ranked).toBe(false);
  });
});

describe('Take next in priority order', () => {
  it('claims the top case of the list as shown, with no call to the server\'s take-next', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    const taken = await r.controller.takeNext();
    expect(taken).toEqual({ status: 'taken', reportId: files[2]!.id, person: files[2]!.person });
    expect(group(r, files[2]!.person)?.claim?.by).toBe(ME);
    expect(r.count('POST', '/cases/next')).toBe(0);
    expect(claimsOf(r)).toEqual([files[2]!.person]);
  });

  it('shows the report it took', async () => {
    const shown: string[] = [];
    const r = await rig({ world: { ai: { level: 1, script: bySeq(['banter', 'severe']) } }, controller: { host: { show: (id) => shown.push(id) } } });
    const a = await r.w.file({ target: 'Alpha' });
    await r.w.aiIdle();
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo' });
    await r.w.aiIdle();
    await r.controller.start();
    await settle();
    expect((await r.controller.takeNext()).status).toBe('taken');
    expect(shown).toEqual([b.id]);
    expect(group(r, a.person)?.claim).toBeNull();
  });

  it('skips a case someone holds: the next one down the list', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    await r.w.clientFor('bea@example.test').claimCase(files[2]!.person);
    await r.controller.queue.reload();
    const taken = await r.controller.takeNext();
    expect(taken).toMatchObject({ status: 'taken', person: files[1]!.person });
    expect(r.count('POST', '/cases/next')).toBe(0);
  });

  it('the race: someone else claims the top case after the list was read, so the next one is taken, and the list learns who holds the first', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    // The list on screen still shows the severe case free: only the claim call finds out.
    await r.w.clientFor('bea@example.test').claimCase(files[2]!.person);
    expect(group(r, files[2]!.person)?.claim ?? null).toBeNull();
    const taken = await r.controller.takeNext();
    expect(taken).toMatchObject({ status: 'taken', person: files[1]!.person });
    expect(claimsOf(r)).toEqual([files[2]!.person, files[1]!.person]);
    expect(group(r, files[2]!.person)?.claim?.by).toBe('bea@example.test');
    expect(group(r, files[1]!.person)?.claim?.by).toBe(ME);
    // No "held by" toast for a race the moderator never saw.
    expect(r.controller.toasts.getSnapshot().map((t) => t.text)).toEqual([]);
  });

  it('the race lost on every case on the list falls back to the server, which says there is nothing', async () => {
    const { r, files } = await aiRig(['banter', 'severe']);
    const bea = r.w.clientFor('bea@example.test');
    for (const f of files) await bea.claimCase(f.person);
    const before = claimsOf(r).length;
    const out = await r.controller.takeNext();
    expect(out.status).toBe('none');
    // Both claims were tried, the top one first; both were lost.
    expect(claimsOf(r).slice(before)).toEqual([files[1]!.person, files[0]!.person]);
    expect(r.count('POST', '/cases/next')).toBe(1);
  });

  it('an error that is not a lost race is a failed take, and the other cases are not claimed', async () => {
    const { r, files } = await aiRig(['banter', 'severe']);
    r.w.intercept.fn = (req) => (req.method === 'POST' && /\/claim$/.test(req.path) ? { status: 500, headers: {}, body: { error: 'boom', message: 'x' } } : undefined);
    const out = await r.controller.takeNext();
    expect(out.status).toBe('failed');
    expect(claimsOf(r)).toEqual([files[1]!.person]);
  });

  it('respects the reason filter: the top case that passes it, not the top case', async () => {
    const r = await rig({ world: { ai: { level: 1, script: bySeq(['banter', 'severe']) } } });
    const a = await r.w.file({ target: 'Alpha', category: 'spam' });
    await r.w.aiIdle();
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo', category: 'harassment' });
    await r.w.aiIdle();
    await r.controller.start();
    await settle();
    r.controller.queue.setFilter({ category: 'spam' });
    const out = await r.controller.takeNext();
    expect(out).toMatchObject({ status: 'taken', person: a.person });
    expect(group(r, b.person)?.claim ?? null).toBeNull();
  });

  it('without AI reads it is still the server\'s take-next (oldest unclaimed)', async () => {
    const r = await rig();
    const a = await r.w.file({ target: 'Alpha' });
    r.w.clock.t += MINUTE;
    await r.w.file({ target: 'Bravo' });
    await r.controller.start();
    await settle();
    expect(await r.controller.takeNext()).toMatchObject({ status: 'taken', person: a.person });
    expect(r.count('POST', '/cases/next')).toBe(1);
  });

  it('after Accept: continueFrom takes the top case when the person has no other open report', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    // The moderator is on the mildest case; its decision is made; the next is the top of the list, not the oldest.
    const a = files[0]!;
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    const out = await r.controller.continueFrom({ reportId: a.id, person: a.person }, { quick: true });
    expect(out).toMatchObject({ status: 'taken', person: files[2]!.person });
    expect(r.count('POST', '/cases/next')).toBe(0);
  });

  it('after Accept: the race on the top case moves on to the next, quick or not', async () => {
    const { r, files } = await aiRig(['banter', 'rude', 'severe']);
    const a = files[0]!;
    await r.w.clientFor('bea@example.test').claimCase(files[2]!.person);
    void r.controller.decide({ reportId: a.id, person: a.person, input: OK });
    const out = await r.controller.continueFrom({ reportId: a.id, person: a.person });
    expect(out).toMatchObject({ status: 'taken', person: files[1]!.person });
  });

  it('does not take the case the moderator has just decided, though it is still on the list', async () => {
    const { r, files } = await aiRig(['severe', 'banter']);
    const top = files[0]!;
    // The severe case is the top of the list; its decision is on its way, so it is not offered.
    void r.controller.decide({ reportId: top.id, person: top.person, input: OK });
    const out = await r.controller.continueFrom({ reportId: top.id, person: top.person }, { quick: true });
    expect(out).toMatchObject({ status: 'taken', person: files[1]!.person });
  });

  it('a second take within the cooldown is still busy', async () => {
    const { r } = await aiRig(['banter', 'severe']);
    expect((await r.controller.takeNext()).status).toBe('taken');
    expect((await r.controller.takeNext()).status).toBe('busy');
  });
});

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { POLL_VISIBLE_MS } from '../../src/live.js';
import { MINUTE } from '../world.js';
import { rig, settle } from './kit.js';
import type { Rig } from './kit.js';

// The live queue ranks a case lower when every open report on it is from a habitual false reporter, on the real routes (the kit
// computes the figure from decided reports). Ranking only orders: it never hides a case, and never moves a row under the pointer.

const dismiss = (r: Rig, id: string) => r.w.client.decide(id, { verdict: 'no_action', actions: [] });

/** Makes `reporter` a reporter with `count` dismissed reports (the kit needs five decided before it says a rate). */
async function dismissedReports(r: Rig, reporter: string, count: number, prefix = 'Filler'): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const f = await r.w.file({ target: `${prefix}${reporter}${i}`, reporter });
    await dismiss(r, f.id);
  }
}
const rows = (r: Rig): string[] => r.controller.queue.getSnapshot().rows.map((x) => x.group.person);
const groups = (r: Rig) => r.controller.queue.getSnapshot().groups;

describe('the live queue ranks cases from habitual reporters lower', () => {
  it('on the first load a habitual reporter\'s older case is listed after an ordinary newer one, and is still listed', async () => {
    const r = await rig();
    await dismissedReports(r, 'Rita', 5);
    const a = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    expect(rows(r)).toEqual([b.person, a.person]);
    expect(groups(r).find((g) => g.person === a.person)?.rankedLow).toBe(true);
    expect(groups(r).find((g) => g.person === b.person)?.rankedLow).toBe(false);
    expect(r.controller.queue.getSnapshot().visible).toHaveLength(2);
  });

  it('below the minimum sample nobody is ranked: four dismissed reports are not a rate', async () => {
    const r = await rig();
    await dismissedReports(r, 'Rita', 4);
    const a = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    expect(rows(r)).toEqual([a.person, b.person]);
    expect(groups(r).every((g) => g.rankedLow === false)).toBe(true);
  });

  it('a case waiting a day is no longer ranked low, whatever the reporter\'s record', async () => {
    const r = await rig();
    await dismissedReports(r, 'Rita', 5);
    const a = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    r.w.clock.t += 25 * 60 * MINUTE;
    const b = await r.w.file({ target: 'Bravo', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    expect(rows(r)).toEqual([a.person, b.person]);
    expect(groups(r).find((g) => g.person === a.person)?.rankedLow).toBe(false);
  });

  it('a row ranked low by a refresh does not move on screen; it moves on "N new" (showIncoming)', async () => {
    const r = await rig();
    await dismissedReports(r, 'Rita', 4);
    const a = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    expect(rows(r)).toEqual([a.person, b.person]);
    // Rita's fifth dismissal makes her habitual while the moderator is looking at the list.
    r.controller.queue.setInteracting(true);
    const fifth = await r.w.file({ target: 'FillerTarget', reporter: 'Rita' });
    await dismiss(r, fifth.id);
    await r.timers.advance(POLL_VISIBLE_MS);
    expect(groups(r).find((g) => g.person === a.person)?.rankedLow).toBe(true);
    expect(rows(r)).toEqual([a.person, b.person]);
    r.controller.queue.setInteracting(false);
    expect(rows(r)).toEqual([a.person, b.person]);
    r.controller.queue.showIncoming();
    expect(rows(r)).toEqual([b.person, a.person]);
  });

  it('a role without history.read gets no figure, so the queue ranks nobody (the summary field is the only source)', async () => {
    const r = await rig({ world: { permissions: { 'history.read': 'senior' } } });
    await dismissedReports(r, 'Rita', 5);
    const a = await r.w.file({ target: 'Alpha', reporter: 'Rita' });
    r.w.clock.t += MINUTE;
    const b = await r.w.file({ target: 'Bravo', reporter: 'Sam' });
    await r.controller.start();
    await settle();
    expect(rows(r)).toEqual([a.person, b.person]);
    expect(groups(r).every((g) => g.rankedLow === false)).toBe(true);
  });
});

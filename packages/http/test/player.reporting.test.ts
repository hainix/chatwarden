import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { createChatwarden } from '@chatwarden/core';
import type { ProfileOverrides, RawWho } from '@chatwarden/core';
import { openStore } from '@chatwarden/store-sqlite';
import { createRouter, playerRoutes } from '@chatwarden/http';
import type { KitResponse } from '@chatwarden/http';
import { keysDeep } from './world.js';

// GET /rules carries `reporting`: the flow, the enabled reasons (id, label, hint, group, asksNote) and the thank-you, so the player UI
// can render the report screen. It is public, so it must carry nothing of the staff side.

type ReportingOverrides = NonNullable<ProfileOverrides['reporting']>;

async function setup(overrides?: ReportingOverrides) {
  const store = openStore({ db: new DatabaseSync(':memory:') });
  const cw = await createChatwarden({
    store,
    secret: 'player-reporting',
    platform: { identify: (ctx) => ctx as RawWho },
    retention: false,
    ...(overrides === undefined ? {} : { overrides: { reporting: overrides } as ProfileOverrides }),
  });
  const router = createRouter(playerRoutes(cw, { identify: () => ({}) }));
  const rules = (): Promise<KitResponse> => router({ method: 'GET', path: '/rules', query: {}, headers: {}, body: undefined });
  return { cw, rules };
}

interface Reporting {
  flow: string;
  reasons: Array<Record<string, unknown>>;
  thanks: string;
}
const reportingOf = (res: KitResponse): Reporting => (res.body as { reporting: Reporting }).reporting;

describe('GET /rules: reporting', () => {
  it('carries the default flow, the ten default reasons in order and the default thank-you', async () => {
    const { rules } = await setup();
    const res = await rules();
    expect(res.status).toBe(200);
    expect(Object.keys(res.body as object).sort()).toEqual(['reporting', 'rules', 'summary']);
    const r = reportingOf(res);
    expect(r.flow).toBe('one_tap');
    expect(r.thanks).toBe("Thanks for the report. We'll look into it.");
    expect(r.reasons.map((x) => x.id)).toEqual(['harassment', 'hate', 'sexual', 'threat', 'spam', 'personal_info', 'cheating', 'griefing', 'afk', 'other']);
    expect(r.reasons.map((x) => x.label)).toEqual([
      'Insults or harassment', 'Hate', 'Sexual content', 'Threats', 'Spam or ads', 'Sharing personal info', 'Cheating', 'Throwing or griefing', 'Leaving or AFK', 'Something else',
    ]);
    expect(r.reasons.map((x) => x.group)).toEqual(['Chat', 'Chat', 'Chat', 'Chat', 'Chat', 'Chat', 'Gameplay', 'Gameplay', 'Gameplay', '']);
    expect(r.reasons.map((x) => x.asksNote)).toEqual([false, false, false, false, false, false, false, false, false, true]);
  });

  it('each reason has exactly id, label, hint, group, asksNote', async () => {
    const { rules } = await setup();
    for (const x of reportingOf(await rules()).reasons) expect(Object.keys(x).sort()).toEqual(['asksNote', 'group', 'hint', 'id', 'label']);
  });

  it('lists enabled reasons only, and follows the studio’s order, labels, hints and groups', async () => {
    const { rules } = await setup({
      flow: 'reason_first',
      thanks: 'Got it, thank you.',
      reasons: [
        { id: 'lag_switch', label: 'Lag switching', hint: 'Cutting their own connection', group: 'Gameplay', rules: [5], asksNote: true },
        { id: 'hidden', label: 'Hidden', enabled: false },
        { id: 'other', label: 'Anything else' },
      ],
    });
    const r = reportingOf(await rules());
    expect(r).toEqual({
      flow: 'reason_first',
      thanks: 'Got it, thank you.',
      reasons: [
        { id: 'lag_switch', label: 'Lag switching', hint: 'Cutting their own connection', group: 'Gameplay', asksNote: true },
        { id: 'other', label: 'Anything else', hint: '', group: '', asksNote: false },
      ],
    });
  });

  it('is live: an edit saved through the policy shows at once', async () => {
    const { rules, cw } = await setup();
    expect(reportingOf(await rules()).flow).toBe('one_tap');
    const saved = cw.policy.save({ reporting: { flow: 'reason_required', thanks: 'Thanks!' } }, { version: 0, actor: 'owner_ann', reason: 'switch flow' });
    expect(saved.ok).toBe(true);
    expect(reportingOf(await rules())).toMatchObject({ flow: 'reason_required', thanks: 'Thanks!' });
    cw.policy.reset('reporting');
    expect(reportingOf(await rules()).flow).toBe('one_tap');
  });

  it('shows no staff field: no rule mapping, no enabled flag, no ids of people, nothing of the policy', async () => {
    const { rules } = await setup({ reasons: [{ id: 'a', label: 'A', rules: [1, 2], enabled: true }, { id: 'b', label: 'B', rules: [3], enabled: false }, { id: 'other', label: 'Else' }] });
    const res = await rules();
    const reporting = reportingOf(res);
    const keys = keysDeep(reporting);
    for (const forbidden of ['rules', 'enabled', 'rule', 'subject', 'actor', 'reason', 'profile', 'layer', 'version']) expect(keys.has(forbidden), forbidden).toBe(false);
    const text = JSON.stringify(reporting);
    expect(text).not.toMatch(/"B"/);
    expect(text).not.toContain('[1,2]');
    expect(Object.keys(reporting).sort()).toEqual(['flow', 'reasons', 'thanks']);
  });

  it('needs no identity and is the same for everyone', async () => {
    const { rules } = await setup();
    expect((await rules()).body).toEqual((await rules()).body);
  });

  it('the existing summary and rules are unchanged', async () => {
    const { rules, cw } = await setup();
    const body = (await rules()).body as { summary: string; rules: Array<Record<string, unknown>> };
    expect(body.summary).toBe(cw.summary);
    for (const r of body.rules) expect(Object.keys(r).sort()).toEqual(['number', 'text', 'title']);
  });
});

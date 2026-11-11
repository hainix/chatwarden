import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@chatwarden/store-memory';
import { AUDIT_ACTIONS } from '../src/audit.js';
import { createChatwarden } from '../src/chatwarden.js';
import { POLICY_SECTIONS } from '../src/profile.js';
import type { Platform, RawWho } from '../src/types.js';

const NOW = 1_800_000_000_000;

async function setup() {
  const clock = { t: NOW, now: () => clock.t };
  const platform: Platform = { identify: (ctx) => ctx as RawWho };
  const cw = await createChatwarden({ store: new MemoryStore(), secret: 'audit-policy', platform, clock, logger: { warn: () => undefined }, retention: false });
  return { cw, clock };
}

const rec = (cw: Awaited<ReturnType<typeof setup>>['cw'], over: Record<string, unknown> = {}): boolean =>
  cw.audit.record({ actor: 'owner_ann', role: 'owner', action: 'policy.update', ...over } as never);

describe('the policy audit actions', () => {
  it('policy.update and policy.reset join the closed list, at the end', () => {
    expect(AUDIT_ACTIONS.slice(-2)).toEqual(['policy.update', 'policy.reset']);
  });

  it('record a detail of the sections changed and the reason, and list it back', async () => {
    const { cw, clock } = await setup();
    expect(rec(cw, { detail: { sections: ['durations', 'ladder'], reason: 'Lae asked for 1, 6 and 12 hours' } })).toBe(true);
    clock.t += 1;
    expect(rec(cw, { action: 'policy.reset', detail: { sections: [] } })).toBe(true);
    const items = cw.audit.list({ limit: 10 }).items;
    expect(items).toHaveLength(2);
    expect(items[1]).toMatchObject({ action: 'policy.update', actor: 'owner_ann', role: 'owner', detail: { sections: ['durations', 'ladder'], reason: 'Lae asked for 1, 6 and 12 hours' } });
    expect(items[0]).toMatchObject({ action: 'policy.reset', detail: { sections: [] } });
  });

  it('a reason is optional, and is trimmed', async () => {
    const { cw, clock } = await setup();
    expect(rec(cw, { detail: { sections: ['repeat'] } })).toBe(true);
    clock.t += 1;
    expect(rec(cw, { detail: { sections: ['repeat'], reason: '  padded  ' } })).toBe(true);
    const [second, first] = cw.audit.list({ limit: 10 }).items;
    expect(first?.detail).toEqual({ sections: ['repeat'] });
    expect(second?.detail).toEqual({ sections: ['repeat'], reason: 'padded' });
  });

  it('duplicate sections are listed once', async () => {
    const { cw } = await setup();
    expect(rec(cw, { detail: { sections: ['repeat', 'repeat', 'ladder'] } })).toBe(true);
    expect(cw.audit.list({ limit: 1 }).items[0]?.detail?.sections).toEqual(['repeat', 'ladder']);
  });

  it('every editable section is accepted', async () => {
    const { cw } = await setup();
    expect(rec(cw, { detail: { sections: [...POLICY_SECTIONS] } })).toBe(true);
  });

  const REFUSED: Array<[string, Record<string, unknown>]> = [
    ['an unknown section', { detail: { sections: ['profanity'] } }],
    ['a section that is not a string', { detail: { sections: [1] } }],
    ['sections that are not a list', { detail: { sections: 'ladder' } }],
    ['missing sections', { detail: { reason: 'why' } }],
    ['a blank reason', { detail: { sections: [], reason: '   ' } }],
    ['a reason over 2000 characters', { detail: { sections: [], reason: 'x'.repeat(2001) } }],
    ['a reason that is not text', { detail: { sections: [], reason: 5 } }],
    ['another key in the detail', { detail: { sections: [], note: 'free text' } }],
    ['a detail that is not an object', { detail: 'ladder' }],
    ['a null detail', { detail: null }],
    ['an array detail', { detail: [] }],
    ['no detail at all (the row must say what changed)', {}],
  ];
  for (const [name, over] of REFUSED) {
    it(`refuses ${name}`, async () => {
      const { cw } = await setup();
      expect(rec(cw, over)).toBe(false);
      expect(cw.audit.list({ limit: 5 }).items).toEqual([]);
    });
  }

  it('a 2000 character reason is accepted', async () => {
    const { cw } = await setup();
    expect(rec(cw, { detail: { sections: [], reason: 'x'.repeat(2000) } })).toBe(true);
  });

  it('refuses a detail on any other action: no other row may carry free text', async () => {
    const { cw } = await setup();
    for (const action of AUDIT_ACTIONS.filter((a) => !a.startsWith('policy.u') && a !== 'policy.reset')) {
      expect(rec(cw, { action, detail: { sections: [], reason: 'smuggled' } }), action).toBe(false);
    }
    expect(cw.audit.list({ limit: 5 }).items).toEqual([]);
  });

  it('other rows still carry no detail key at all', async () => {
    const { cw } = await setup();
    expect(rec(cw, { action: 'policy.view' })).toBe(true);
    const item = cw.audit.list({ limit: 1 }).items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {})).not.toContain('detail');
  });
});

import { describe, expect, it } from 'vitest';
import { OWNER, world } from './reportingWorld.js';

// The `reporting` section through cw.policy: save, reset, preview, the changed sections and a layer that is refused.

const reasons = (labels: Record<string, string> = {}) => [
  { id: 'lag', label: labels.lag ?? 'Lag switching', hint: 'Cutting their own connection', group: 'Gameplay', rules: [5], asksNote: true },
  { id: 'other', label: 'Something else' },
];

describe('cw.policy and the reporting section', () => {
  it('starts with the defaults in effective and base', async () => {
    const { cw } = await world();
    const s = cw.policy.get();
    expect(s.effective.reporting.flow).toBe('one_tap');
    expect(s.effective.reporting.reasons).toHaveLength(10);
    expect(s.base.reporting).toEqual(s.effective.reporting);
  });

  it('save with a reporting layer changes cw.profile at once and reports the section', async () => {
    const { cw } = await world();
    const res = cw.policy.save({ reporting: { flow: 'reason_first', reasons: reasons(), thanks: 'Thank you, we read every one.' } }, { version: 0, ...OWNER });
    expect(res).toEqual({ ok: true, version: 1, changed: ['reporting'] });
    expect(cw.profile.reporting.flow).toBe('reason_first');
    expect(cw.profile.reporting.reasons.map((r) => r.id)).toEqual(['lag', 'other']);
    expect(cw.profile.reporting.thanks).toBe('Thank you, we read every one.');
    expect(cw.policy.get().layer.reporting?.flow).toBe('reason_first');
    // The base is untouched.
    expect(cw.policy.get().base.reporting.flow).toBe('one_tap');
  });

  it('a saved layer survives a second kit over the same store (another process)', async () => {
    const { cw, store } = await world();
    cw.policy.save({ reporting: { reasons: reasons() } }, { version: 0, ...OWNER });
    const { cw: other } = await world({}, store);
    expect(other.profile.reporting.reasons.map((r) => r.id)).toEqual(['lag', 'other']);
  });

  it('a section edited twice with the same value is no change', async () => {
    const { cw } = await world();
    cw.policy.save({ reporting: { flow: 'reason_first' } }, { version: 0, ...OWNER });
    expect(cw.policy.save({ reporting: { flow: 'reason_first' }, durations: [3_600_000] }, { version: 1, ...OWNER })).toMatchObject({ changed: ['durations'] });
  });

  it.each([
    [{ flow: 'pick' }, 'layer.reporting.flow'],
    [{ reasons: [] }, 'layer.reporting.reasons'],
    [{ reasons: [{ id: 'lag', label: 'Lag' }] }, 'layer.reporting.reasons'],
    [{ reasons: [{ id: 'Lag', label: 'Lag' }, { id: 'other', label: 'x' }] }, 'layer.reporting.reasons[0].id'],
    [{ reasons: [{ id: 'a', label: 'A', rules: [0] }, { id: 'other', label: 'x' }] }, 'layer.reporting.reasons[0].rules[0]'],
    [{ reasons: [{ id: 'other', label: 'x', enabled: false }, { id: 'a', label: 'A' }] }, 'layer.reporting.reasons[0].enabled'],
    [{ thanks: '' }, 'layer.reporting.thanks'],
  ])('refuses %j with path %s and writes nothing', async (reporting, path) => {
    const { cw } = await world();
    expect(cw.policy.save({ reporting } as never, { version: 0, ...OWNER })).toEqual({ ok: false, error: 'invalid', path });
    expect(cw.policy.get().version).toBe(0);
  });

  it('reset("reporting") puts the reporting settings back and leaves the other sections', async () => {
    const { cw } = await world();
    cw.policy.save({ reporting: { reasons: reasons() }, customDuration: false }, { version: 0, ...OWNER });
    expect(cw.policy.reset('reporting')).toMatchObject({ ok: true, changed: ['reporting'] });
    expect(cw.profile.reporting.reasons).toHaveLength(10);
    expect(cw.profile.customDuration).toBe(false);
    expect(cw.policy.reset('reporting')).toMatchObject({ ok: true, changed: [] });
  });

  it('a code override is the base: the layer merges on top of it', async () => {
    const { cw } = await world({ overrides: { reporting: { thanks: 'From code.', flow: 'reason_first' } } });
    cw.policy.save({ reporting: { flow: 'reason_required' } }, { version: 0, ...OWNER });
    expect(cw.profile.reporting.flow).toBe('reason_required');
    expect(cw.profile.reporting.thanks).toBe('From code.');
    expect(cw.policy.get().base.reporting.flow).toBe('reason_first');
  });

  it('a profile given in code with a bad reporting section fails creation with a ProfileError path', async () => {
    await expect(world({ overrides: { reporting: { reasons: [{ id: 'x y', label: 'bad' }] } } })).rejects.toMatchObject({ name: 'ProfileError', path: 'profile.reporting.reasons[0].id' });
  });

  describe('preview', () => {
    it('shows what players would read of the candidate: enabled reasons, flow, thanks, and no rule mapping', async () => {
      const { cw } = await world();
      const res = cw.policy.preview({ reporting: { flow: 'reason_required', thanks: 'Got it.', reasons: [...reasons(), { id: 'old', label: 'Old', enabled: false }] } });
      if (!res.ok) throw new Error('expected ok');
      expect(res.reporting).toEqual({
        flow: 'reason_required',
        thanks: 'Got it.',
        reasons: [
          { id: 'lag', label: 'Lag switching', hint: 'Cutting their own connection', group: 'Gameplay', asksNote: true },
          { id: 'other', label: 'Something else', hint: '', group: '', asksNote: false },
        ],
      });
      expect(JSON.stringify(res.reporting)).not.toMatch(/"rules"|"enabled"/);
      expect(Object.keys(res.samples)).toHaveLength(4);
    });

    it('an empty layer previews the defaults; an invalid reporting layer is invalid with its path, and saves nothing', async () => {
      const { cw } = await world();
      const ok = cw.policy.preview({});
      expect(ok.ok && ok.reporting.reasons).toHaveLength(10);
      expect(cw.policy.preview({ reporting: { flow: 'x' } } as never)).toEqual({ ok: false, error: 'invalid', path: 'layer.reporting.flow' });
      expect(cw.policy.get().version).toBe(0);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_REPORT_REASONS, defaultReporting, fillReporting, legacyCategoryOf, playerReporting, resolveReporting } from '../src/reporting.js';
import { applyPolicyLayer, defineProfile, PRESETS, ProfileError, resolveProfile, validateProfile } from '../src/profile.js';
import type { ModerationProfile, PolicyLayer } from '../src/profile.js';
import { resolveSafety } from '../src/safety.js';

// The reason fields of this theme: urgent, thanks and showResources, the disabled welfare reason, evidenceUrl, and what a player may read.

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const byId = (id: string) => DEFAULT_REPORT_REASONS.find((r) => r.id === id);
const withReasons = (reasons: unknown[], extra: Record<string, unknown> = {}): ModerationProfile =>
  ({ ...PRESETS.standard, reporting: { reasons, ...extra } }) as unknown as ModerationProfile;
const other = { id: 'other', label: 'Something else' };

describe('default reasons', () => {
  it('threat is urgent; welfare exists, is disabled, urgent, showResources and has no rule; every other default is not urgent; the list still has other enabled', () => {
    expect(byId('threat')?.urgent).toBe(true);
    const welfare = byId('welfare');
    expect(welfare).toMatchObject({ id: 'welfare', label: 'Someone may be in trouble', group: 'Players', rules: [], enabled: false, urgent: true, showResources: true, asksNote: true });
    expect(welfare?.hint).toBe('Someone who says they want to hurt themselves, or may be at risk');
    for (const r of DEFAULT_REPORT_REASONS) if (r.id !== 'threat' && r.id !== 'welfare') expect(r.urgent, r.id).toBe(false);
    expect(DEFAULT_REPORT_REASONS.filter((r) => r.showResources).map((r) => r.id)).toEqual(['welfare']);
    expect(byId('other')?.enabled).toBe(true);
    expect(DEFAULT_REPORT_REASONS.every((r) => r.thanks === null)).toBe(true);
  });

  it('the default list is a valid profile and a fresh copy of it is unfrozen and equal', () => {
    const copy = defaultReporting();
    expect(copy.reasons.map((r) => r.id)).toContain('welfare');
    expect(Object.isFrozen(copy.reasons[0])).toBe(false);
    expect(copy.evidenceUrl).toBeNull();
    expect(() => validateProfile({ ...PRESETS.standard, reporting: copy })).not.toThrow();
  });

  it('welfare is not offered to a player until the owner switches it on; threat stays offered', () => {
    const offered = playerReporting(defaultReporting()).reasons.map((r) => r.id);
    expect(offered).not.toContain('welfare');
    expect(offered).toContain('threat');
  });

  it('welfare files under the legacy category other', () => {
    expect(legacyCategoryOf('welfare')).toBe('other');
  });
});

describe('reason fields in a profile', () => {
  it('a reason left without the new fields reads urgent false, no thanks and showResources false', () => {
    const p = defineProfile(withReasons([{ id: 'zorbak', label: 'Zorbak' }, other]));
    expect(p.reporting.reasons[0]).toMatchObject({ id: 'zorbak', urgent: false, thanks: null, showResources: false });
  });

  it('a reason may be flagged urgent and carry thanks and showResources; they round-trip', () => {
    const p = defineProfile(withReasons([{ id: 'zorbak', label: 'Zorbak', urgent: true, thanks: 'Thanks, we read every one.', showResources: true }, other]));
    expect(p.reporting.reasons[0]).toMatchObject({ urgent: true, thanks: 'Thanks, we read every one.', showResources: true });
    expect(defineProfile(p).reporting.reasons[0]).toEqual(p.reporting.reasons[0]);
  });

  it("a reason's thanks over 300 refused, 300 accepted, blank and non-string refused; null is the unset value", () => {
    expect(() => defineProfile(withReasons([{ id: 'a', label: 'A', thanks: 'x'.repeat(300) }, other]))).not.toThrow();
    expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', thanks: 'x'.repeat(301) }, other]))).path).toBe('profile.reporting.reasons[0].thanks');
    expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', thanks: '  ' }, other]))).path).toBe('profile.reporting.reasons[0].thanks');
    expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', thanks: 4 }, other]))).path).toBe('profile.reporting.reasons[0].thanks');
    expect(defineProfile(withReasons([{ id: 'a', label: 'A', thanks: null }, other])).reporting.reasons[0]?.thanks).toBeNull();
  });

  it.each(['urgent', 'showResources'])('%s must be a boolean', (key) => {
    for (const v of ['yes', 1, null, {}]) {
      expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', [key]: v }, other]))).path, `${key} ${String(v)}`).toBe(`profile.reporting.reasons[0].${key}`);
    }
  });

  it('unknown reason keys are still refused', () => {
    expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', nope: true }, other]))).path).toBe('profile.reporting.reasons[0].nope');
    expect(failure(() => defineProfile(withReasons([{ id: 'a', label: 'A', priority: 1 }, other]))).path).toBe('profile.reporting.reasons[0].priority');
  });

  it('a layer may flag a reason urgent and a code profile may unflag threat', () => {
    const noThreat = resolveProfile('standard', { reporting: { reasons: [{ id: 'threat', label: 'Threats', urgent: false }, other] } });
    expect(noThreat.reporting.reasons[0]?.urgent).toBe(false);
    const layered = applyPolicyLayer(PRESETS.standard, { reporting: { reasons: [{ id: 'spam', label: 'Spam', urgent: true }, other] } });
    expect(layered.reporting.reasons[0]?.urgent).toBe(true);
  });
});

describe('reporting.evidenceUrl', () => {
  const ok = 'https://replay.example.com/match/{ref}?view=chat';
  const profile = (evidenceUrl: unknown): ModerationProfile => ({ ...PRESETS.standard, reporting: { evidenceUrl } }) as unknown as ModerationProfile;

  it('unset is null; a good template is kept as given', () => {
    expect(defineProfile(PRESETS.standard).reporting.evidenceUrl).toBeNull();
    expect(resolveReporting(undefined).evidenceUrl).toBeNull();
    expect(defineProfile(profile(ok)).reporting.evidenceUrl).toBe(ok);
    expect(defineProfile(profile(null)).reporting.evidenceUrl).toBeNull();
  });

  it('a ref in the path, the query or the fragment is accepted', () => {
    for (const u of ['https://a.example/{ref}', 'https://a.example/x?r={ref}', 'https://a.example/x#{ref}', 'https://a.example?r={ref}']) {
      expect(() => defineProfile(profile(u)), u).not.toThrow();
    }
  });

  it.each([
    ['http', 'http://replay.example.com/{ref}'],
    ['two placeholders', 'https://replay.example.com/{ref}/{ref}'],
    ['none', 'https://replay.example.com/match'],
    ['a placeholder in the host', 'https://{ref}.example.com/'],
    ['credentials', 'https://user:pw@replay.example.com/{ref}'],
    ['a space', 'https://replay.example.com/a b/{ref}'],
    ['a javascript url', 'javascript:alert({ref})'],
    ['over 300 characters', `https://replay.example.com/${'a'.repeat(300)}/{ref}`],
    ['empty', ''],
    ['a number', 5],
  ])('%s is refused with the path', (_name, value) => {
    expect(failure(() => defineProfile(profile(value))).path).toBe('profile.reporting.evidenceUrl');
  });

  it('exactly 300 characters is accepted', () => {
    const base = 'https://replay.example.com/';
    const url = `${base}${'a'.repeat(300 - base.length - 5)}{ref}`;
    expect(url).toHaveLength(300);
    expect(() => defineProfile(profile(url))).not.toThrow();
  });

  it('is refused through a layer with the layer path, and never echoes the value', () => {
    const err = failure(() => applyPolicyLayer(PRESETS.standard, { reporting: { evidenceUrl: 'http://zorbak.example/{ref}' } } as PolicyLayer));
    expect(err.path).toBe('layer.reporting.evidenceUrl');
    expect(err.message).not.toContain('zorbak');
  });

  it('a resolved reporting passes validation again', () => {
    const p = defineProfile(profile(ok));
    expect(() => validateProfile(p)).not.toThrow();
  });

  it('fillReporting fills the field for a profile that has reporting without it', () => {
    expect((fillReporting({ flow: 'one_tap' }) as { evidenceUrl: unknown }).evidenceUrl).toBeNull();
  });
});

describe('PlayerReporting', () => {
  const sample = () => {
    const reporting = resolveReporting({
      reasons: [
        { id: 'threat', label: 'Threats', urgent: true, thanks: 'We take threats seriously.' },
        { id: 'welfare', label: 'Trouble', urgent: true, showResources: true, enabled: true, thanks: 'Thank you for telling us.' },
        { id: 'other', label: 'Something else' },
      ],
    });
    const safety = resolveSafety({
      guidance: 'SECRET-GUIDANCE-quissel',
      contact: 'SECRET-CONTACT-vlemmo',
      resources: [{ label: 'Crisis line', detail: 'Any time', url: 'https://help.example.com' }],
    });
    return { reporting, safety };
  };

  it('carries per-reason thanks and showResources and the top-level resources', () => {
    const { reporting, safety } = sample();
    const p = playerReporting(reporting, safety);
    expect(p.reasons.map((r) => [r.id, r.thanks, r.showResources])).toEqual([
      ['threat', 'We take threats seriously.', false],
      ['welfare', 'Thank you for telling us.', true],
      ['other', null, false],
    ]);
    expect(p.resources).toEqual([{ label: 'Crisis line', detail: 'Any time', url: 'https://help.example.com' }]);
  });

  it('never carries safety.guidance, safety.contact, the staff rule mapping, urgent or the evidence template', () => {
    const { reporting, safety } = sample();
    const json = JSON.stringify(playerReporting({ ...reporting, evidenceUrl: 'https://replay.example.com/{ref}' }, safety));
    expect(json).not.toContain('SECRET');
    expect(json).not.toMatch(/guidance|contact|rules|urgent|evidence|enabled/);
  });

  it('without a safety argument resources is an empty list; the resource objects are copies', () => {
    expect(playerReporting(defaultReporting()).resources).toEqual([]);
    const { reporting, safety } = sample();
    const p = playerReporting(reporting, safety);
    expect(p.resources?.[0]).not.toBe(safety.resources[0]);
  });

  it('a disabled reason is not listed', () => {
    const { reporting, safety } = sample();
    const off = { ...reporting, reasons: reporting.reasons.map((r) => (r.id === 'welfare' ? { ...r, enabled: false } : r)) };
    expect(playerReporting(off, safety).reasons.map((r) => r.id)).toEqual(['threat', 'other']);
  });
});

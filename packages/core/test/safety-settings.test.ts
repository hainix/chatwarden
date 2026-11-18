import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFETY_GUIDANCE, resolveSafety } from '../src/safety.js';
import { ProfileError } from '../src/profileError.js';

// The `safety` settings: the guidance a moderator reads, one contact line for staff, and the resources a reporter is shown.

function failure(fn: () => unknown): ProfileError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProfileError);
    return e as ProfileError;
  }
  throw new Error('expected a ProfileError, nothing was thrown');
}
const res = (over: Record<string, unknown> = {}) => ({ label: 'Crisis line', detail: 'Call any time', url: 'https://help.example.com/now', ...over });

describe('resolveSafety', () => {
  it('unset reads the default guidance, no contact and no resources', () => {
    for (const input of [undefined, {}]) {
      expect(resolveSafety(input as never)).toEqual({ guidance: DEFAULT_SAFETY_GUIDANCE, contact: '', resources: [] });
    }
  });

  it('the default guidance is four short paragraphs within the limit, in plain ASCII', () => {
    const paras = DEFAULT_SAFETY_GUIDANCE.split('\n\n');
    expect(paras).toHaveLength(4);
    expect([...DEFAULT_SAFETY_GUIDANCE].length).toBeLessThanOrEqual(1500);
    expect(DEFAULT_SAFETY_GUIDANCE).toMatch(/not asked to judge/i);
    expect(DEFAULT_SAFETY_GUIDANCE).toMatch(/personal account/i);
    expect(DEFAULT_SAFETY_GUIDANCE).toMatch(/minors/i);
    expect(DEFAULT_SAFETY_GUIDANCE).toMatch(/do not save, copy or forward/i);
    expect(DEFAULT_SAFETY_GUIDANCE).not.toMatch(/[^\x20-\x7e\n]/);
  });

  it('guidance is counted in code points: 1500 emoji accepted, 1501 refused', () => {
    expect(resolveSafety({ guidance: '\u{1F600}'.repeat(1500) }).guidance).toBe('\u{1F600}'.repeat(1500));
    expect(failure(() => resolveSafety({ guidance: '\u{1F600}'.repeat(1501) })).path).toBe('safety.guidance');
    expect(failure(() => resolveSafety({ guidance: 'a'.repeat(1501) })).path).toBe('safety.guidance');
    expect(resolveSafety({ guidance: 'a'.repeat(1500) }).guidance).toHaveLength(1500);
  });

  it('control, bidi, zero-width characters and lone surrogates are stripped; blank lines stay as paragraph breaks', () => {
    const raw = 'one\u{202e}\u{200b} two\u{0}\n\nthree\u{d800} \u{2066}four\u{2069}\r\n\r\n\r\n\r\nfive';
    expect(resolveSafety({ guidance: raw }).guidance).toBe('one two\n\nthree four\n\nfive');
  });

  it('a blank or invisible-only guidance reads as unset (the default)', () => {
    for (const g of ['', '   \n  ', '\u{200b}\u{200b}']) expect(resolveSafety({ guidance: g }).guidance, JSON.stringify(g)).toBe(DEFAULT_SAFETY_GUIDANCE);
  });

  it('a non-string guidance, contact or label is refused with its path', () => {
    expect(failure(() => resolveSafety({ guidance: 5 as never })).path).toBe('safety.guidance');
    expect(failure(() => resolveSafety({ contact: {} as never })).path).toBe('safety.contact');
    expect(failure(() => resolveSafety({ resources: [res({ label: 3 })] })).path).toBe('safety.resources[0].label');
  });

  it('contact over 300 characters refused; 300 accepted; one line (newlines become spaces)', () => {
    expect(resolveSafety({ contact: 'c'.repeat(300) }).contact).toHaveLength(300);
    expect(failure(() => resolveSafety({ contact: 'c'.repeat(301) })).path).toBe('safety.contact');
    expect(resolveSafety({ contact: 'Ask Ann\nat the studio\u{200b}' }).contact).toBe('Ask Ann at the studio');
  });

  it('more than 5 resources refused; 5 accepted', () => {
    expect(resolveSafety({ resources: Array.from({ length: 5 }, () => res()) }).resources).toHaveLength(5);
    expect(failure(() => resolveSafety({ resources: Array.from({ length: 6 }, () => res()) })).path).toBe('safety.resources');
    expect(failure(() => resolveSafety({ resources: 'x' as never })).path).toBe('safety.resources');
  });

  it('a label over 60 and a detail over 200 are refused with their path; the edges are accepted; a label is required', () => {
    expect(resolveSafety({ resources: [res({ label: 'l'.repeat(60), detail: 'd'.repeat(200) })] }).resources).toHaveLength(1);
    expect(failure(() => resolveSafety({ resources: [res(), res({ label: 'l'.repeat(61) })] })).path).toBe('safety.resources[1].label');
    expect(failure(() => resolveSafety({ resources: [res({ detail: 'd'.repeat(201) })] })).path).toBe('safety.resources[0].detail');
    expect(failure(() => resolveSafety({ resources: [res({ label: '  ' })] })).path).toBe('safety.resources[0].label');
    expect(failure(() => resolveSafety({ resources: [{ detail: 'x' }] as never })).path).toBe('safety.resources[0].label');
  });

  it('detail and url are optional: detail reads as an empty string and url as null', () => {
    expect(resolveSafety({ resources: [{ label: 'Safety page' }] }).resources).toEqual([{ label: 'Safety page', detail: '', url: null }]);
    expect(resolveSafety({ resources: [{ label: 'Line', url: null }] }).resources[0]?.url).toBeNull();
  });

  it.each([
    ['an http url', 'http://help.example.com/'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a url with credentials', 'https://user:pw@help.example.com/'],
    ['a url with only a user name', 'https://user@help.example.com/'],
    ['a url with a space', 'https://help.example.com/a b'],
    ['a url with a control character', 'https://help.example.com/a\u{1}b'],
    ['a data url', 'data:text/html,hi'],
    ['no scheme', 'help.example.com'],
    ['a scheme with no slashes', 'https:help.example.com'],
    ['no host', 'https:///path'],
    ['a url over 500 characters', `https://help.example.com/${'a'.repeat(500)}`],
    ['an empty string', ''],
  ])('%s is refused with its path', (_name, url) => {
    expect(failure(() => resolveSafety({ resources: [res(), res({ url })] })).path).toBe('safety.resources[1].url');
  });

  it('an https url is kept as given and a resolved result is valid input again', () => {
    const once = resolveSafety({ guidance: 'Pass it on.\n\nThen stop.', contact: 'Ann, extension 5', resources: [res(), { label: 'Chat' }] });
    expect(once.resources[0]?.url).toBe('https://help.example.com/now');
    expect(resolveSafety(once)).toEqual(once);
  });

  it('unknown keys are refused with their path; the safety object and each resource must be plain', () => {
    expect(failure(() => resolveSafety({ nope: 1 } as never)).path).toBe('safety.nope');
    expect(failure(() => resolveSafety({ resources: [res({ nope: 1 })] })).path).toBe('safety.resources[0].nope');
    expect(failure(() => resolveSafety('x' as never)).path).toBe('safety');
    expect(failure(() => resolveSafety({ resources: [null] as never })).path).toBe('safety.resources[0]');
    expect(failure(() => resolveSafety({ contact: 'x'.repeat(400) }, 'layer.safety')).path).toBe('layer.safety.contact');
  });

  it('never echoes a refused value', () => {
    const err = failure(() => resolveSafety({ resources: [res({ url: 'http://zorbak.example/secret' })] }));
    expect(err.message).not.toContain('zorbak');
    expect(failure(() => resolveSafety({ guidance: `quissel ${'x'.repeat(1600)}` })).message).not.toContain('quissel');
  });

  it('the result shares nothing with the input', () => {
    const input = { resources: [res()] };
    const out = resolveSafety(input);
    expect(out.resources[0]).not.toBe(input.resources[0]);
    expect(resolveSafety(input).resources).not.toBe(out.resources);
  });
});

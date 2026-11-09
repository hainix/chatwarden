import { describe, expect, it } from 'vitest';
import { lengthLabel, outcomeLabel, VERSION } from '../src/index.js';

describe('@chatwarden/core smoke', () => {
  it('exports the pre-release version', () => {
    expect(VERSION).toBe('0.0.0');
  });

  it('exports the ladder label helpers the staff hub needs', () => {
    expect(outcomeLabel('none')).toBe('No action');
    expect(outcomeLabel('note')).toBe('Note');
    expect(outcomeLabel('warning')).toBe('Warning');
    expect(outcomeLabel({ kind: 'chat', durationMs: 24 * 3_600_000 })).toBe('Restrict chat 24 hours');
    expect(outcomeLabel({ kind: 'ban', durationMs: null })).toBe('Full ban permanent');
    expect(lengthLabel(null)).toBe('permanent');
    expect(lengthLabel(7 * 24 * 3_600_000)).toBe('7 days');
  });
});

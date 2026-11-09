import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';

describe('@chatwarden/core smoke', () => {
  it('exports the pre-release version', () => {
    expect(VERSION).toBe('0.0.0');
  });
});

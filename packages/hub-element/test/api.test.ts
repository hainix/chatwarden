import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';
import * as standalone from '../src/standalone.js';

// The public API is locked: every export name of each entry point, so a change is a deliberate one (and the changeset says
// which way). Adding a name means updating the list below on purpose.

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'packages', 'hub-element', 'package.json'), 'utf8')) as {
  version: string;
  exports: Record<string, { types: string; default: string }>;
};

describe('the public API', () => {
  it('the module exports exactly these names', () => {
    expect(Object.keys(entry).sort()).toEqual(['ChatwardenHubElement', 'DEFAULT_TAG', 'VERSION', 'defineChatwardenHub']);
  });

  it('the self-registering bundle exports the same names', () => {
    expect(Object.keys(standalone).sort()).toEqual(Object.keys(entry).sort());
  });

  it('the default tag name is chatwarden-hub', () => {
    expect(entry.DEFAULT_TAG).toBe('chatwarden-hub');
  });

  it('VERSION is the package version', () => {
    expect(entry.VERSION).toBe(manifest.version);
  });

  it('the manifest points . at the module and ./standalone at the self-registering bundle, each with types', () => {
    expect(manifest.exports['.']).toEqual({ types: './dist/src/index.d.ts', default: './dist/index.js' });
    expect(manifest.exports['./standalone']).toEqual({ types: './dist/src/standalone.d.ts', default: './dist/hub-element.js' });
  });
});

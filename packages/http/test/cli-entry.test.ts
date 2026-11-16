import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import * as entry from '@chatwarden/http/cli';

// `@chatwarden/http/cli` is the subpath a `create-chatwarden` shim would import. Tests resolve it to the source, like the other subpaths.
describe('@chatwarden/http/cli', () => {
  it('resolves to the CLI entry and exports runCli (and nothing from the package root)', () => {
    expect(entry.runCli).toBe(runCli);
    expect(Object.keys(entry).sort()).toEqual(['runCli']);
  });
});

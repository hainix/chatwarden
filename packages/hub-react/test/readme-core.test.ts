// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The README says what the hub takes from @chatwarden/core at run time. That list is read from the source, so the sentence cannot go stale.

const pkg = join(process.cwd(), 'packages', 'hub-react');
const readme = readFileSync(join(pkg, 'README.md'), 'utf8').replace(/\s+/g, ' ');

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });

/** Every value (not type) the hub's source imports from @chatwarden/core. */
function runtimeCoreImports(): string[] {
  const found = new Set<string>();
  for (const file of sources(join(pkg, 'src'))) {
    for (const m of readFileSync(file, 'utf8').matchAll(/import\s*\{([^}]*)\}\s*from\s*'@chatwarden\/core'/g)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = part.trim();
        if (name !== '' && !name.startsWith('type ')) found.add(name.split(/\s+as\s+/)[0] as string);
      }
    }
  }
  return [...found].sort();
}

describe('the README sentence about what the hub imports from core', () => {
  const values = runtimeCoreImports();

  it('finds the values the source imports (a control: the scan sees the ones the review named)', () => {
    expect(values).toEqual(
      expect.arrayContaining(['LADDER_TABLE', 'DEFAULT_DURATIONS', 'DEFAULT_AREA_RULES', 'DEFAULT_SEVERE_RULES', 'AUDIT_ACTIONS', 'MAX_REASON_RULES', 'MAX_REPORT_REASONS', 'OTHER_REASON_ID', 'defaultReporting', 'LEGACY_REASON_ALIASES']),
    );
  });

  it('no longer claims that it imports a single value from core', () => {
    expect(readme).not.toMatch(/one value from core/);
  });

  it.each(values)('names %s', (name) => {
    expect(readme).toContain('`' + name + '`');
  });

  it('says they are constants and defaults, and that the hub imports types from core as well', () => {
    expect(readme).toMatch(/imports types from both, and these values from core/);
  });

  it('headless: says no React, and says plainly that the browser timer and page helpers use document and window, optional and injectable', () => {
    const headless = readme.slice(readme.indexOf('## Headless (any framework)'));
    expect(headless).toMatch(/with no React/);
    expect(headless).not.toMatch(/no React and no DOM/);
    expect(headless).toMatch(/`browserTimers` and `browserPage`/);
    expect(headless).toMatch(/use `document` and `window` when they run/);
    expect(headless).toMatch(/optional/);
    expect(headless).toMatch(/`schedule` and `page`/);
    expect(headless).toMatch(/type declarations need no DOM lib/);
  });

  it('says what the Overview and All actions cost in audited reads: GET /sanctions is history.view, read on open and on a user action only', () => {
    expect(readme).toMatch(/What the Overview and All actions cost in audited reads/);
    expect(readme).toMatch(/Recent actions is read once when the Overview opens/);
    expect(readme).toMatch(/not again by itself/);
    expect(readme).toMatch(/`history.view` row with no target/);
  });
});

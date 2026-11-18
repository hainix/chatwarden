import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 0.2.0 settles the API: the `@experimental` tag is gone from every public name added through 0.1.x and 0.2.0, except where the behavior has
// never run against the real thing (the three outside integrations). Each file below keeps its tags, for the reason written next to it. A new tag anywhere else fails this test,
// and a file that no longer carries one must leave the list.

const root = fileURLToPath(new URL('..', import.meta.url));

const STILL_UNSTABLE: Record<string, string> = {
  // The three outside integrations were written from the vendors' documents and have never run against the live services.
  'packages/http/src/coop/index.ts': 'the Coop adapter: written from the docs, never run against a live Coop',
  'packages/http/src/coop/options.ts': 'the Coop adapter options',
  'packages/http/src/eos/index.ts': 'the EOS adapter: written from the docs, never run against live EOS',
  'packages/discord/src/feed.ts': 'the `components` buttons of the feed: they only work with the Discord bot, which has never run against a live guild',
  'packages/http/src/discord/bot.ts': 'the Discord bot: written from the docs, never run against a live guild',
  'packages/http/src/discord/options.ts': 'the Discord bot options',
  'packages/http/src/discord/types.ts': 'the Discord bot types',
  'packages/http/src/discord/verify.ts': 'the Discord interaction signature check',
  'packages/http/src/eos/options.ts': 'the EOS adapter options',
  'packages/http/src/discord/register.ts': 'the Discord bot commands: written from the docs, never run against a live guild',
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const sources = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => walk(join(root, 'packages', d.name, 'src')));
const rel = (p: string): string => relative(root, p).split(String.fromCharCode(92)).join('/');
const tagged = sources.filter((p) => readFileSync(p, 'utf8').includes('@experimental')).map(rel).sort();

describe('@experimental is settled at 0.2.0', () => {
  it('no package source carries the tag except the files that name a reason', () => {
    expect(tagged.filter((p) => !(p in STILL_UNSTABLE))).toEqual([]);
  });

  it('every file on the list still carries the tag (the list does not rot)', () => {
    expect(Object.keys(STILL_UNSTABLE).filter((p) => !tagged.includes(p))).toEqual([]);
  });

  it('the list is short and every entry has a reason', () => {
    expect(Object.keys(STILL_UNSTABLE).length).toBeLessThanOrEqual(10);
    for (const reason of Object.values(STILL_UNSTABLE)) expect(reason.length).toBeGreaterThan(10);
  });

  it('control: the scan sees the source tree', () => {
    expect(sources.length).toBeGreaterThan(300);
    expect(sources.map(rel)).toContain('packages/core/src/chatwarden.ts');
  });
});

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTestKit, expectOutcomes } from '../packages/store-memory/src/testing/index.js';
import { OPTIONS } from '../packages/http/src/cli/args.js';

// The skill-only Claude Code plugin (design 12): one skill that tells a coding agent how to add Chatwarden to a game server with `chatwarden init`.
// Layout confirmed against the Claude Code plugin docs (2026-11-16): `.claude-plugin/plugin.json` in the plugin folder, `skills/<name>/SKILL.md` with
// `name` and `description` front matter, and a repository-root `.claude-plugin/marketplace.json` whose plugin entry has a relative `source`.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');
const skill = read('agent', 'claude-plugin', 'skills', 'add-chatwarden', 'SKILL.md');

/** The front matter of a SKILL.md as key/value pairs (single-line values only: that is all the skill uses). */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  expect(m, 'front matter').not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of (m?.[1] as string).split('\n')) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1] as string] = (kv[2] as string).replace(/^["']|["']$/g, '');
  }
  return out;
}

describe('the agent skill plugin', () => {
  it('the JSON files parse and name the plugin and its relative source', () => {
    const marketplace = JSON.parse(read('.claude-plugin', 'marketplace.json')) as { name: string; owner: { name: string }; plugins: Array<{ name: string; source: string; description?: string }> };
    const plugin = JSON.parse(read('agent', 'claude-plugin', '.claude-plugin', 'plugin.json')) as { name: string; description?: string; version?: string };
    expect(marketplace.name).toBe('chatwarden-plugins');
    expect(typeof marketplace.owner.name).toBe('string');
    expect(marketplace.plugins).toHaveLength(1);
    const entry = marketplace.plugins[0] as { name: string; source: string };
    // The entry name equals the manifest name (the docs say a mismatch breaks install by name), and the source is a path from the repository root.
    expect(entry.name).toBe(plugin.name);
    expect(plugin.name).toBe('chatwarden');
    expect(entry.source).toBe('./agent/claude-plugin');
    expect(existsSync(join(root, entry.source, '.claude-plugin', 'plugin.json'))).toBe(true);
    expect(entry.source.includes('..')).toBe(false);
    expect(plugin.description?.length ?? 0).toBeGreaterThan(20);
  });

  it("the skill's front matter has a name and a description under 200 characters", () => {
    const fm = frontMatter(skill);
    expect(fm.name).toBe('add-chatwarden');
    expect(fm.description?.length ?? 0).toBeGreaterThan(40);
    expect(fm.description?.length ?? 999).toBeLessThan(200);
    expect(skill.split('\n').length).toBeLessThanOrEqual(80);
    expect(skill.split('\n').length).toBeGreaterThanOrEqual(40);
  });

  it('control: front matter without a name is found', () => {
    expect(frontMatter('---\ndescription: x\n---\nbody\n').name).toBeUndefined();
  });

  it('every --flag the skill mentions is in OPTIONS and every value it mentions is allowed for that flag', () => {
    const known = new Map(OPTIONS.map((o) => [`--${o.name}`, o]));
    known.set('--no-discord', OPTIONS.find((o) => o.name === 'discord') as (typeof OPTIONS)[number]);
    const spans = [...skill.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    const blocks = [...skill.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => (m[1] as string).split('\n'));
    let checked = 0;
    for (const text of [...spans, ...blocks]) {
      const tokens = text.replace(/#.*$/, '').trim().split(/\s+/);
      // `node --env-file=.env` is a flag of node, not of init.
      if (tokens[0] === 'node') return;
      tokens.forEach((token, i) => {
        if (!token.startsWith('--')) return;
        const flag = token.replace(/=.*$/, '');
        const option = known.get(flag);
        expect(option, `${flag} is a flag of chatwarden init`).toBeDefined();
        checked += 1;
        const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : tokens[i + 1];
        if (option?.type === 'string' && option.values !== undefined && value !== undefined && !value.startsWith('<') && !value.startsWith('-')) {
          expect(option.values.includes(value), `${flag} ${value}: one of ${option.values.join(', ')}`).toBe(true);
        }
      });
    }
    expect(checked).toBeGreaterThan(8);
  });

  it('control: a flag or a value that does not exist is caught by the same rule', () => {
    const known = new Set(OPTIONS.map((o) => `--${o.name}`));
    expect(known.has('--framwork')).toBe(false);
    expect(OPTIONS.find((o) => o.name === 'framework')?.values?.includes('koa')).toBe(false);
  });

  it('the skill mentions --json, --check and --dry-run, and the three-step order: init, edit the one line, check', () => {
    for (const flag of ['--json', '--check', '--dry-run', '--yes']) expect(skill, flag).toContain(flag);
    const init = skill.indexOf('init --yes');
    const check = skill.indexOf('init --check');
    expect(init).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(init);
  });

  it('tells the agent what to choose from what it finds, not to edit kit.ts secrets, to write a test with the test kit, and about the starter markers', () => {
    const text = skill.replace(/\s+/g, ' ');
    for (const needle of ['package.json', 'express', 'fastify', 'next', 'socket.io', 'TODO(auth)', 'TODO(identity)', 'TODO(terms)', '@chatwarden/store-memory/testing', 'createTestKit', 'CHATWARDEN_SECRET', 'CHATWARDEN_ADMIN_TOKEN', 'never']) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toMatch(/never (put|write|paste)[^.]*secret[^.]*kit\.ts|kit\.ts[^.]*never[^.]*secret/i);
  });

  it('names no real term and no secret: the words are invented and no long random value appears', () => {
    expect(skill).not.toMatch(/[0-9a-f]{32,}/i);
    expect(skill).not.toMatch(/[A-Za-z0-9+/_-]{40,}/);
    expect(skill).not.toMatch(/\b(sk-|ghp_|xox[bp]-|AKIA)[A-Za-z0-9]/);
    for (const line of skill.split('\n')) {
      for (const m of line.matchAll(/blocked: \[([^\]]*)\]|swears: \[([^\]]*)\]/g)) {
        for (const word of (m[1] ?? m[2] ?? '').split(',').map((w) => w.replace(/['"\s]/g, '')).filter(Boolean)) {
          expect(['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn']).toContain(word);
        }
      }
    }
    expect(skill).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
  });

  it('the test example in the skill runs, and fails when what it expects is wrong', async () => {
    const block = /```ts\n([\s\S]*?)```/.exec(skill)?.[1] as string;
    expect(block.startsWith("import { createTestKit, expectOutcomes } from '@chatwarden/store-memory/testing';")).toBe(true);
    const body = block.split('\n').slice(1).join('\n');
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<unknown>;
    await expect(new AsyncFunction('createTestKit', 'expectOutcomes', body)(createTestKit, expectOutcomes)).resolves.toBeUndefined();
    const wrong = body.replace("expect: 'refused:blocked'", "expect: 'delivered'");
    expect(wrong).not.toBe(body);
    await expect(new AsyncFunction('createTestKit', 'expectOutcomes', wrong)(createTestKit, expectOutcomes)).rejects.toThrow();
  });

  it('the plugin directory is not in any package files list (it never ships to npm)', () => {
    for (const dir of readdirSync(join(root, 'packages'), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const manifest = JSON.parse(read('packages', dir.name, 'package.json')) as { files?: string[] };
      for (const entry of manifest.files ?? []) {
        expect(entry.startsWith('agent') || entry.startsWith('..') || entry.includes('claude-plugin'), `${dir.name}: ${entry}`).toBe(false);
      }
    }
    // And nothing in the repository root files list can pull it in either: the root manifest is private.
    const rootManifest = JSON.parse(read('package.json')) as { private?: boolean; files?: string[] };
    expect(rootManifest.private).toBe(true);
    expect(rootManifest.files).toBeUndefined();
  });

  it('the skill and its manifests use LF line endings', () => {
    for (const text of [skill, read('.claude-plugin', 'marketplace.json'), read('agent', 'claude-plugin', '.claude-plugin', 'plugin.json')]) {
      expect(readFileSync(join(root, 'agent', 'claude-plugin', 'skills', 'add-chatwarden', 'SKILL.md'), 'utf8').includes('\r')).toBe(false);
      expect(text.includes('\r')).toBe(false);
    }
  });
});

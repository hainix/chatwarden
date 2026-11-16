import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The unscoped npm package `chatwarden` does not exist: `npx chatwarden init` in a project with nothing installed fails (or, worse, runs whatever
// a stranger publishes under that name). The command is right only after `@chatwarden/http` is installed, or as `npx -p @chatwarden/http chatwarden init`.
// So in the adopter-facing docs a bare `npx chatwarden ...` must follow an install line in the same fenced block, or in the same line of prose.
// `init --check` is exempt: it only makes sense on a project init has already written, which has the package installed.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (path: string): string => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');

const INSTALL = /\b(?:npm (?:install|i)|pnpm add|yarn add|bun add)\b[^\n]*@chatwarden\/http/;
const BARE = /npx chatwarden\b/g;

/** Every bare `npx chatwarden` in `text` that follows no install line in its own block (fenced code) or its own line (prose), as `line: text`. */
export function bareProblems(text: string): string[] {
  const problems: string[] = [];
  const lines = text.split('\n');
  let fence: number | undefined;
  lines.forEach((line, index) => {
    if (/^\s*```/.test(line)) {
      fence = fence === undefined ? index : undefined;
      return;
    }
    const unit = fence === undefined ? line : lines.slice(fence + 1, index + 1).join('\n');
    for (const match of line.matchAll(BARE)) {
      if (/^npx chatwarden init\b[^\n`]*--check\b/.test(line.slice(match.index))) continue;
      const before = fence === undefined ? line.slice(0, match.index) : unit.slice(0, unit.length - line.length + match.index);
      if (!INSTALL.test(before)) problems.push(`${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  });
  return problems;
}

function adopterDocs(): string[] {
  const out = ['README.md', 'docs/status.md', 'agent/claude-plugin/skills/add-chatwarden/SKILL.md'];
  for (const name of readdirSync(join(root, 'docs/recipes'))) if (name.endsWith('.md')) out.push(`docs/recipes/${name}`);
  for (const d of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (d.isDirectory() && existsSync(join(root, 'packages', d.name, 'README.md'))) out.push(`packages/${d.name}/README.md`);
  }
  return out;
}

describe('npx chatwarden in the adopter docs', () => {
  it('finds the docs it should check', () => {
    const docs = adopterDocs();
    expect(docs.length).toBeGreaterThan(15);
    expect(docs).toContain('docs/recipes/express.md');
    expect(docs).toContain('packages/http/README.md');
  });

  it.each(adopterDocs())('%s: no bare `npx chatwarden` without an install before it', (path) => {
    expect(bareProblems(read(path)), path).toEqual([]);
  });

  it('the recipes and the http README put an install line before init in their first shell block', () => {
    for (const path of ['express', 'fastify', 'nextjs', 'socketio', 'colyseus'].map((n) => `docs/recipes/${n}.md`).concat('packages/http/README.md')) {
      const doc = read(path);
      const block = /```sh\n(?:(?!```)[\s\S])*?npx chatwarden init[\s\S]*?```/.exec(doc)?.[0] ?? '';
      expect(block, path).toMatch(INSTALL);
      expect(block.indexOf('npm install'), path).toBeLessThan(block.indexOf('npx chatwarden init'));
    }
  });

  describe('the rule itself (controls)', () => {
    it('flags a bare command in a block, in a list item and in a sentence', () => {
      expect(bareProblems('```sh\nnpx chatwarden init\n```\n')).toHaveLength(1);
      expect(bareProblems('- a command (`npx chatwarden init`) that writes it\n')).toHaveLength(1);
      expect(bareProblems('Run `npx chatwarden init --framework next` first.\n')).toHaveLength(1);
      expect(bareProblems('```sh\nnpx chatwarden init\nnpm install @chatwarden/http\n```\n')).toHaveLength(1);
    });
    it('accepts an install first in the same block or line, the -p form and --check', () => {
      expect(bareProblems('```sh\nnpm install @chatwarden/http @chatwarden/core\nnpx chatwarden init --framework express\n```\n')).toEqual([]);
      expect(bareProblems('After `npm install @chatwarden/http`, run `npx chatwarden init`.\n')).toEqual([]);
      expect(bareProblems('```sh\nnpx -p @chatwarden/http chatwarden init\n```\n')).toEqual([]);
      expect(bareProblems('Run `npx chatwarden init --check` to list what is left.\n')).toEqual([]);
    });
    it('an install in an earlier block does not count', () => {
      expect(bareProblems('```sh\nnpm install @chatwarden/http\n```\n\n```sh\nnpx chatwarden init\n```\n')).toHaveLength(1);
    });
  });
});

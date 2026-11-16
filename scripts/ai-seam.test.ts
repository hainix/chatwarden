import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Design 6.1, the third leg of the seam: only packages/core/src/aiActor (built in the acting release) may write a sanction with `source: 'ai'`.
// The literal `source: 'ai'` and the literal `automated: true` must not appear anywhere else under packages/*/src. This is a plain text scan, so a
// new writer cannot slip in beside the actor without a person editing this file on purpose.
//
// `automated: true` is also written, today, by two places that are not the AI and are named here with their count: the chat filter's automatic
// timeout (source auto_filter) and the EOS bridge's queued apply. A third site, or a second one in either file, fails the test.

const root = fileURLToPath(new URL('..', import.meta.url));
const ACTOR_DIR = 'packages/core/src/aiActor/';
const AUTOMATED_TODAY: Readonly<Record<string, number>> = {
  'packages/core/src/chat.ts': 1,
  'packages/http/src/eos/sanctions.ts': 1,
};
const SOURCE_AI = /\bsource\s*:\s*['"`]ai['"`]/g;
const AUTOMATED_TRUE = /\bautomated\s*:\s*true\b/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Every `packages/<name>/src` file under `base`, as a posix path relative to it. */
function sources(base: string): string[] {
  const files: string[] = [];
  const pkgs = join(base, 'packages');
  for (const pkg of readdirSync(pkgs, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(pkgs, pkg.name, 'src');
    try {
      walk(src, files);
    } catch {
      // a package without a src folder
    }
  }
  return files.map((f) => relative(base, f).split(sep).join('/')).sort();
}

interface Found {
  sourceAi: string[];
  automated: Record<string, number>;
}

/**
 * The text with its comments blanked out, string and template literals respected (a `//` inside a string is not a comment). A comment is prose; a line that merely
 * STARTS like one is not (`/* x *\/ const a = { source: 'ai' };`, or a `*` that continues an expression), so the scan strips comments over the whole text, not by line prefix.
 */
export function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
    } else if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      out += ' ';
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      // A ' or " string ends at the line's end, so a regex literal holding a quote cannot swallow the code after it.
      while (j < text.length && text[j] !== c && (c === '`' || text[j] !== '\n')) j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

function scan(base: string): Found {
  const found: Found = { sourceAi: [], automated: {} };
  for (const file of sources(base)) {
    if (file.startsWith(ACTOR_DIR)) continue;
    // Comments are prose (strikes.ts names `automated: true` in one); code is what writes a row.
    const text = stripComments(readFileSync(join(base, file), 'utf8'));
    const ai = text.match(SOURCE_AI)?.length ?? 0;
    if (ai > 0) found.sourceAi.push(`${file} (${ai})`);
    const auto = text.match(AUTOMATED_TRUE)?.length ?? 0;
    if (auto > 0) found.automated[file] = auto;
  }
  return found;
}

describe("source 'ai' and automated true for a sanction appear only under core/src/aiActor", () => {
  it("no file under packages/*/src outside aiActor holds the literal source: 'ai'", () => {
    expect(scan(root).sourceAi).toEqual([]);
  });

  it('automated: true appears only in the two places that are not the AI, once each, and under aiActor', () => {
    expect(scan(root).automated).toEqual(AUTOMATED_TODAY);
  });

  it('the scan can fail: a temporary file with either literal is found, in any package, and the actor folder is exempt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ai-seam-'));
    try {
      const put = (rel: string, text: string): void => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), text);
      };
      put('packages/core/src/ok.ts', "export const a = { source: 'moderator', automated: false };\n");
      expect(scan(dir)).toEqual({ sourceAi: [], automated: {} });

      put('packages/core/src/leak.ts', "export const a = { source: 'ai' };\n");
      put('packages/http/src/deep/leak2.tsx', 'export const a = { source:"ai", automated:true };\n');
      put('packages/store-memory/src/leak3.ts', 'export const a = { source: `ai` };\n');
      put('packages/core/src/aiActor/write.ts', "export const a = { source: 'ai', automated: true };\n");
      const found = scan(dir);
      expect(found.sourceAi.sort()).toEqual(['packages/core/src/leak.ts (1)', 'packages/http/src/deep/leak2.tsx (1)', 'packages/store-memory/src/leak3.ts (1)']);
      expect(found.automated).toEqual({ 'packages/http/src/deep/leak2.tsx': 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a comment never hides code: a one-line block comment before the literal, a trailing comment, a // inside a string', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ai-seam-'));
    try {
      const put = (rel: string, text: string): void => {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), text);
      };
      put('packages/core/src/a.ts', "/* note */ export const a = { source: 'ai' };\n");
      put('packages/core/src/b.ts', "export const u = 'http://x.example'; export const a = { source: 'ai' };\n");
      put('packages/core/src/c.ts', "export const a = { source: 'ai' }; // trailing\n");
      put('packages/core/src/d.ts', 'export const a = 1 /* x */ + 2; const b = { automated: true }; /* y */\n');
      put('packages/core/src/e.ts', "export const a = {\n  /* c */ source: 'ai',\n};\n");
      put('packages/core/src/f.ts', "export const re = /['\"]/;\nexport const a = { source: 'ai' };\n");
      const found = scan(dir);
      expect(found.sourceAi.sort()).toEqual(['packages/core/src/a.ts (1)', 'packages/core/src/b.ts (1)', 'packages/core/src/c.ts (1)', 'packages/core/src/e.ts (1)', 'packages/core/src/f.ts (1)']);
      expect(found.automated).toEqual({ 'packages/core/src/d.ts': 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prose in a comment is not code: a line comment, a block comment over several lines, a doc comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ai-seam-'));
    try {
      mkdirSync(join(dir, 'packages/core/src'), { recursive: true });
      writeFileSync(
        join(dir, 'packages/core/src/p.ts'),
        "// a sanction with source: 'ai' and automated: true is the actor's\n/*\n * { source: 'ai', automated: true }\n */\n/** `source: 'ai'` */\nexport const a = 1;\n",
      );
      expect(scan(dir)).toEqual({ sourceAi: [], automated: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a look-alike folder is not the actor folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ai-seam-'));
    try {
      for (const rel of ['packages/core/src/aiActors/x.ts', 'packages/core/src/aiActor.ts', 'packages/core/src/ai/actor.ts', 'packages/core/src/x/aiActor/y.ts']) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), "export const a = { source: 'ai' };\n");
      }
      expect(scan(dir).sourceAi).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('test and dist folders are not scanned (a test may name the literal)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-ai-seam-'));
    try {
      for (const rel of ['packages/core/test/x.ts', 'packages/core/dist/x.js']) {
        mkdirSync(join(dir, rel, '..'), { recursive: true });
        writeFileSync(join(dir, rel), "export const a = { source: 'ai', automated: true };\n");
      }
      expect(scan(dir)).toEqual({ sourceAi: [], automated: {} });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

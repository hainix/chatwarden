import { dirname, join, parse, relative, resolve, sep } from 'node:path';
import { ToolError } from './errors.js';
import type { ToolIo } from './io.js';

// Where the tools may write the real list (design 16: it never touches git). A release folder holds the whole corpus (the zip is encrypted only with
// the public password), so the tools write outside every git tree by default, and refuse a path inside one unless it is in a folder `.gitignore`
// covers: `release-out/` or `.corpus-data/` at the top of the repository (scripts/no-corpus-data.mjs also fails if a file there is ever tracked).

const IGNORED_TOP = ['release-out', '.corpus-data'];

/** The default output folder: in the home directory, outside any repository. */
export function defaultOutDir(io: Pick<ToolIo, 'home'>): string {
  return join(io.home, 'chatwarden-release-out');
}

/** The top of the git working tree `path` is in (a `.git` folder or file in it or any folder above), or null. */
function gitRootOf(path: string, io: Pick<ToolIo, 'exists'>): string | null {
  let dir = resolve(path);
  for (;;) {
    if (io.exists(resolve(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir || dir === parse(dir).root) return null;
    dir = up;
  }
}

/** Throws a ToolError unless `path` is outside every git tree or inside a git-ignored top folder of one. */
export function guardOutDir(path: string, io: Pick<ToolIo, 'exists'>): void {
  const root = gitRootOf(path, io);
  if (root === null) return;
  const first = relative(root, resolve(path)).split(sep)[0];
  if (first !== undefined && IGNORED_TOP.includes(first)) return;
  throw new ToolError('in_git_tree', 'refusing to write the real list inside a git working tree: choose a folder outside every repository (or release-out/ or .corpus-data/ at the top of one, which git ignores)');
}

// The recipe cases: the answers `chatwarden init` is run with, and the folder under `cases/` that holds what it writes (the goldens).
// The goldens are the single source of recipe code (design ruling 8): `golden.test.ts` renders each case and compares it byte for byte,
// `typecheck.test.ts` compiles them, and the framework tests run them. The `colyseus` folder is hand-written and is not in this table.
import { fileURLToPath } from 'node:url';
import { VERSION } from '../../packages/http/src/index.js';
import { buildPlan } from '../../packages/http/src/cli/plan.js';
import { renderAll } from '../../packages/http/src/cli/templates/index.js';
import type { Answers, FileSpec } from '../../packages/http/src/cli/types.js';

export interface RecipeCase {
  name: string;
  answers: Answers;
  /** Which tsconfig compiles it: NodeNext, or bundler resolution with JSX (what a Next.js project uses). A JavaScript case is checked with `node --check`. */
  check: 'nodenext' | 'bundler' | 'js';
}

const BASE: Answers = {
  framework: 'express',
  store: 'sqlite',
  chat: 'none',
  chatTransport: 'sse',
  hub: 'none',
  discord: false,
  profile: 'standard',
  base: '/chatwarden',
  dir: 'chatwarden',
  lang: 'ts',
};

const answers = (over: Partial<Answers>): Answers => ({ ...BASE, ...over });

export const CASES: RecipeCase[] = [
  { name: 'express-sqlite-box-element', check: 'nodenext', answers: answers({ chat: 'box', hub: 'element' }) },
  { name: 'express-memory-minimal', check: 'nodenext', answers: answers({ store: 'memory' }) },
  { name: 'express-discord-js', check: 'js', answers: answers({ hub: 'element', discord: true, lang: 'js' }) },
  { name: 'none-library', check: 'nodenext', answers: answers({ framework: 'none' }) },
];

export const CASES_DIR = fileURLToPath(new URL('./cases/', import.meta.url));
export const RECIPES_DIR = fileURLToPath(new URL('./', import.meta.url));

/** Folders under `cases/` that are written by hand, not generated. */
export const HAND_WRITTEN = ['colyseus'];

/** What the CLI writes for a case: the plan's files (CRLF folded, sorted by path), exactly as `chatwarden init` applies them. */
export function renderCase(recipe: RecipeCase): FileSpec[] {
  const versions = { chatwarden: VERSION };
  return buildPlan(recipe.answers, versions, (a, v) => renderAll(a, v, { moduleType: 'module' }), { manager: 'npm', react: true }).files;
}

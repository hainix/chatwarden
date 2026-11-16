// `renderAll`: every file init writes for a set of answers. The shared files (the kit, the starter hooks, the term list, the env example) are
// here; the framework files (Express, Fastify, Next, the Web handler, the hub, the chat box, Socket.IO) are added by the tasks that own them
// as one more entry in FRAMEWORK. A template is a function of a Ctx and returns text: no clock, no randomness, nothing read from the machine.
import type { Answers, FileSpec, Versions } from '../types.js';
import { authFiles } from './auth.js';
import { envExampleFiles } from './envExample.js';
import { makeCtx } from './frag.js';
import type { Ctx, CtxOptions } from './frag.js';
import { kitFiles } from './kit.js';
import { termsFiles } from './terms.js';

export { MARKERS } from './header.js';
export type { Ctx, CtxOptions } from './frag.js';

type Render = (ctx: Ctx) => FileSpec[];

const SHARED: Render[] = [kitFiles, authFiles, termsFiles, envExampleFiles];

/** Filled in by the framework tasks (5 and 6): each entry returns the files for the answers it applies to, and none for the others. */
const FRAMEWORK: Render[] = [];

/**
 * Every file for these answers, `answers.dir`-relative paths already joined to the folder (a file outside it, such as Next's route, carries its
 * own path). `options.moduleType` is the project's `"type"`: JavaScript in a CommonJS project is written as `.mjs`.
 */
export function renderAll(answers: Answers, versions: Versions, options: CtxOptions = {}): FileSpec[] {
  const ctx = makeCtx(answers, versions, options);
  return [...SHARED, ...FRAMEWORK].flatMap((render) => render(ctx));
}

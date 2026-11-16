// The Next.js files outside the folder init writes to (design 6.1, 9.3): the catch-all route handler and, with the React hub, the hub page. Each is new,
// small and only hands over to a file under `--dir`.
import { nextAppRoot } from '../plan.js';
import type { FileSpec } from '../types.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

/** The specifier that reaches `toFile` (a path without extension) from the folder `fromDir`, both relative to the project root. */
function relativeSpecifier(fromDir: string, toFile: string): string {
  const from = fromDir.split('/');
  const to = toFile.split('/');
  let shared = 0;
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  const up = from.length - shared;
  return [...Array.from({ length: up }, () => '..'), ...to.slice(shared)].join('/');
}

export function nextFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.framework !== 'next') return [];
  // A base of /chatwarden is the folder app/chatwarden; /game/mod is app/game/mod.
  const root = `${nextAppRoot(answers)}${answers.base}`;
  const routeDir = `${root}/[...path]`;

  const route = `${header(ctx, 'The Next.js route handler: every request under the prefix goes to the Chatwarden handler.')}import { handler } from '${relativeSpecifier(routeDir, `${answers.dir}/handler`)}';

// The kit keeps a database file and open chat streams, so this runs on Node and is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;
`;
  const files: FileSpec[] = [{ path: `${routeDir}/route${ctx.scriptExt}`, content: route }];

  if (answers.hub === 'react') {
    const pageDir = `${root}/mod`;
    const page = `${header(ctx, 'The moderator hub page, a client component.')}export { default } from '${relativeSpecifier(pageDir, `${answers.dir}/HubPage`)}';
`;
    files.push({ path: `${pageDir}/page${ctx.jsxExt}`, content: page });
  }
  return files;
}

// `handler.ts` (design 6.1, 8, 9.3): the kit behind `toFetch`, for Next.js route handlers and for anything on Web Request and Response (Hono, Bun, Deno,
// SvelteKit, Remix). It builds the kit once for the process, cached on globalThis, so a dev server that reloads the module does not open the database twice.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

/** The table of route families `toFetch` takes, one entry per line, `indent` deep. Shared by the Web handler and the Fastify bridge. */
export function mountsText(box: boolean, indent: string): string {
  const lines = [
    "'/admin': adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }),",
    "'/api': playerRoutes(kit.cw, { identify: kit.hooks.identify }),",
    ...(box ? ["'/chat': chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }),"] : []),
    "'': healthRoutes(kit.cw),",
  ];
  return lines.map((line) => `${indent}${line}
`).join('');
}

export function fetchHandlerFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.framework !== 'next' && answers.framework !== 'fetch') return [];
  const next = answers.framework === 'next';
  const box = answers.chat === 'box';
  const hub = answers.hub === 'element';

  const routes = ['adminRoutes', ...(box ? ['chatRoutes'] : []), 'healthRoutes', 'playerRoutes'];
  const imports =
    imp(ctx, routes, '@chatwarden/http') +
    imp(ctx, 'toFetch', '@chatwarden/http/fetch') +
    imp(ctx, 'createKit', './kit') +
    impType(ctx, 'Kit', './kit') +
    (hub ? imp(ctx, 'hubHandler', './hub') : '');

  // Next owns every path under the prefix (its route file is a catch-all), so the kit answers them all; a plain fetch host owns the rest of the URL
  // space, so a path the kit does not know is handed back to it as null.
  const result = next ? 'Response' : 'Response | null';
  const options = next ? '{ prefix: kit.base }' : "{ prefix: kit.base, unmatched: 'pass' }";
  const hubLine = hub ? '  const hub = hubHandler(kit);\n' : '';
  const answer = hub ? '(request) => hub(request).then((response) => response ?? handle(request))' : 'handle';

  const content = `${header(ctx, next ? 'The Next.js route handler: the kit behind toFetch, built once for the process.' : 'The Web fetch handler: the kit behind toFetch, built once for the process.')}${imports}
${t(
  ctx,
  `/** What the process holds: the kit, and the function that answers a request (null: not a Chatwarden path, the host answers it). */
interface Ready {
  kit: Kit;
  answer: (request: Request) => Promise<${result}>;
}

`,
)}// Cached on globalThis: a dev server that reloads this module must not open the database a second time.
const SLOT = Symbol.for('chatwarden.ready');
const shared = globalThis${t(ctx, ' as unknown as Record<symbol, Promise<Ready> | undefined>')};

async function build()${t(ctx, ': Promise<Ready>')} {
  const kit = await createKit();
  const handle = toFetch(
    {
${mountsText(box, '      ')}    },
    ${options},
  );
${hubLine}  return { kit, answer: ${answer} };
}

function ready()${t(ctx, ': Promise<Ready>')} {
  let current = shared[SLOT];
  if (current === undefined) {
    current = build();
    shared[SLOT] = current;
    // A start that failed is tried again by the next request, not remembered.
    current.catch(() => {
      shared[SLOT] = undefined;
    });
  }
  return current;
}

/** The kit, for your own code (kit.cw.chat.accept(...)) and for kit.close() on shutdown. */
export async function getKit()${t(ctx, ': Promise<Kit>')} {
  return (await ready()).kit;
}

/** Answer one request under ${answers.base}.${next ? '' : ' Resolves null for a path that is not Chatwarden\'s, so your host can answer it.'} */
export async function handler(request${t(ctx, ': Request')})${t(ctx, `: Promise<${result}>`)} {
  return (await ready()).answer(request);
}
`;
  return [{ path: `${answers.dir}/handler${ctx.scriptExt}`, content }];
}

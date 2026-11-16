// `express.ts` (design 6.1, 6.2): `mountChatwarden(app)`, the whole Express wiring. The kit's routes are mounted by `toExpress` with
// `fallthrough: false`, so an unknown path under the prefix is the kit's JSON 404 and never a hang, and they are mounted before any body parser.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function expressFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.framework !== 'express') return [];
  const box = answers.chat === 'box';
  const hub = answers.hub === 'element';

  const routes = ['adminRoutes', ...(box ? ['chatRoutes'] : []), 'healthRoutes', 'playerRoutes'];
  const imports =
    imp(ctx, routes, '@chatwarden/http') +
    imp(ctx, 'toExpress', '@chatwarden/http/express') +
    impType(ctx, 'Express', 'express') +
    imp(ctx, 'createKit', './kit') +
    impType(ctx, 'Kit', './kit') +
    (hub ? imp(ctx, 'mountHub', './hub') : '');

  const chat = box
    ? `  app.use(\`\${kit.base}/chat\`, toExpress(chatRoutes(kit.cw, kit.chat, { identify: kit.hooks.identify, join: kit.hooks.join }), { fallthrough: false }));\n`
    : '';
  const mountHub = hub ? '  mountHub(app, kit);\n' : '';

  const content = `${header(ctx, 'Mounts Chatwarden on your Express app: await mountChatwarden(app).')}${imports}
/**
 * Mount the moderation routes under \`kit.base\` (/chatwarden by default) and return the kit, so your own code can reach \`kit.cw\` and call
 * \`kit.close()\` on shutdown.
 *
 * Call this before any body parser (express.json(), express.urlencoded(), body-parser). The kit reads each request body itself, in full,
 * to enforce its size cap and refuse forbidden keys. A body parser mounted before it has already consumed the body and the kit answers an
 * error, so that order is not supported. A parser mounted after this call is fine.
 */
export async function mountChatwarden(app${t(ctx, ': Express')})${t(ctx, ': Promise<Kit>')} {
  const kit = await createKit();
  // fallthrough: false makes an unknown path under the prefix the kit's own 404; a path outside it is still yours.
  app.use(\`\${kit.base}/admin\`, toExpress(adminRoutes(kit.cw, { authorize: kit.hooks.authorize, terms: kit.terms }), { fallthrough: false }));
  app.use(\`\${kit.base}/api\`, toExpress(playerRoutes(kit.cw, { identify: kit.hooks.identify }), { fallthrough: false }));
${chat}${mountHub}  app.use(kit.base, toExpress(healthRoutes(kit.cw), { fallthrough: false }));
  return kit;
}
`;
  return [{ path: `${answers.dir}/express${ctx.scriptExt}`, content }];
}

// `fastify.ts` (design 6.1, 9.2): a Fastify plugin that bridges to `toFetch`. Fastify parses a JSON body before a route runs, and the kit must see the
// exact text, so the plugin (encapsulated: the app's other routes are untouched) swaps the body parsers for one that hands the text over, builds a Web
// `Request` and sends the `Response` back. The peer address is the socket's, never a header. The spike for design 9.2 showed that `reply.send` of a
// streaming `Response` delivers each frame as it is enqueued and that a closed client socket cancels it, so no `hijack()` is needed.
import type { FileSpec } from '../types.js';
import { mountsText } from './fetchHandler.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function fastifyFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  if (answers.framework !== 'fastify') return [];
  // The HTTP chat routes are mounted for the SSE transport; with Socket.IO the box rides the game's own socket (socketio.ts) instead.
  const box = answers.chat === 'box' && answers.chatTransport === 'sse';
  const hub = answers.hub === 'element';

  const routes = ['adminRoutes', ...(box ? ['chatRoutes'] : []), 'healthRoutes', 'playerRoutes'];
  const imports =
    imp(ctx, routes, '@chatwarden/http') +
    imp(ctx, 'BODY_MAX_BYTES', '@chatwarden/http') +
    imp(ctx, 'toFetch', '@chatwarden/http/fetch') +
    impType(ctx, ['FastifyError', 'FastifyInstance', 'FastifyPluginAsync', 'FastifyRequest'], 'fastify') +
    impType(ctx, 'IncomingHttpHeaders', 'node:http') +
    imp(ctx, 'createKit', './kit') +
    impType(ctx, 'Kit', './kit') +
    (hub ? imp(ctx, 'hubHandler', './hub') : '');

  const hubLine = hub ? '  const hub = hubHandler(kit);\n' : '';
  const answer = hub ? 'const response = (await hub(web)) ?? (await handle(web));' : 'const response = await handle(web);';

  const content = `${header(ctx, 'Mounts Chatwarden on your Fastify app: await mountChatwarden(app).')}${imports}
/** The request headers in the form the Web Request wants: one string per name (a repeated header is joined). */
function headersOf(raw${t(ctx, ': IncomingHttpHeaders')})${t(ctx, ': Record<string, string>')} {
  const out${t(ctx, ': Record<string, string>')} = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}

/** The Web Request for a Fastify request. The body is the exact text the parser below handed over. */
function webRequestOf(request${t(ctx, ': FastifyRequest')}, signal${t(ctx, ': AbortSignal')})${t(ctx, ': Request')} {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return new Request(new URL(request.url, \`\${request.protocol}://\${request.host}\`), {
    method: request.method,
    headers: headersOf(request.headers),
    signal,
    ...(hasBody ? { body: typeof request.body === 'string' ? request.body : '' } : {}),
  });
}

/**
 * The plugin: register it with the kit and the prefix, \`app.register(chatwarden, { kit, prefix: kit.base })\`, or call mountChatwarden(app).
 * It is encapsulated, so removing the body parsers below changes this plugin's routes only: your own routes keep Fastify's JSON parsing.
 */
export const chatwarden${t(ctx, ': FastifyPluginAsync<{ kit: Kit }>')} = async (app, { kit }) => {
  // The kit reads each body itself, in full, to enforce its cap and refuse forbidden keys: Fastify must not parse it first. It still stops
  // reading at the cap, and the kit's own error shape answers an oversized body.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'string', bodyLimit: BODY_MAX_BYTES }, (_request, body, done) => done(null, body));
  app.setErrorHandler((error${t(ctx, ': FastifyError')}, _request, reply) => {
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: 'payload_too_large', message: 'The request body is too large.' });
    }
    return reply.send(error);
  });

  // The peer address of each request, kept by request: the socket's, which a client cannot choose, never a header.
  const peers = new WeakMap${t(ctx, '<Request, string>')}();
  const handle = toFetch(
    {
${mountsText(box, '      ')}    },
    { prefix: kit.base, remoteAddress: (request) => peers.get(request) },
  );
${hubLine}
  app.all('/*', async (request, reply) => {
    const gone = new AbortController();
    reply.raw.once('close', () => gone.abort());
    const web = webRequestOf(request, gone.signal);
    peers.set(web, request.socket.remoteAddress ?? '');
    ${answer}
    return reply.send(response);
  });
};

/** Build the kit, mount the plugin under its prefix and close the kit when the app closes. Returns the kit for your own code. */
export async function mountChatwarden(app${t(ctx, ': FastifyInstance')})${t(ctx, ': Promise<Kit>')} {
  const kit = await createKit();
  await app.register(chatwarden, { kit, prefix: kit.base });
  app.addHook('onClose', async () => {
    await kit.close();
  });
  return kit;
}
`;
  return [{ path: `${answers.dir}/fastify${ctx.scriptExt}`, content }];
}

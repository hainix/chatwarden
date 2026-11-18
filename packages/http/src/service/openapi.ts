// `SERVICE_OPENAPI`: the /v1 API as an OpenAPI 3.1 document, built from the same route descriptions (`ROUTE_SPECS`) the route table is built from. Deterministic: the same
// descriptions give the same bytes (no date, no host, no key). `chatwarden serve --print-openapi` prints it. Browser-safe.
import { SERVICE_API_VERSION } from './contract.js';
import { ROUTE_SPECS, SERVICE_SCHEMAS } from './routes.js';
import type { RouteSpec } from './routes.js';

type Doc = Record<string, unknown>;

const ID_PATTERN = '^[A-Za-z0-9_.:@~-]{1,128}$';

const errorResponse = (description: string): Doc => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

/** The path params of a spec, in the order they appear: ids of the game's own (a notice id is the kit's, 1 to 64 of `A-Za-z0-9_-`). */
function parametersOf(spec: RouteSpec): Doc[] {
  const params: Doc[] = [...spec.openapiPath.matchAll(/\{([A-Za-z]+)\}/g)].map((m) => ({
    name: m[1],
    in: 'path',
    required: true,
    schema: m[1] === 'id' ? { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } : { type: 'string', pattern: ID_PATTERN },
  }));
  if (spec.idempotent === true) {
    params.push({
      name: 'Idempotency-Key',
      in: 'header',
      required: false,
      description: 'Up to 64 characters of A-Za-z0-9_.:-. The same key and body within ten minutes replays the first answer (`idempotent-replay: true`) and runs nothing again.',
      schema: { type: 'string', pattern: '^[A-Za-z0-9_.:-]{1,64}$' },
    });
  }
  return params;
}

function operationOf(spec: RouteSpec): Doc {
  const responses: Doc = {
    '200': { description: 'The answer. A refusal of a line, a report or a door is an answer too.', content: { 'application/json': { schema: spec.answer } } },
    '400': errorResponse('The request is not valid (`invalid_request`, `invalid_json`, `forbidden_key`, `invalid_idempotency_key`).'),
    '401': errorResponse('No service key, or a wrong one.'),
    '429': errorResponse('Too many requests; see `retry-after`.'),
  };
  if (spec.request !== undefined) responses['413'] = errorResponse('The body is over 64 KiB.');
  if (spec.idempotent === true) responses['409'] = errorResponse('`idempotency_mismatch` (the key was used with another body) or `in_progress`.');
  const op: Doc = { operationId: spec.name, summary: spec.summary, responses };
  const parameters = parametersOf(spec);
  if (parameters.length > 0) op.parameters = parameters;
  if (spec.request !== undefined) op.requestBody = { required: true, content: { 'application/json': { schema: spec.request, example: spec.requestExample } } };
  return op;
}

/** Build the document. A pure function of `ROUTE_SPECS` and `SERVICE_SCHEMAS`. */
export function buildServiceOpenApi(): Doc {
  const paths: Record<string, Doc> = {};
  for (const spec of ROUTE_SPECS) {
    const key = `/v1${spec.openapiPath === '/' ? '' : spec.openapiPath}`;
    (paths[key] ??= {})[spec.method.toLowerCase()] = operationOf(spec);
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Chatwarden service API',
      version: String(SERVICE_API_VERSION),
      description:
        'Chat moderation for a game server in any language. Every call carries `Authorization: Bearer <service key>`. A refusal is a 200 with `ok: false`. Within v1 a change is additive only: ignore response fields you do not know and treat a refusal reason you do not know as unknown.',
    },
    paths,
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: SERVICE_SCHEMAS },
    security: [{ bearer: [] }],
  };
}

/**
 * The service API as an OpenAPI 3.1 document.
 * @experimental
 */
export const SERVICE_OPENAPI: Readonly<Record<string, unknown>> = buildServiceOpenApi();

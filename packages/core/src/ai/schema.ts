// The JSON Schema for a read's answer. STATIC: it never mentions a rule number or a line ref, because those are checked in core
// (validate.ts), so a provider compiles the schema once. It uses only what structured outputs accept: types, enums, anyOf,
// `required` and `additionalProperties: false`; no minLength, maximum or the like (the limits are enforced by validate.ts).

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const v of Object.values(value as object)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const LEVELS = ['banter', 'rude', 'hostile', 'severe'];
const RULE = {
  anyOf: [{ type: 'integer' }, { type: 'string', enum: ['uncovered'] }, { type: 'null' }],
};
const REFS = { type: 'array', items: { type: 'string' } };

/**
 * The answer a model returns for one report. Core validates the parsed JSON again (`validateAIOutput`); the schema only shapes it.
 * @experimental
 */
export const AI_OUTPUT_SCHEMA: object = deepFreeze({
  type: 'object',
  properties: {
    severity: { type: 'string', enum: LEVELS },
    rule: RULE,
    summary: { type: 'string' },
    evidence: REFS,
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    injectionSuspected: { type: 'boolean' },
    recommendation: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            verdict: { type: 'string', enum: ['upheld', 'noted', 'no_action', 'unclear'] },
            severity: { type: 'string', enum: LEVELS },
            rule: RULE,
            evidence: REFS,
          },
          required: ['verdict', 'severity', 'rule', 'evidence'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['severity', 'rule', 'summary', 'evidence', 'confidence', 'injectionSuspected', 'recommendation'],
  additionalProperties: false,
});

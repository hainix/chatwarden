// A small JSON Schema checker for the service tests: only the vocabulary the service's own schemas use (type, properties, required, additionalProperties, items, enum, const,
// oneOf, $ref into the document's components, and the length and range keywords). It returns the problems found, an empty list when the value fits.

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

export function check(schema: Schema, value: unknown, doc: { components?: { schemas?: Record<string, Schema> } } = {}, path = '$'): string[] {
  const ref = schema.$ref;
  if (typeof ref === 'string') {
    const name = ref.replace('#/components/schemas/', '');
    const target = doc.components?.schemas?.[name];
    if (target === undefined) return [`${path}: unknown $ref ${ref}`];
    return check(target, value, doc, path);
  }
  if (Array.isArray(schema.oneOf)) {
    const results = (schema.oneOf as Schema[]).map((s) => check(s, value, doc, path));
    const fits = results.filter((r) => r.length === 0).length;
    return fits === 1 ? [] : [`${path}: matches ${fits} of ${results.length} alternatives (${results.map((r) => r[0]).join(' | ')})`];
  }
  const problems: string[] = [];
  const actual = typeOf(value);
  const allowed = schema.type === undefined ? undefined : (Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string]);
  if (allowed !== undefined && !allowed.some((t) => t === actual || (t === 'number' && actual === 'integer'))) return [`${path}: expected ${allowed.join('|')}, got ${actual}`];
  if (schema.const !== undefined && value !== schema.const) problems.push(`${path}: not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !(schema.enum as unknown[]).includes(value)) problems.push(`${path}: not in enum`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) problems.push(`${path}: too short`);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) problems.push(`${path}: too long`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) problems.push(`${path}: pattern`);
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) problems.push(`${path}: below minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) problems.push(`${path}: above maximum`);
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) problems.push(`${path}: too few items`);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) problems.push(`${path}: too many items`);
    if (schema.items !== undefined) value.forEach((item, i) => problems.push(...check(schema.items as Schema, item, doc, `${path}[${i}]`)));
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!Object.hasOwn(o, key)) problems.push(`${path}.${key}: required`);
    for (const [key, v] of Object.entries(o)) {
      if (props[key] !== undefined) problems.push(...check(props[key], v, doc, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
    }
  }
  return problems;
}

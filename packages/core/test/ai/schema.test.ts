import { describe, expect, it } from 'vitest';
import { AI_OUTPUT_SCHEMA } from '../../src/ai/schema.js';

type Json = { [k: string]: unknown };

function objects(node: unknown, path = '$'): Array<[string, Json]> {
  const out: Array<[string, Json]> = [];
  if (Array.isArray(node)) {
    node.forEach((n, i) => out.push(...objects(n, `${path}[${i}]`)));
  } else if (node !== null && typeof node === 'object') {
    const o = node as Json;
    if (o.type === 'object' || 'properties' in o) out.push([path, o]);
    for (const [k, v] of Object.entries(o)) out.push(...objects(v, `${path}.${k}`));
  }
  return out;
}

function isDeepFrozen(node: unknown): boolean {
  if (node === null || typeof node !== 'object') return true;
  return Object.isFrozen(node) && Object.values(node).every(isDeepFrozen);
}

describe('AI_OUTPUT_SCHEMA', () => {
  it('the schema is static and carries no rule number or line ref', () => {
    const text = JSON.stringify(AI_OUTPUT_SCHEMA);
    expect(text).not.toMatch(/\bL\d+\b/);
    expect(text).not.toMatch(/\bP\d+\b/);
    // No numeric enum or const: a rule number is checked in core, not by the schema.
    expect(text).not.toMatch(/"(enum|const)":\s*\[?\s*\d/);
    // Plain JSON that round-trips.
    expect(JSON.parse(text)).toEqual(AI_OUTPUT_SCHEMA);
  });

  it('every schema object forbids additional properties', () => {
    const found = objects(AI_OUTPUT_SCHEMA);
    expect(found.length).toBeGreaterThanOrEqual(2); // the root and the recommendation
    for (const [path, o] of found) {
      expect(o.additionalProperties, path).toBe(false);
      // Every declared property is required.
      expect([...(o.required as string[])].sort(), path).toEqual(Object.keys(o.properties as Json).sort());
    }
  });

  it('uses no keyword the provider rejects', () => {
    const text = JSON.stringify(AI_OUTPUT_SCHEMA);
    for (const k of ['minLength', 'maxLength', 'maximum', 'minimum', 'maxItems', 'minItems', 'pattern', 'format']) {
      expect(text).not.toContain(`"${k}"`);
    }
  });

  it('lists the enums', () => {
    const p = (AI_OUTPUT_SCHEMA as Json).properties as Record<string, Json>;
    expect(p.severity?.enum).toEqual(['banter', 'rude', 'hostile', 'severe']);
    expect(p.confidence?.enum).toEqual(['low', 'medium', 'high']);
    expect(JSON.stringify(p.recommendation)).toContain('"upheld","noted","no_action","unclear"');
    expect(JSON.stringify(p.recommendation)).not.toContain('bad_faith');
  });

  it('is deeply frozen', () => {
    expect(isDeepFrozen(AI_OUTPUT_SCHEMA)).toBe(true);
  });
});

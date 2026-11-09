import { CONDUCT_LEVELS } from '@chatwarden/core';
import type { ConductLevel, RuleRef } from '@chatwarden/core';
import { parseJson } from '../body.js';
import { HttpError, ValidationError } from '../errors.js';
import type { KitRequest } from '../types.js';

// Shared by the staff routes. Every refusal is a fixed-message HttpError: nothing the client sent is echoed.

/** An id as the router accepts it in a path: the same charset and length. */
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** The JSON body as a plain object. No body, bad JSON, an array, a string or `null` are 400 (the body cap is 413). */
export function bodyObject(req: KitRequest): Record<string, unknown> {
  const value = parseJson(req.rawBody);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ValidationError();
  return value as Record<string, unknown>;
}

/** True when the object has this key of its own (a JSON body has no `undefined`, so a present key has a value). */
export const has = (o: Record<string, unknown>, key: string): boolean => Object.hasOwn(o, key);

/** A plain object (not an array, not null), or undefined. */
export const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A query `limit`: absent is `undefined`; otherwise a whole number of at most nine digits, else 400 `invalid_query`. */
export function queryLimit(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) throw new HttpError('invalid_query');
  return Number(raw);
}

const isLevel = (v: unknown): v is ConductLevel => typeof v === 'string' && (CONDUCT_LEVELS as readonly string[]).includes(v);

/** A query `level`: absent is null; otherwise a conduct level, else 400 `invalid_query`. */
export function queryLevel(raw: string | undefined): ConductLevel | null {
  if (raw === undefined) return null;
  if (!isLevel(raw)) throw new HttpError('invalid_query');
  return raw;
}

/** A body `level`: absent or null is null; otherwise a conduct level, else 400. */
export function bodyLevel(v: unknown): ConductLevel | null {
  if (v === undefined || v === null) return null;
  if (!isLevel(v)) throw new ValidationError();
  return v;
}

/** A Community Rule reference: a whole number from 1, or `'uncovered'`. Anything else is 400. */
export function bodyRule(v: unknown): RuleRef {
  if (v === 'uncovered') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 1) return v;
  throw new ValidationError();
}

/** A staff ref or other id: 1..64 characters of `A-Z a-z 0-9 _ -`, else 400. */
export function bodyId(v: unknown): string {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new ValidationError();
  return v;
}

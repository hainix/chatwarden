// Compile-time proof that the real Cloudflare bindings satisfy the structural interfaces in src/env.ts (the tests use fakes of the same
// shape). This file is type-checked only; it is never run or deployed. It lives apart because @cloudflare/workers-types and @types/node
// declare overlapping globals and must not be loaded together.
import type { D1Like, Env, R2Like } from '../src/env.js';

export const asD1 = (db: D1Database): D1Like => db;
export const asR2 = (bucket: R2Bucket): R2Like => bucket;
export const asEnv = (db: D1Database, bucket: R2Bucket): Env => ({ DB: db, RELEASES: bucket, COUNTER_SECRET: 'x' });

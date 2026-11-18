// 0.2.0: `GET /policy` always carries `notices` (the server sends it on every answer), so the hub's type says so. Type-level tests: the
// `@ts-expect-error` lines are checked by `tsc`, which the repo typecheck runs over the tests (an unused directive is an error).
import { describe, expect, it } from 'vitest';
import type { PolicyDocs, FlaggedReport } from '../src/types.js';

type Docs = Pick<PolicyDocs, 'profile' | 'rules' | 'summary' | 'documents'>;

describe('PolicyDocs.notices is required', () => {
  it('a PolicyDocs without notices does not type-check', () => {
    const base = {} as Docs;
    // @ts-expect-error notices is required
    const missing: PolicyDocs = { ...base };
    const present: PolicyDocs = { ...base, notices: { reporterFeedback: false } };
    expect(present.notices.reporterFeedback).toBe(false);
    expect(missing).toBeDefined();
  });

  it('reads without an optional chain', () => {
    const docs = { notices: { reporterFeedback: true } } as PolicyDocs;
    const value: boolean = docs.notices.reporterFeedback;
    expect(value).toBe(true);
  });

  it('an excerpt line keeps noticeText optional: the server omits it for a line nobody wrote', () => {
    const line = {} as FlaggedReport['excerpt'][number];
    const text: string | undefined = line.noticeText;
    expect(text).toBeUndefined();
  });
});

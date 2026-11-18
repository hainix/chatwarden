import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentProblems } from '../../packages/http/src/cli/plan.js';
import { serviceFiles } from '../../packages/http/src/cli/templates/service.js';
import { VERSION } from '../../packages/http/src/version.js';

// S6: examples/service is the Docker recipe: the same files `chatwarden init --service` writes (they are made by the same templates, and this test fails when they differ), plus curl.sh and the
// conformance script. A real `docker build` is the maintainer's check once the version is on npm; nothing here builds or pushes an image.

const DIR = fileURLToPath(new URL('.', import.meta.url));
const read = (name: string): string => readFileSync(join(DIR, name), 'utf8');
const written = serviceFiles({ store: 'sqlite', profile: 'standard', dir: 'x' }, { chatwarden: VERSION }).map((f) => ({ name: f.path.slice('x/'.length), content: f.content }));

describe('the recipe files equal what init --service writes', () => {
  it.each(written.map((f) => f.name))('%s', (name) => {
    const expected = written.find((f) => f.name === name)!.content;
    expect(read(name) === expected, `${name} differs from the template output: run  npx chatwarden init --service --dir examples/service --force  in a scratch copy, or fix the template`).toBe(true);
  });

  it('there is nothing else in the folder but the recipe, the scripts, the expectations, the cases and the tests', () => {
    const names = readdirSync(DIR).sort();
    expect(names).toEqual(['.dockerignore', '.env.example', 'Dockerfile', 'README.txt', 'cases', 'compose.yaml', 'conformance.mjs', 'conformance.test.ts', 'curl.sh', 'expectations.json', 'profile.json', 'recipe.test.ts']);
  });

  it('no file has a carriage return, a secret-like run, a machine path or a timestamp', () => {
    for (const name of readdirSync(DIR).filter((n) => !n.endsWith('.test.ts') && !['cases'].includes(n))) {
      expect(contentProblems(read(name)), name).toEqual([]);
    }
  });
});

describe('the static rules of the recipe', () => {
  const docker = read('Dockerfile');
  const compose = read('compose.yaml');

  it('the Dockerfile: node:22-slim, the version of this release as an ARG, a non-root user, a volume, a health check, serve as the command; no secret', () => {
    expect(docker).toMatch(/^FROM node:22-slim$/m);
    expect(docker).toMatch(new RegExp(`^ARG CHATWARDEN_VERSION=${VERSION.replaceAll('.', '\\.')}$`, 'm'));
    expect(docker).toMatch(/^USER node$/m);
    expect(docker).toMatch(/^VOLUME \/data$/m);
    expect(docker).toMatch(/^HEALTHCHECK /m);
    expect(docker).toMatch(/^CMD \["node", "node_modules\/\.bin\/chatwarden", "serve"\]$/m);
    for (const name of ['CHATWARDEN_SECRET', 'CHATWARDEN_SERVICE_KEYS', 'CHATWARDEN_ADMIN_TOKEN']) expect(docker).not.toMatch(new RegExp(`^(ENV|ARG) .*${name}`, 'm'));
    expect(docker).not.toMatch(/^USER root/m);
  });

  it('the compose file: the port is bound to localhost, and the three variables are read from the environment', () => {
    expect(compose).toMatch(/"127\.0\.0\.1:8787:8787"/);
    for (const name of ['CHATWARDEN_SECRET', 'CHATWARDEN_SERVICE_KEYS']) expect(compose).toMatch(new RegExp(`${name}: \\$\\{${name}:\\?`));
    expect(compose).toMatch(/CHATWARDEN_ADMIN_TOKEN: \$\{CHATWARDEN_ADMIN_TOKEN:-\}/);
  });

  it('the environment example holds the three names and no value', () => {
    expect(read('.env.example').split('\n').filter((l) => /^[A-Z_]+=/.test(l))).toEqual(['CHATWARDEN_SECRET=', 'CHATWARDEN_SERVICE_KEYS=', 'CHATWARDEN_ADMIN_TOKEN=']);
  });
});

describe('curl.sh', () => {
  const script = read('curl.sh');

  it('is a readable shell script that stops at the first failure and takes the server and the key from the environment', () => {
    expect(script.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(script).toMatch(/^set -euo pipefail$/m);
    expect(script).toMatch(/\bBASE="\$\{BASE:-http:\/\/127\.0\.0\.1:8787\}"/);
    expect(script).toMatch(/KEY="\$\{KEY:\?/);
    expect(script.includes('\r')).toBe(false);
  });

  it('makes the five core calls: seat, check a line, report, the notices of a player, and the restriction (and the doors check)', () => {
    for (const path of ['/v1/rooms/$ROOM/seats/alice', '/v1/rooms/$ROOM/seats/alice/lines', '/v1/rooms/$ROOM/seats/bob/reports', '/v1/notices/pending', '/v1/restriction', '/v1/doors/check']) expect(script, path).toContain(path);
    expect(script).toMatch(/-X PUT/);
    expect(script).toMatch(/Idempotency-Key/);
  });

  it('holds no key: the bearer is the variable', () => {
    expect(script).toContain('Authorization: Bearer $KEY');
    expect(script).not.toMatch(/Bearer [A-Za-z0-9_-]{16,}/);
  });
});

describe('the expectations file', () => {
  it('is JSON with a list of named steps, each with the strings its answer holds', () => {
    const doc = JSON.parse(read('expectations.json')) as { steps: Array<{ name: string; expect: string[] }> };
    expect(doc.steps.length).toBeGreaterThanOrEqual(10);
    expect(new Set(doc.steps.map((s) => s.name)).size).toBe(doc.steps.length);
    for (const step of doc.steps) {
      expect(step.name).toMatch(/^[a-z][a-z0-9 ]{2,40}$/);
      expect(step.expect.length).toBeGreaterThan(0);
      for (const text of step.expect) expect(typeof text).toBe('string');
    }
  });
});

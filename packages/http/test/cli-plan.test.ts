import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.js';
import { buildPlan, contentProblems } from '../src/cli/plan.js';
import type { Answers, FileSpec, Project } from '../src/cli/types.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'] as const;
const plan = (over: Partial<Answers> = {}, project: Project = PROJECT) => buildPlan(answersOf(over), VERSIONS, stubTemplates, project);

function allAnswers(): Answers[] {
  const out: Answers[] = [];
  for (const framework of ['express', 'fastify', 'next', 'fetch', 'none'] as const)
    for (const store of ['sqlite', 'memory'] as const)
      for (const chat of ['none', 'box'] as const)
        for (const hub of ['element', 'react', 'none'] as const)
          for (const discord of [false, true])
            for (const lang of ['ts', 'js'] as const)
              out.push(answersOf({ framework, store, chat, hub, discord, lang, chatTransport: chat === 'box' && framework !== 'none' ? 'socketio' : 'sse' }));
  return out;
}

describe('buildPlan', () => {
  it('the same answers give a byte-identical plan twice', () => {
    for (const answers of allAnswers()) {
      const a = JSON.stringify(buildPlan(answers, VERSIONS, stubTemplates, PROJECT));
      const b = JSON.stringify(buildPlan({ ...answers }, { ...VERSIONS }, stubTemplates, { ...PROJECT }));
      expect(b).toBe(a);
    }
  });

  it('takes the templates as a function or as the list it returns', () => {
    const answers = answersOf({ chat: 'box' });
    expect(buildPlan(answers, VERSIONS, stubTemplates(answers, VERSIONS), PROJECT)).toEqual(buildPlan(answers, VERSIONS, stubTemplates, PROJECT));
  });

  it('does not change what it is given', () => {
    const answers = answersOf({ chat: 'box' });
    const frozen = JSON.stringify(answers);
    const files = stubTemplates(answers, VERSIONS);
    const before = JSON.stringify(files);
    const built = buildPlan(answers, VERSIONS, files, PROJECT);
    expect(JSON.stringify(answers)).toBe(frozen);
    expect(JSON.stringify(files)).toBe(before);
    expect(built.answers).toEqual(answers);
  });

  it('files are sorted by path', () => {
    for (const answers of allAnswers().slice(0, 40)) {
      const paths = buildPlan(answers, VERSIONS, stubTemplates, PROJECT).files.map((f) => f.path);
      expect(paths).toEqual([...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      expect(new Set(paths).size).toBe(paths.length);
    }
    // The stub puts the chat panel and the route first; the plan sorts them into place.
    const paths = plan({ chat: 'box', framework: 'next', hub: 'react' }).files.map((f) => f.path);
    expect(paths[0]).toBe('app/chatwarden/[...path]/route.ts');
    expect(paths).toContain('src/chatwarden/ChatPanel.tsx');
  });

  it('sorting is by code unit, not by the machine locale', () => {
    const files: FileSpec[] = [{ path: 'b.ts', content: 'b\n' }, { path: 'B.ts', content: 'B\n' }, { path: 'a.ts', content: 'a\n' }, { path: '_x.ts', content: 'x\n' }];
    expect(buildPlan(answersOf(), VERSIONS, files, PROJECT).files.map((f) => f.path)).toEqual(['B.ts', '_x.ts', 'a.ts', 'b.ts']);
  });

  it('two templates with the same path are an error, not a silent overwrite', () => {
    const files: FileSpec[] = [{ path: 'a.ts', content: 'one\n' }, { path: 'a.ts', content: 'two\n' }];
    expect(() => buildPlan(answersOf(), VERSIONS, files, PROJECT)).toThrow(/a\.ts/);
  });

  it('normalises line endings to \\n and keeps everything else', () => {
    const files: FileSpec[] = [{ path: 'a.ts', content: "line one\r\nline two\r\n// \u00e9 tab\there\r\n" }];
    const built = buildPlan(answersOf(), VERSIONS, files, PROJECT);
    expect(built.files[0]?.content).toBe("line one\nline two\n// \u00e9 tab\there\n");
    expect(built.files[0]?.content).not.toContain('\r');
  });

  it('no file content contains \\r, an absolute path, a timestamp or a run of 32 or more hex or base64 characters', () => {
    for (const answers of allAnswers()) {
      for (const file of buildPlan(answers, VERSIONS, stubTemplates, PROJECT).files) {
        expect(contentProblems(file.content), `${file.path}`).toEqual([]);
      }
    }
  });

  it('contentProblems catches each kind (controls)', () => {
    expect(contentProblems('a\r\nb')).toContain('carriage-return');
    expect(contentProblems("const p = 'C:\\\\Users\\\\zorbak\\\\x';")).toContain('absolute-path');
    expect(contentProblems("const p = 'C:/Users/zorbak/x';")).toContain('absolute-path');
    expect(contentProblems('see /Users/zorbak/project')).toContain('absolute-path');
    expect(contentProblems('see /home/zorbak/project')).toContain('absolute-path');
    expect(contentProblems('// written 2026-11-12T10:20:30Z')).toContain('timestamp');
    expect(contentProblems('// written 2026-11-12 10:20')).toContain('timestamp');
    expect(contentProblems('const t = 1800000000000;')).toContain('timestamp');
    expect(contentProblems(`const s = '${'0123456789abcdef'.repeat(2)}';`)).toContain('long-secret-like-run');
    expect(contentProblems(`const s = '${'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF'}';`)).toContain('long-secret-like-run');
    // And the ordinary things a template holds are clean.
    expect(contentProblems("import { createChatwarden } from '@chatwarden/core';\nexport const BASE = '/chatwarden'; // http://localhost:3000/chatwarden/mod\n")).toEqual([]);
    expect(contentProblems("app.use('/chatwarden/admin', toExpress(adminRoutes(kit.cw, { authorize })));")).toEqual([]);
    expect(contentProblems('const veryLongIdentifierNameThatKeepsGoingAndGoing = 1;')).toEqual([]);
    expect(contentProblems('CHATWARDEN_SECRET=\nCHATWARDEN_ADMIN_TOKEN=\n')).toEqual([]);
  });

  it('answers it was given are echoed, files keep their markers, and a todo lists each marker with its line', () => {
    const built = plan();
    expect(built.answers).toEqual(answersOf());
    const auth = built.files.find((f) => f.path === 'src/chatwarden/auth.ts');
    expect(auth?.markers).toEqual(['TODO(auth)', 'TODO(identity)']);
    expect(built.todo).toEqual([
      { file: 'src/chatwarden/auth.ts', line: 2, marker: 'TODO(auth)' },
      { file: 'src/chatwarden/auth.ts', line: 6, marker: 'TODO(identity)' },
      { file: 'src/chatwarden/terms.ts', line: 1, marker: 'TODO(terms)' },
    ]);
  });

  it('a todo lists every line that carries a marker, and none for a file with no markers', () => {
    const files: FileSpec[] = [
      { path: 'a.ts', content: '// TODO(auth) one\nx\n// TODO(auth) two\n', markers: ['TODO(auth)'] },
      { path: 'b.ts', content: '// TODO(auth) but not declared\n' },
      { path: 'c.ts', content: 'nothing here\n', markers: ['TODO(terms)'] },
    ];
    expect(buildPlan(answersOf(), VERSIONS, files, PROJECT).todo).toEqual([
      { file: 'a.ts', line: 1, marker: 'TODO(auth)' },
      { file: 'a.ts', line: 3, marker: 'TODO(auth)' },
    ]);
  });
});

describe('buildPlan: the install command', () => {
  const caret = `^${VERSION}`;

  it('is built per manager (npm install, pnpm add, yarn add, bun add) with caret ranges of the http VERSION', () => {
    const verbs: Record<(typeof MANAGERS)[number], string> = { npm: 'npm install', pnpm: 'pnpm add', yarn: 'yarn add', bun: 'bun add' };
    for (const manager of MANAGERS) {
      const built = plan({}, { manager, react: true });
      expect(built.install.manager).toBe(manager);
      expect(built.install.command.startsWith(`${verbs[manager]} `)).toBe(true);
      expect(built.install.command).toBe(`${verbs[manager]} ${built.install.packages.join(' ')}`);
      for (const spec of built.install.packages) expect(spec).toMatch(new RegExp(`^@chatwarden/[a-z-]+@\\${caret}$`));
    }
  });

  it('takes the number from the versions it is given, never a literal', () => {
    const built = buildPlan(answersOf(), { chatwarden: '7.8.9' }, stubTemplates, PROJECT);
    expect(built.install.packages).toContain('@chatwarden/core@^7.8.9');
    expect(built.install.command).not.toContain(`^${VERSION}`);
  });

  it('lists only packages the answers need', () => {
    const names = (over: Partial<Answers>, project: Project = { manager: 'npm', react: true }): string[] =>
      plan(over, project).install.packages.map((spec) => spec.replace(/@\^.*$/, ''));
    expect(names({})).toEqual(['@chatwarden/core', '@chatwarden/http', '@chatwarden/store-sqlite', '@chatwarden/matcher', '@chatwarden/profanity', '@chatwarden/hub-element']);
    expect(names({ store: 'memory' })).toContain('@chatwarden/store-memory');
    expect(names({ store: 'memory' })).not.toContain('@chatwarden/store-sqlite');
    expect(names({ discord: true })).toContain('@chatwarden/discord');
    expect(names({ discord: false })).not.toContain('@chatwarden/discord');
    expect(names({ hub: 'react', framework: 'next' })).toContain('@chatwarden/hub-react');
    expect(names({ hub: 'react', framework: 'next' })).not.toContain('@chatwarden/hub-element');
    expect(names({ hub: 'none' })).not.toContain('@chatwarden/hub-element');
    expect(names({ hub: 'none' })).not.toContain('@chatwarden/hub-react');
    expect(names({ chat: 'box' })).toContain('@chatwarden/player-react');
    expect(names({ chat: 'none' })).not.toContain('@chatwarden/player-react');
    // Library only: the kit, the store, the matcher; no hub and no box.
    expect(names({ framework: 'none', hub: 'none', chat: 'none' })).toEqual(['@chatwarden/core', '@chatwarden/http', '@chatwarden/store-sqlite', '@chatwarden/matcher', '@chatwarden/profanity']);
  });

  it('adds react and react-dom (unpinned) only when a React part is wanted and the project has none', () => {
    const packages = (over: Partial<Answers>, react: boolean): string[] => plan(over, { manager: 'npm', react }).install.packages;
    expect(packages({ hub: 'react', framework: 'next' }, false)).toEqual(expect.arrayContaining(['react', 'react-dom']));
    expect(packages({ hub: 'react', framework: 'next' }, true)).not.toContain('react');
    expect(packages({ chat: 'box' }, false)).toEqual(expect.arrayContaining(['react', 'react-dom']));
    expect(packages({ chat: 'box' }, true)).not.toContain('react-dom');
    expect(packages({ hub: 'element', chat: 'none' }, false)).not.toContain('react');
    // Never two copies.
    const list = packages({ hub: 'react', framework: 'next', chat: 'box' }, false);
    expect(list.filter((p) => p === 'react')).toHaveLength(1);
    expect(list.filter((p) => p === 'react-dom')).toHaveLength(1);
  });

  it('a shell metacharacter can never reach the command: every package is a fixed name and a validated version', () => {
    for (const answers of allAnswers()) {
      for (const manager of MANAGERS) {
        for (const spec of buildPlan(answers, VERSIONS, stubTemplates, { manager, react: false }).install.packages) {
          expect(spec).toMatch(/^(@chatwarden\/[a-z-]+@\^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?|react|react-dom)$/);
        }
      }
    }
  });

  it('a version that is not a plain version is refused rather than put on a command line', () => {
    for (const bad of ['', '1.2', 'x', '1.2.3; rm -rf', '$(id)', '1.2.3 && echo', '^1.2.3', '1.2.3\n']) {
      expect(() => buildPlan(answersOf(), { chatwarden: bad }, stubTemplates, PROJECT), JSON.stringify(bad)).toThrow(/version/i);
    }
  });
});

describe('buildPlan: environment, next steps, warnings', () => {
  it('lists environment variable names only, with whether each is required', () => {
    const names = (over: Partial<Answers>) => plan(over).env;
    expect(names({})).toEqual([
      { name: 'CHATWARDEN_SECRET', required: true },
      { name: 'CHATWARDEN_ADMIN_TOKEN', required: true },
      { name: 'CHATWARDEN_DB', required: false },
    ]);
    expect(names({ store: 'memory' }).map((e) => e.name)).not.toContain('CHATWARDEN_DB');
    expect(names({ discord: true }).map((e) => e.name)).toEqual(expect.arrayContaining(['DISCORD_WEBHOOK_URL', 'DISCORD_MENTION_ROLE_ID']));
    expect(names({ discord: true }).find((e) => e.name === 'DISCORD_WEBHOOK_URL')?.required).toBe(true);
    expect(names({ discord: true }).find((e) => e.name === 'DISCORD_MENTION_ROLE_ID')?.required).toBe(false);
    for (const framework of ['next', 'fetch'] as const) expect(names({ framework, hub: 'none' }).map((e) => e.name)).toContain('CHATWARDEN_TRUST_PROXY');
    for (const framework of ['express', 'fastify'] as const) expect(names({ framework }).map((e) => e.name)).not.toContain('CHATWARDEN_TRUST_PROXY');
    // Library only has no staff routes, so no token.
    expect(names({ framework: 'none', hub: 'none' }).map((e) => e.name)).not.toContain('CHATWARDEN_ADMIN_TOKEN');
    expect(names({ framework: 'none', hub: 'none' }).map((e) => e.name)).toContain('CHATWARDEN_SECRET');
    for (const e of names({ discord: true })) expect(Object.keys(e).sort()).toEqual(['name', 'required']);
  });

  it('the next steps are four lines in a fixed order: install, the entry line, the two variables, the URL', () => {
    for (const framework of ['express', 'fastify', 'next', 'fetch'] as const) {
      const built = plan({ framework, hub: framework === 'next' ? 'react' : 'element' });
      expect(built.nextSteps, framework).toHaveLength(4);
      expect(built.nextSteps[0]).toContain(built.install.command);
      expect(built.nextSteps[2]).toContain('CHATWARDEN_SECRET');
      expect(built.nextSteps[2]).toContain('CHATWARDEN_ADMIN_TOKEN');
      expect(built.nextSteps[2]).toContain("randomBytes(32).toString('hex')");
      expect(built.nextSteps[3]).toContain('/chatwarden/mod');
    }
    expect(plan({ framework: 'express' }).nextSteps[1]).toContain('mountChatwarden');
    expect(plan({ framework: 'fastify' }).nextSteps[1]).toContain('mountChatwarden');
    expect(plan({ framework: 'next', hub: 'react' }).nextSteps[1]).toMatch(/route/i);
    expect(plan({ framework: 'fetch' }).nextSteps[1]).toContain('handler');
  });

  it('the entry line names the folder the files were written to, with / separators', () => {
    expect(plan({ framework: 'express', dir: 'lib/vlemmo' }).nextSteps[1]).toContain('lib/vlemmo');
    expect(plan({ framework: 'express', dir: 'lib/vlemmo' }).nextSteps[1]).not.toContain('\\');
  });

  it('the URL follows the base, and falls back to the health route with no hub', () => {
    expect(plan({ base: '/tarvo' }).nextSteps[3]).toContain('/tarvo/mod');
    expect(plan({ hub: 'none' }).nextSteps[3]).toContain('/chatwarden/healthz');
  });

  it('library only has no URL and no admin token; its steps point at the check to call', () => {
    const built = plan({ framework: 'none', hub: 'none', chat: 'none' });
    expect(built.nextSteps).toHaveLength(4);
    expect(built.nextSteps[1]).toMatch(/createKit/);
    expect(built.nextSteps[2]).toContain('CHATWARDEN_SECRET');
    expect(built.nextSteps[2]).not.toContain('CHATWARDEN_ADMIN_TOKEN');
    expect(built.nextSteps[3]).not.toContain('http');
    expect(built.nextSteps[3]).toMatch(/chat handler/);
  });

  it('warns that the box is a React component when React is not in the project', () => {
    expect(plan({ chat: 'box' }, { manager: 'npm', react: false }).warnings.join(' ')).toMatch(/React/);
    expect(plan({ chat: 'box' }, { manager: 'npm', react: true }).warnings).toEqual([]);
    expect(plan({ chat: 'none' }, { manager: 'npm', react: false }).warnings).toEqual([]);
  });

  it('no next step, warning or command carries an absolute path, a drive letter or a backslash', () => {
    for (const answers of allAnswers()) {
      const built = buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
      for (const line of [...built.nextSteps, ...built.warnings, built.install.command]) {
        expect(line).not.toMatch(/[A-Za-z]:\\|\\|^\/(Users|home)/);
      }
    }
  });
});

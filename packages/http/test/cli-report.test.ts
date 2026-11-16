import { describe, expect, it } from 'vitest';
import { applyPlan } from '../src/cli/apply.js';
import type { Result } from '../src/cli/apply.js';
import { buildPlan } from '../src/cli/plan.js';
import { emitReport, renderHuman, renderJson } from '../src/cli/report.js';
import type { Answers, Plan } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';
import type { PathKind, World } from './cli-world.js';
import { PROJECT, VERSIONS, answersOf, stubTemplates } from './cli-stubs.js';

const SECRET_VALUE = 'zQ9xLmN2pR7vT4wY8bC1dF6gH3jK5sA0';

async function run(world: World, answers: Answers, over: { onConflict?: 'skip' | 'overwrite' | 'new'; dryRun?: boolean; plan?: Plan } = {}): Promise<{ plan: Plan; result: Result }> {
  const plan = over.plan ?? buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
  const result = await applyPlan(world.env, plan, { onConflict: over.onConflict ?? 'skip', dryRun: over.dryRun ?? false });
  return { plan, result };
}
/** A world with one file created, one unchanged, one skipped. */
async function mixed(kind: PathKind = 'posix'): Promise<{ world: World; plan: Plan; result: Result }> {
  const answers = answersOf();
  const plan = buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
  const world = createWorld({
    kind,
    files: { 'package.json': '{}', 'src/chatwarden/auth.ts': 'mine\n', 'src/chatwarden/terms.ts': plan.files.find((f) => f.path.endsWith('terms.ts'))!.content },
    env: { CHATWARDEN_SECRET: SECRET_VALUE, CHATWARDEN_ADMIN_TOKEN: `${SECRET_VALUE}${SECRET_VALUE}` },
  });
  const { result } = await run(world, answers, { plan });
  return { world, plan, result };
}

describe.each(['posix', 'win32'] as const)('renderHuman (%s)', (kind: PathKind) => {
  it('lists created, unchanged, skipped with a reason, and the next steps in the fixed order', async () => {
    const { plan, result } = await mixed(kind);
    const text = renderHuman(plan, result);
    const at = (needle: string): number => {
      const index = text.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('Created')).toBeLessThan(at('Unchanged'));
    expect(at('Unchanged')).toBeLessThan(at('Skipped'));
    expect(at('Skipped')).toBeLessThan(at('Next steps'));
    expect(text).toMatch(/Created[\s\S]*src\/chatwarden\/kit\.ts/);
    expect(text).toMatch(/Unchanged[\s\S]*src\/chatwarden\/terms\.ts/);
    const skipped = text.slice(at('Skipped'), at('Next steps'));
    expect(skipped).toContain('src/chatwarden/auth.ts');
    expect(skipped).toMatch(/differs/);
    expect(skipped).toContain('--on-conflict new');
    // Next steps are numbered, in the plan's order.
    const steps = text.slice(at('Next steps'));
    plan.nextSteps.forEach((step, index) => expect(steps).toContain(`${index + 1}. ${step}`));
    const positions = plan.nextSteps.map((step) => steps.indexOf(step));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('is plain text: \\n only, no ANSI, posix separators, no absolute path, deterministic', async () => {
    const { world, plan, result } = await mixed(kind);
    const text = renderHuman(plan, result);
    expect(text.includes('\r')).toBe(false);
    expect(text.includes('\u001b')).toBe(false);
    expect(text).not.toContain('\\');
    expect(text).not.toContain(world.root);
    expect(text).not.toContain(SECRET_VALUE);
    expect(text.endsWith('\n')).toBe(true);
    expect(renderHuman(plan, result)).toBe(text);
  });

  it('shows what each other outcome means: overwritten, written beside, and an error', async () => {
    const answers = answersOf();
    const world = createWorld({ kind, files: { 'package.json': '{}', 'src/chatwarden/auth.ts': 'mine\n', 'src/chatwarden/kit.ts': 'mine\n' } });
    const plan = buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
    const ask = async (info: { path: string }) => (info.path.endsWith('auth.ts') ? ('overwrite' as const) : ('new' as const));
    const result = await applyPlan(world.env, plan, { onConflict: 'skip', dryRun: false, ask });
    const text = renderHuman(plan, result);
    expect(text).toMatch(/Overwritten[\s\S]*src\/chatwarden\/auth\.ts/);
    expect(text).toMatch(/Written beside[\s\S]*src\/chatwarden\/kit\.ts[\s\S]*src\/chatwarden\/kit\.chatwarden-new\.ts/);

    const failing = createWorld({ kind, failOn: (op) => (op.op === 'writeFile' ? Object.assign(new Error('x'), { code: 'EACCES' }) : undefined) });
    const failed = await applyPlan(failing.env, plan, { onConflict: 'skip', dryRun: false });
    const errorText = renderHuman(plan, failed);
    expect(errorText).toMatch(/Could not write/);
    expect(errorText).toContain(failed.error!.path!);
    expect(errorText).not.toContain(failing.root);
  });

  it('a dry run says nothing was written and uses the conditional wording', async () => {
    const world = createWorld({ kind, files: { 'package.json': '{}' } });
    const { plan, result } = await run(world, answersOf(), { dryRun: true });
    const text = renderHuman(plan, result);
    expect(text).toMatch(/Dry run: nothing was written/);
    expect(text).toMatch(/Would create/);
    expect(text).not.toMatch(/^Created/m);
    expect(world.writes()).toEqual([]);
  });

  it('lists the starter code left to replace, with file, line and marker', async () => {
    const { plan, result } = await mixed(kind);
    const text = renderHuman(plan, result);
    expect(text).toMatch(/Starter code to replace/);
    expect(text).toContain('src/chatwarden/auth.ts:2 TODO(auth)');
    expect(text).toContain('src/chatwarden/terms.ts:1 TODO(terms)');
  });

  it('prints the warnings, and the hook for your own chat when the box is not added', async () => {
    const answers = answersOf({ chat: 'none' });
    const world = createWorld({ kind, files: { 'package.json': '{}' } });
    const { plan, result } = await run(world, answers);
    const withHook = renderHuman(plan, result);
    expect(withHook).toContain('kit.cw.chat.accept(roomId, seatId, text)');
    expect(withHook).toContain("'refuse' in r");
    expect(withHook).toContain('kit.cw.rooms.seat(');
    expect(withHook.indexOf('kit.cw.chat.accept')).toBeGreaterThan(withHook.indexOf('Next steps'));

    const boxPlan = buildPlan(answersOf({ chat: 'box' }), VERSIONS, stubTemplates, { manager: 'npm', react: false });
    const boxWorld = createWorld({ kind, files: { 'package.json': '{}' } });
    const boxResult = await applyPlan(boxWorld.env, boxPlan, { onConflict: 'skip', dryRun: false });
    const boxText = renderHuman(boxPlan, boxResult);
    expect(boxText).not.toContain('kit.cw.chat.accept');
    expect(boxText).toMatch(/Warnings[\s\S]*React/);
  });

  it('leaves out the install step when the install already ran', async () => {
    const { plan, result } = await mixed(kind);
    const text = renderHuman(plan, { ...result, install: { ran: true } });
    expect(text).not.toContain(plan.install.command);
    expect(text).toMatch(/Installed with npm/);
    expect(text).toMatch(/Next steps\n\s+1\. /);
    expect(text).toContain(plan.nextSteps[1]!);
  });

  it('a failed install prints the command to run by hand', async () => {
    const { plan, result } = await mixed(kind);
    const text = renderHuman(plan, { ...result, install: { ran: false, failed: true } });
    expect(text).toMatch(/install did not finish/i);
    expect(text).toContain(plan.install.command);
  });
});

describe('renderJson', () => {
  it('json: version 1, every file with its action, no content, no absolute path, no secret value, env names only', async () => {
    const { world, plan, result } = await mixed();
    const text = renderJson(plan, result, '0.1.99');
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc.version).toBe(1);
    expect(doc.chatwarden).toBe('0.1.99');
    expect(doc.ok).toBe(true);
    expect(doc.answers).toEqual(plan.answers);
    expect(doc.files).toEqual([
      { path: 'src/chatwarden/.env.example', action: 'created' },
      { path: 'src/chatwarden/auth.ts', action: 'skipped', reason: 'differs' },
      { path: 'src/chatwarden/kit.ts', action: 'created' },
      { path: 'src/chatwarden/terms.ts', action: 'unchanged' },
    ]);
    expect(doc.install).toEqual({ manager: 'npm', command: plan.install.command, ran: false });
    expect(doc.env).toEqual([{ name: 'CHATWARDEN_SECRET', required: true }, { name: 'CHATWARDEN_ADMIN_TOKEN', required: true }, { name: 'CHATWARDEN_DB', required: false }]);
    expect(doc.todo).toEqual(plan.todo);
    expect(doc.nextSteps).toEqual(plan.nextSteps);
    expect(doc.warnings).toEqual(plan.warnings);
    // The document never holds a file's text, a secret value or the project's absolute path.
    expect(text).not.toContain(SECRET_VALUE);
    expect(text).not.toContain(world.root);
    for (const file of plan.files) {
      const line = file.content.split('\n').find((l) => l.length > 12);
      if (line) expect(text, file.path).not.toContain(JSON.stringify(line).slice(1, -1));
    }
    const keys = new Set<string>();
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); }
    };
    walk(doc);
    expect(keys.has('content')).toBe(false);
    expect(keys.has('value')).toBe(false);
    expect(text).not.toMatch(/[A-Za-z]:\\\\/);
  });

  it('is exactly one document: parseable whole, two-space indented, one trailing newline, keys in a fixed order', async () => {
    const { plan, result } = await mixed();
    const text = renderJson(plan, result, '0.1.99');
    expect(text.endsWith('}\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
    expect(() => JSON.parse(text)).not.toThrow();
    expect(text.split('\n')[1]).toMatch(/^ {2}"version": 1,$/);
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'chatwarden', 'ok', 'dryRun', 'answers', 'files', 'install', 'env', 'todo', 'nextSteps', 'warnings']);
    expect(renderJson(plan, result, '0.1.99')).toBe(text);
  });

  it('carries the file written beside, an install that ran, and an error with no absolute path', async () => {
    const answers = answersOf();
    const plan = buildPlan(answers, VERSIONS, stubTemplates, PROJECT);
    const world = createWorld({ files: { 'package.json': '{}', 'src/chatwarden/kit.ts': 'mine\n' } });
    const result = await applyPlan(world.env, plan, { onConflict: 'new', dryRun: false });
    const doc = JSON.parse(renderJson(plan, { ...result, install: { ran: true } }, '1.0.0')) as { files: Array<Record<string, string>>; install: { ran: boolean } };
    expect(doc.files.find((f) => f.path === 'src/chatwarden/kit.ts')).toEqual({ path: 'src/chatwarden/kit.ts', action: 'created-new', reason: 'differs', writtenTo: 'src/chatwarden/kit.chatwarden-new.ts' });
    expect(doc.install.ran).toBe(true);

    const failing = createWorld({ failOn: (op) => (op.op === 'mkdir' ? Object.assign(new Error(`EACCES ${'/proj'}`), { code: 'EACCES' }) : undefined) });
    const failed = await applyPlan(failing.env, plan, { onConflict: 'skip', dryRun: false });
    const failedText = renderJson(plan, failed, '1.0.0');
    const failedDoc = JSON.parse(failedText) as { ok: boolean; error: { kind: string; path: string; message: string } };
    expect(failedDoc.ok).toBe(false);
    expect(failedDoc.error.kind).toBe('io');
    expect(failedDoc.error.path).toBe('src/chatwarden/.env.example');
    expect(failedText).not.toContain(failing.root);
  });

  it('a dry run is flagged and every file carries the action it would have', async () => {
    const world = createWorld({ files: { 'package.json': '{}' } });
    const { plan, result } = await run(world, answersOf(), { dryRun: true });
    const doc = JSON.parse(renderJson(plan, result, '1.0.0')) as { dryRun: boolean; files: Array<{ action: string }> };
    expect(doc.dryRun).toBe(true);
    expect(doc.files.every((f) => f.action === 'created')).toBe(true);
  });
});

describe('emitReport', () => {
  it('--json writes only the document to stdout, and nothing to stderr', async () => {
    const { world, plan, result } = await mixed();
    emitReport(world.env, plan, result, { json: true, version: '0.1.99' });
    expect(() => JSON.parse(world.out())).not.toThrow();
    expect(world.out()).toBe(renderJson(plan, result, '0.1.99'));
    expect(world.err()).toBe('');
  });

  it('without --json writes the human report to stdout and nothing to stderr', async () => {
    const { world, plan, result } = await mixed();
    emitReport(world.env, plan, result, { json: false, version: '0.1.99' });
    expect(world.out()).toBe(renderHuman(plan, result));
    expect(world.err()).toBe('');
  });
});

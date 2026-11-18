// `runCli` (design 5): parse, detect, resolve the answers (asking only what is neither given nor detected), plan, apply, report, and the exit code. It
// takes the whole machine as an argument (`CliEnv`), so the tests run it over an in-memory file system with `path.win32` and a fake terminal.
// `@chatwarden/http/cli`, so a `create-chatwarden` shim is three lines.
import { VERSION } from '../version.js';
import { canPrompt, isAsked, resolveAnswers } from './answers.js';
import type { QuestionName } from './answers.js';
import { applyPlan, exitCodeOf } from './apply.js';
import { OPTIONS, helpText, parseCli, serveHelpText } from './args.js';
import type { Parsed } from './args.js';
import { checkProject, renderCheck, renderCheckJson } from './check.js';
import { createConflictAsker } from './conflict.js';
import { detect } from './detect.js';
import { nodeEnv } from './env.js';
import type { CliEnv } from './env.js';
import { installCommand, nodeSpawner, runInstall } from './install.js';
import { runServe } from './serve.js';
import type { ServeOverrides } from './serve.js';
import { runServiceInit } from './service.js';
import { buildPlan } from './plan.js';
import { createPrompter } from './prompts.js';
import type { Prompter, Question } from './prompts.js';
import { emitReport } from './report.js';
import { renderAll } from './templates/index.js';
import type { CtxOptions } from './templates/index.js';
import type { Answers, Detected, FileSpec, Versions } from './types.js';

export type { CliEnv } from './env.js';

export interface RunOptions {
  /** Replaces what `chatwarden serve` reads from the machine (the importer, the log, the signals). For tests only. @internal */
  serve?: ServeOverrides;
  /** Replaces the templates. For tests only. @internal */
  render?: (answers: Answers, versions: Versions, options: CtxOptions) => FileSpec[];
}

/** The questions, in the order they are put (design 5.1). */
const QUESTIONS: readonly QuestionName[] = ['framework', 'store', 'chat', 'chatTransport', 'hub', 'discord', 'profile'];

/** The answers a person already gave: the flags, then the replies so far. */
function givenOf(parsed: Parsed): Partial<Answers> {
  const given: Partial<Answers> = {};
  for (const name of QUESTIONS) {
    const value = parsed[name];
    if (value !== undefined) (given as Record<string, unknown>)[name] = value;
  }
  return given;
}

const optionFor = (name: QuestionName) => OPTIONS.find((option) => option.key === name);

function questionFor(name: QuestionName, number: number, current: Answers): Question {
  const option = optionFor(name);
  const text = option?.question ?? name;
  if (name === 'discord') return { number, text, choices: ['y', 'n'], default: current.discord ? 'y' : 'n', yesNo: true };
  return { number, text, choices: option?.values ?? [], default: String(current[name]) };
}

/** Put the questions a terminal run asks, in order, and fold each reply into `parsed`. Returns an error sentence when a reply makes the answers illegal. */
async function interview(prompter: Prompter, parsed: Parsed, detected: Detected, env: CliEnv): Promise<string | undefined> {
  const first = resolveAnswers(parsed, detected);
  if ('error' in first) return first.error;
  env.stdout.write(`Chatwarden init. This writes new files into ./${first.dir} and touches nothing else.\n\n`);
  let number = 0;
  for (const name of QUESTIONS) {
    if (!isAsked(name, givenOf(parsed), detected)) continue;
    const current = resolveAnswers(parsed, detected);
    if ('error' in current) return current.error;
    number += 1;
    const reply = await prompter.ask(questionFor(name, number, current));
    (parsed as unknown as Record<string, unknown>)[name] = name === 'discord' ? reply === 'y' : reply;
  }
  env.stdout.write('\n');
  return undefined;
}

/** The class of an error, and nothing else of it: its message may hold a path or a value. */
function classOf(error: unknown): string {
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(name) ? name : 'Error';
}

async function run(argv: readonly string[], env: CliEnv, options: RunOptions): Promise<number> {
  const usage = (message: string): number => {
    env.stderr.write(`chatwarden: ${message}\n`);
    return 1;
  };

  const parsed = parseCli(argv);
  if ('error' in parsed) return usage(parsed.error);
  if (parsed.command === 'help') {
    env.stdout.write(helpText());
    return 0;
  }
  if (parsed.command === 'version') {
    env.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (parsed.command === 'serveHelp') {
    env.stdout.write(serveHelpText());
    return 0;
  }
  if (parsed.command === 'serve') return runServe(parsed.serve ?? { printOpenapi: false }, env, options.serve);
  // `init --service` writes a folder that needs no project: nothing is detected and nothing is asked.
  if (parsed.service === true) return runServiceInit(parsed, env, VERSION);

  const detected = await detect(env);
  if ('error' in detected) return usage(detected.error);

  if (parsed.check) {
    const answers = resolveAnswers(parsed, detected);
    if ('error' in answers) return usage(answers.error);
    const result = await checkProject(env, answers);
    env.stdout.write(parsed.json ? renderCheckJson(result, VERSION) : renderCheck(result));
    return result.ok ? 0 : 1;
  }

  // The flags and what was detected have to make legal answers before anything is said or asked.
  const initial = resolveAnswers(parsed, detected);
  if ('error' in initial) return usage(initial.error);

  // A terminal run asks; --yes, --json and a run whose input is not a terminal never do, and neither does a dry run.
  const asking = canPrompt(parsed, env.isTTY) && !parsed.dryRun;
  if (!env.isTTY && !parsed.yes && !parsed.json) env.stderr.write('chatwarden: stdin is not a terminal: using detected answers.\n');

  const prompter = asking ? createPrompter(env) : undefined;
  try {
    if (prompter !== undefined) {
      const failure = await interview(prompter, parsed, detected, env);
      if (failure !== undefined) return usage(failure);
    }
    const answers = resolveAnswers(parsed, detected);
    if ('error' in answers) return usage(answers.error);

    const render = options.render ?? renderAll;
    const versions: Versions = { chatwarden: VERSION };
    const project = { manager: detected.manager, react: detected.react, srcDir: detected.srcDir, appDir: detected.appDir, moduleType: detected.moduleType, platform: env.platform };
    const plan = buildPlan(answers, versions, (a, v) => render(a, v, { moduleType: detected.moduleType, layout: { srcDir: detected.srcDir, appDir: detected.appDir } }), project);

    const ask = prompter === undefined ? undefined : createConflictAsker({ readLine: prompter.readLine, write: (text) => void env.stderr.write(text) });
    const result = await applyPlan(env, plan, { onConflict: parsed.onConflict, dryRun: parsed.dryRun, ...(ask === undefined ? {} : { ask }) });

    if (parsed.install && !parsed.dryRun && result.error === undefined) {
      const code = await runInstall(env, installCommand(plan.install.manager, plan.install.packages, env));
      result.install = code === 0 ? { ran: true } : { ran: false, failed: true };
    }
    emitReport(env, plan, result, { json: parsed.json, version: VERSION });
    return exitCodeOf(result);
  } finally {
    prompter?.close();
  }
}

/**
 * Run `chatwarden` with the arguments after the program name (`['init', '--yes']`) and resolve its exit code (design 5.6). Never throws: an
 * unexpected failure is exit 3 with one line that names the error class and nothing of its message.
 */
export async function runCli(argv: readonly string[], env: CliEnv = nodeEnv(nodeSpawner), options: RunOptions = {}): Promise<number> {
  try {
    return await run(argv, env, options);
  } catch (error) {
    env.stderr.write(`chatwarden: something went wrong (${classOf(error)}).\n`);
    return 3;
  }
}

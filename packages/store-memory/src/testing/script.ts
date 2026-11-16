// A script is data: a list of steps that reads as a specification, can be kept in a table and shared between tests. `play` runs it against a kit and
// `expectOutcomes` compares what happened with what was expected, throwing a plain error that any test runner shows.
import type { ConductLevel, KitEvent, RuleRef, Suggestion } from '@chatwarden/core';
import type { Duration } from './duration.js';
import type { ReportLabel, ReportOutcome, SayLabel, SayOutcome, TestRoom } from './room.js';

/**
 * One step of a script.
 * @experimental
 */
export type Step =
  | { player: string; say: string; expect?: SayLabel | readonly SayLabel[] }
  | { player: string; report: string; reason?: string; note?: string; expect?: ReportLabel }
  | { player: string; mute: string; on?: boolean }
  | { wait: Duration }
  /** Compares `Suggestion.label` for this player now, e.g. `'Warning'`. */
  | { suggest: string; level: ConductLevel | null; rule?: RuleRef; expect: string };

/**
 * What a script did.
 * @experimental
 */
export interface Run {
  readonly steps: ReadonlyArray<SayOutcome | ReportOutcome | { kind: 'wait'; at: number } | { kind: 'mute'; at: number } | { kind: 'suggest'; at: number; suggestion: Suggestion }>;
  /** The labels of the say and report steps, in order: the thing to assert on in any runner. */
  readonly outcomes: readonly string[];
  /** The kit events that happened while the script ran. */
  readonly events: readonly KitEvent[];
}

/**
 * Thrown when a script's outcomes are not the expected ones. A plain `Error` with a table of expected and actual per step, so it reads the same in
 * any test runner.
 * @experimental
 */
export class ScriptMismatch extends Error {
  /** The 1-based number of the first step or outcome that differs, or 0 when the lengths differ. */
  readonly step: number;
  readonly expected: string;
  readonly actual: string;

  constructor(message: string, details: { step: number; expected: string; actual: string }) {
    super(message);
    this.name = 'ScriptMismatch';
    this.step = details.step;
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

/** What a kit gives `play`: only these. */
export interface Playground {
  room(id?: string): TestRoom;
  clock: { advance(by: Duration): number; now(): number };
  readonly events: readonly KitEvent[];
  suggest(player: string, level: ConductLevel | null, rule?: RuleRef, room?: string): Suggestion;
}

const SHORT = 40;
const short = (text: string): string => (text.length > SHORT ? `${text.slice(0, SHORT - 3)}...` : text);
const quoted = (text: string): string => JSON.stringify(short(text));

function describeStep(step: Step): string {
  if ('say' in step) return `${step.player} says ${quoted(step.say)}`;
  if ('report' in step) return `${step.player} reports ${step.report}`;
  if ('mute' in step) return `${step.player} ${step.on === false ? 'unmutes' : 'mutes'} ${step.mute}`;
  if ('wait' in step) return `wait ${String(step.wait)}`;
  return `suggest for ${step.suggest} at ${String(step.level)}`;
}

function expectedOf(step: Step): readonly string[] | undefined {
  if ('say' in step || 'report' in step) {
    const wanted = step.expect;
    if (wanted === undefined) return undefined;
    return typeof wanted === 'string' ? [wanted] : wanted;
  }
  if ('suggest' in step) return [step.expect];
  return undefined;
}

function table(rows: ReadonlyArray<{ number: number; text: string; expected: string; actual: string }>): string {
  const widths = [3, 'step'.length, 'expected'.length].map((min, column) => Math.max(min, ...rows.map((row) => [String(row.number), row.text, row.expected][column]!.length)));
  const line = (a: string, b: string, c: string, d: string): string => `${a.padStart(widths[0]!)}  ${b.padEnd(widths[1]!)}  ${c.padEnd(widths[2]!)}  ${d}`;
  return [line('#', 'step', 'expected', 'actual'), ...rows.map((row) => line(String(row.number), row.text, row.expected, row.actual))].join('\n');
}

/** Run the steps in order against the kit. Throws a `ScriptMismatch` at the first step whose `expect` is not met. */
export async function runScript(kit: Playground, steps: readonly Step[], options: { room?: string } = {}): Promise<Run> {
  const room = kit.room(options.room);
  const firstEvent = kit.events.length;
  const done: Array<Run['steps'][number]> = [];
  const outcomes: string[] = [];
  const actuals: string[] = steps.map(() => '(not run)');

  const mismatch = (index: number, wanted: readonly string[], actual: string): never => {
    const rows = steps.map((step, i) => ({ number: i + 1, text: describeStep(step), expected: expectedOf(step)?.join(' or ') ?? '-', actual: i === index ? `${actual}  <-- differs` : (actuals[i] as string) }));
    const expected = wanted.join(' or ');
    throw new ScriptMismatch(`Script mismatch at step ${index + 1} (${describeStep(steps[index] as Step)}): expected ${expected}, got ${actual}.\n${table(rows)}`, { step: index + 1, expected, actual });
  };

  for (const [index, step] of steps.entries()) {
    if (typeof step !== 'object' || step === null) throw new TypeError(`Script step ${index + 1} is not an object.`);
    if ('say' in step) {
      const outcome = room.say(step.player, step.say);
      done.push(outcome);
      outcomes.push(outcome.label);
      actuals[index] = outcome.label;
      const wanted = expectedOf(step);
      if (wanted !== undefined && !wanted.includes(outcome.label)) mismatch(index, wanted, outcome.label);
    } else if ('report' in step) {
      const outcome = await room.report(step.player, step.report, {
        ...(step.reason === undefined ? {} : { reason: step.reason }),
        ...(step.note === undefined ? {} : { note: step.note }),
      });
      done.push(outcome);
      outcomes.push(outcome.label);
      actuals[index] = outcome.label;
      const wanted = expectedOf(step);
      if (wanted !== undefined && !wanted.includes(outcome.label)) mismatch(index, wanted, outcome.label);
    } else if ('mute' in step) {
      room.mute(step.player, step.mute, step.on ?? true);
      done.push({ kind: 'mute', at: kit.clock.now() });
      actuals[index] = 'done';
    } else if ('wait' in step) {
      kit.clock.advance(step.wait);
      done.push({ kind: 'wait', at: kit.clock.now() });
      actuals[index] = 'done';
    } else if ('suggest' in step) {
      const suggestion = kit.suggest(step.suggest, step.level, step.rule, room.id);
      done.push({ kind: 'suggest', at: kit.clock.now(), suggestion });
      actuals[index] = suggestion.label;
      if (suggestion.label !== step.expect) mismatch(index, [step.expect], suggestion.label);
    } else {
      throw new TypeError(`Script step ${index + 1} is not a say, report, mute, wait or suggest step.`);
    }
  }
  return { steps: done, outcomes, events: kit.events.slice(firstEvent) };
}

/**
 * Compare a run's say and report outcomes with the expected labels, as a whole. Throws a `ScriptMismatch` that names the first difference, or the two lengths
 * when they differ. Runner-neutral: nothing here imports a test runner.
 * @experimental
 */
export function expectOutcomes(run: Run, expected: readonly string[]): void {
  const actual = run.outcomes;
  const listing = (): string => `expected: ${expected.join(', ') || '(none)'}\n  actual: ${actual.join(', ') || '(none)'}`;
  if (actual.length !== expected.length) {
    throw new ScriptMismatch(`The run has ${actual.length} outcomes, expected ${expected.length}.\n${listing()}`, { step: 0, expected: String(expected.length), actual: String(actual.length) });
  }
  const index = actual.findIndex((label, i) => label !== expected[i]);
  if (index === -1) return;
  throw new ScriptMismatch(`Script outcomes differ: outcome ${index + 1}: expected ${expected[index]}, got ${actual[index]}.\n${listing()}`, {
    step: index + 1,
    expected: expected[index] as string,
    actual: actual[index] as string,
  });
}


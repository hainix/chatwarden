// The interactive questions (design 5.1 and 5.8), over `node:readline/promises`: this is the one file that imports readline. Every question shows its
// choices and its default, and Enter takes the default. Nothing here can hang or garble a terminal: input that ends answers every later question with its
// default, the interface is never put in raw mode (no key handling, no escape sequences are written), and one reader is shared by the whole run so a line
// that arrived early is not lost between questions.
import { createInterface } from 'node:readline/promises';
import { show } from './args.js';
import type { CliEnv } from './env.js';

export interface Question {
  /** Printed first (`1.`). Left out of a one-off question. */
  number?: number;
  text: string;
  choices: readonly string[];
  /** One of the choices; what Enter, a second wrong answer and the end of input give. */
  default: string;
  /** A yes or no question: `y`, `yes`, `n` and `no` are accepted and the answer is `y` or `n`. */
  yesNo?: boolean;
}

export interface Prompter {
  /** Ask one question and resolve the answer (one of its choices; never anything else). Never rejects, never waits on ended input. */
  ask(question: Question): Promise<string>;
  /** The next line of input, or `undefined` once it has ended. Shared with the conflict question. */
  readLine(): Promise<string | undefined>;
  /** Release stdin so the process can end. */
  close(): void;
}

const YES = new Set(['y', 'yes']);
const NO = new Set(['n', 'no']);

export function createPrompter(env: CliEnv): Prompter {
  let reader: ReturnType<typeof createInterface> | undefined;
  const queue: string[] = [];
  const waiting: Array<(line: string | undefined) => void> = [];
  let ended = false;
  let said = false;

  const start = (): void => {
    if (reader !== undefined) return;
    // terminal: false is deliberate: no raw mode and no escape sequences, on a terminal too (it keeps its own line editing).
    reader = createInterface({ input: env.stdin, terminal: false, crlfDelay: Infinity });
    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next === undefined) queue.push(line);
      else next(line);
    });
    reader.on('close', () => {
      ended = true;
      for (const next of waiting.splice(0)) next(undefined);
    });
    env.stdin.once('error', () => reader?.close());
  };

  const readLine = (): Promise<string | undefined> => {
    start();
    const queued = queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (ended) return Promise.resolve(undefined);
    return new Promise((resolve) => void waiting.push(resolve));
  };

  const prompt = (q: Question): string => `${q.number === undefined ? '' : `${q.number}. `}${q.text} [${q.choices.join('/')}] (${q.default}) > `;

  const parse = (q: Question, typed: string): string | undefined => {
    const value = typed.trim().toLowerCase();
    if (q.yesNo === true) return YES.has(value) ? 'y' : NO.has(value) ? 'n' : undefined;
    return q.choices.find((choice) => choice === value);
  };

  const ask = async (q: Question): Promise<string> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (ended && queue.length === 0) break;
      env.stdout.write(prompt(q));
      const line = await readLine();
      if (line === undefined) break;
      if (line.trim() === '') return q.default;
      const answer = parse(q, line);
      if (answer !== undefined) return answer;
      const choices = q.choices.join(', ');
      env.stderr.write(`chatwarden: "${show(line.trim())}" is not one of ${choices}. ${attempt === 0 ? 'Asking once more.' : `Using ${q.default}.`}\n`);
    }
    if (ended && !said) {
      said = true;
      env.stdout.write('\n');
      env.stderr.write('chatwarden: input ended: using the defaults for the rest.\n');
    }
    return q.default;
  };

  return { ask, readLine, close: () => reader?.close() };
}

/** One question over a prompter of its own (the rest of the input is dropped). A run with several questions shares one `createPrompter`. */
export async function ask(env: CliEnv, question: Question): Promise<string> {
  const prompter = createPrompter(env);
  try {
    return await prompter.ask(question);
  } finally {
    prompter.close();
  }
}

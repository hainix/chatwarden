import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ask, createPrompter } from '../src/cli/prompts.js';
import type { Question } from '../src/cli/prompts.js';
import { createWorld } from './cli-world.js';

const FRAMEWORK: Question = { number: 1, text: 'Which server framework?', choices: ['express', 'fastify', 'next', 'fetch', 'none'], default: 'express' };
const STORE: Question = { number: 2, text: 'Where should it keep moderation data?', choices: ['sqlite', 'memory'], default: 'sqlite' };
const CHAT: Question = { number: 3, text: 'Do you already have chat?', choices: ['none', 'box'], default: 'none' };
const DISCORD: Question = { number: 4, text: 'Post reports to a Discord forum?', choices: ['y', 'n'], default: 'n', yesNo: true };

const world = (stdin: string) => createWorld({ stdin, isTTY: true });

describe('questions', () => {
  it('each question shows its choices and default; Enter takes the default', async () => {
    const w = world('\n');
    expect(await ask(w.env, FRAMEWORK)).toBe('express');
    expect(w.out()).toBe('1. Which server framework? [express/fastify/next/fetch/none] (express) > ');
    expect(w.err()).toBe('');
  });

  it('a typed value in the set is taken, in any case and with spaces around it', async () => {
    const w = world('  FastiFy \n');
    expect(await ask(w.env, FRAMEWORK)).toBe('fastify');
  });

  it('a typed value outside the set re-asks once, then takes the default with a stderr line', async () => {
    const w = world('flask\ndjango\n');
    expect(await ask(w.env, FRAMEWORK)).toBe('express');
    expect(w.out().split('> ').length - 1).toBe(2); // asked twice, not three times
    expect(w.err()).toContain('"flask" is not one of express, fastify, next, fetch, none');
    expect(w.err()).toContain('Asking once more');
    expect(w.err()).toContain('"django"');
    expect(w.err()).toContain('Using express');
    // A bad first answer and a good second one is taken.
    const again = world('flask\nnext\n');
    expect(await ask(again.env, FRAMEWORK)).toBe('next');
  });

  it('what the person typed is echoed safely: a control character or ANSI escape in it never reaches the output', async () => {
    const w = world('\u001b[31mred\u001b[0m\nnope\n');
    await ask(w.env, FRAMEWORK);
    expect(w.err()).not.toContain('\u001b');
    expect(w.out()).not.toContain('\u001b');
  });

  it('yes and no: y, yes, n and no, case-insensitively; the default is shown as given', async () => {
    for (const [typed, expected] of [['y', 'y'], ['YES', 'y'], ['n', 'n'], ['No', 'n'], ['', 'n']] as const) {
      expect(await ask(world(`${typed}\n`).env, DISCORD), typed).toBe(expected);
    }
    const w = world('\n');
    await ask(w.env, DISCORD);
    expect(w.out()).toBe('4. Post reports to a Discord forum? [y/n] (n) > ');
  });

  it('a question without a number is printed without one', async () => {
    const w = world('\n');
    await ask(w.env, { text: 'Which standard?', choices: ['relaxed', 'standard', 'strict'], default: 'standard' });
    expect(w.out()).toBe('Which standard? [relaxed/standard/strict] (standard) > ');
  });
});

describe('the end of input', () => {
  it('EOF in the middle of the third question takes the defaults for the rest', async () => {
    const w = world('fastify\nmemory\n');
    const prompter = createPrompter(w.env);
    expect(await prompter.ask(FRAMEWORK)).toBe('fastify');
    expect(await prompter.ask(STORE)).toBe('memory');
    expect(await prompter.ask(CHAT)).toBe('none'); // the input ended here
    expect(await prompter.ask(DISCORD)).toBe('n');
    expect(await prompter.ask(FRAMEWORK)).toBe('express');
    expect(w.err().match(/input ended/g)?.length).toBe(1); // said once, not for every question
    prompter.close();
  });

  it('empty input answers every question with its default and does not wait', async () => {
    const w = world('');
    const prompter = createPrompter(w.env);
    expect(await prompter.ask(FRAMEWORK)).toBe('express');
    expect(await prompter.ask(STORE)).toBe('sqlite');
    prompter.close();
  });

  it('input that never ends is waited for only until the terminal gives a line (a held-open pipe)', async () => {
    const w = createWorld({ isTTY: true });
    const open = new PassThrough();
    w.env.stdin = open;
    const prompter = createPrompter(w.env);
    const answer = prompter.ask(STORE);
    open.write('memory\n');
    expect(await answer).toBe('memory');
    prompter.close();
    open.destroy();
  });

  it('a shared reader keeps the lines of later questions: nothing buffered is lost between questions', async () => {
    const w = world('next\nmemory\nbox\ny\n');
    const prompter = createPrompter(w.env);
    expect([await prompter.ask(FRAMEWORK), await prompter.ask(STORE), await prompter.ask(CHAT), await prompter.ask(DISCORD)]).toEqual(['next', 'memory', 'box', 'y']);
    expect(await prompter.readLine()).toBeUndefined();
    prompter.close();
  });
});

describe('the terminal', () => {
  it('stdin that is not a terminal never waits: the caller does not ask, and a one-shot ask over an ended pipe answers at once', async () => {
    const w = createWorld({ stdin: '', isTTY: false });
    const start = Date.now();
    expect(await ask(w.env, FRAMEWORK)).toBe('express');
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it('no ANSI escape and no raw mode is ever written', async () => {
    const w = world('x\ny\nfastify\n');
    const raw: string[] = [];
    const stdin = w.env.stdin as PassThrough & { setRawMode?: (mode: boolean) => void };
    stdin.setRawMode = (mode) => void raw.push(String(mode));
    const prompter = createPrompter(w.env);
    await prompter.ask(FRAMEWORK);
    await prompter.ask(FRAMEWORK);
    prompter.close();
    expect(raw).toEqual([]);
    for (const escape of [String.fromCharCode(0x1b), String.fromCharCode(0x9b)]) expect(w.out() + w.err()).not.toContain(escape);
  });

  it('close() lets the process end: it releases stdin so nothing keeps the event loop open', async () => {
    const w = world('express\n');
    const stdin = w.env.stdin as PassThrough;
    const prompter = createPrompter(w.env);
    await prompter.ask(FRAMEWORK);
    prompter.close();
    expect(stdin.listenerCount('data') + stdin.listenerCount('readable')).toBe(0);
  });
});

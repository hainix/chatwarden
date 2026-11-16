import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { readHiddenFrom } from '../src/tools/io.js';

// The passphrase prompt: what is typed is not echoed, Enter answers, and Ctrl+C (and a closed input) end it with a refusal instead of hanging.

function rig(): { input: PassThrough; output: PassThrough; shown: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (d: Buffer) => void (text += d.toString()));
  return { input, output, shown: () => text };
}

describe('readHiddenFrom', () => {
  it('answers with the typed line, shows the prompt, and never echoes what was typed', async () => {
    const r = rig();
    const answer = readHiddenFrom('Passphrase: ', r.input, r.output);
    r.input.write('correct horse battery' + String.fromCharCode(13));
    await expect(answer).resolves.toBe('correct horse battery');
    expect(r.shown()).toContain('Passphrase: ');
    expect(r.shown()).not.toContain('correct');
  });

  it('Ctrl+C rejects with a cancellation, at once', async () => {
    const r = rig();
    const answer = readHiddenFrom('Passphrase: ', r.input, r.output);
    r.input.write('abc');
    r.input.write(String.fromCharCode(3));
    await expect(answer).rejects.toThrow('cancelled');
  });

  it('a closed input (Ctrl+D) rejects with no answer', async () => {
    const r = rig();
    const answer = readHiddenFrom('Passphrase: ', r.input, r.output);
    r.input.end();
    await expect(answer).rejects.toThrow();
  });

  it('an empty line is an empty answer (the caller decides what is too short)', async () => {
    const r = rig();
    const answer = readHiddenFrom('Passphrase: ', r.input, r.output);
    r.input.write(String.fromCharCode(13));
    await expect(answer).resolves.toBe('');
  });
});

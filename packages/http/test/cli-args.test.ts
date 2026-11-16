import { describe, expect, it } from 'vitest';
import { OPTIONS, helpText, parseCli } from '../src/cli/args.js';
import type { Parsed } from '../src/cli/args.js';

function ok(argv: string[]): Parsed {
  const parsed = parseCli(argv);
  if ('error' in parsed) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed;
}
function err(argv: string[]): string {
  const parsed = parseCli(argv);
  if (!('error' in parsed)) throw new Error(`expected an error, got ${JSON.stringify(parsed)}`);
  return parsed.error;
}
/** One sentence: no newline, ends with a full stop, nothing that looks like a stack frame. */
function expectOneSentence(message: string): void {
  expect(message).not.toMatch(/\n/);
  expect(message).toMatch(/[.)]$/);
  expect(message).not.toMatch(/\bat .*:\d+/);
  expect(message).not.toMatch(/node:internal|ERR_PARSE_ARGS/);
}

const SAMPLE: Record<string, string> = { base: '/zorbak', dir: 'src/vlemmo' };

describe('parseCli', () => {
  it('every flag in OPTIONS parses and round-trips', () => {
    expect(OPTIONS.length).toBeGreaterThan(15);
    for (const option of OPTIONS) {
      if (option.name === 'help' || option.name === 'version') {
        const viaLong = ok([`--${option.name}`]);
        expect(viaLong.command).toBe(option.name);
        if (option.short) expect(ok([`-${option.short}`]).command).toBe(option.name);
        continue;
      }
      if (option.type === 'string') {
        const samples = option.values ?? [SAMPLE[option.name] ?? 'sample'];
        expect(samples.length).toBeGreaterThan(0);
        for (const value of samples) {
          const parsed = ok(['init', `--${option.name}`, value]);
          expect(parsed[option.key as keyof Parsed], `--${option.name} ${value}`).toBe(value);
          // The inline form is the same flag.
          expect(ok(['init', `--${option.name}=${value}`])[option.key as keyof Parsed]).toBe(value);
        }
      } else {
        const parsed = ok(['init', `--${option.name}`]);
        if (option.name === 'force') {
          expect(parsed.onConflict).toBe('overwrite');
        } else {
          expect(parsed[option.key as keyof Parsed], `--${option.name}`).toBe(true);
        }
        if (option.negatable) expect(ok(['init', `--no-${option.name}`])[option.key as keyof Parsed]).toBe(false);
      }
      if (option.short && option.name !== 'help' && option.name !== 'version') {
        expect(ok(['init', `-${option.short}`])[option.key as keyof Parsed]).toBe(true);
      }
    }
  });

  it('defaults: nothing given means no answer is chosen, onConflict is skip and every switch is off', () => {
    const parsed = ok(['init']);
    expect(parsed).toEqual({ command: 'init', onConflict: 'skip', install: false, dryRun: false, json: false, yes: false, check: false });
    expect(Object.keys(parsed).sort()).toEqual(['check', 'command', 'dryRun', 'install', 'json', 'onConflict', 'yes']);
  });

  it('a full command line parses into the typed fields', () => {
    const parsed = ok([
      'init', '--framework', 'fastify', '--store', 'memory', '--chat', 'box', '--chat-transport', 'socketio', '--hub', 'react',
      '--discord', '--profile', 'strict', '--base', '/tarvo', '--dir', 'src/snerp', '--lang', 'js', '--on-conflict', 'new',
      '--install', '--dry-run', '--json', '--yes', '--check',
    ]);
    expect(parsed).toEqual({
      command: 'init', framework: 'fastify', store: 'memory', chat: 'box', chatTransport: 'socketio', hub: 'react', discord: true,
      profile: 'strict', base: '/tarvo', dir: 'src/snerp', lang: 'js', onConflict: 'new', install: true, dryRun: true, json: true,
      yes: true, check: true,
    });
  });

  it('--no-discord is false and --discord is true; neither leaves it undefined', () => {
    expect(ok(['init', '--no-discord']).discord).toBe(false);
    expect(ok(['init', '--discord']).discord).toBe(true);
    expect(ok(['init']).discord).toBeUndefined();
  });

  it('--force is --on-conflict overwrite; the two agreeing is fine', () => {
    expect(ok(['init', '--force']).onConflict).toBe('overwrite');
    expect(ok(['init', '--force', '--on-conflict', 'overwrite']).onConflict).toBe('overwrite');
    expect(ok(['init', '--on-conflict', 'overwrite', '--force']).onConflict).toBe('overwrite');
  });

  it('an unknown flag, a value outside its set, a repeated singleton, a positional and --on-conflict with --force disagreeing are errors naming the flag', () => {
    const unknown = err(['init', '--bogus']);
    expect(unknown).toContain('--bogus');
    expectOneSentence(unknown);
    expect(err(['init', '--framework', 'x', '--bogus', '-q'])).toMatch(/--bogus|-q|--framework/);
    expect(err(['init', '-q'])).toContain('-q');

    const outside = err(['init', '--framework', 'rails']);
    expect(outside).toContain('--framework');
    expect(outside).toContain('rails');
    for (const allowed of ['express', 'fastify', 'next', 'fetch', 'none']) expect(outside).toContain(allowed);
    expectOneSentence(outside);
    for (const [flag, bad] of [
      ['--store', 'postgres'], ['--chat', 'yes'], ['--chat-transport', 'ws'], ['--hub', 'vue'], ['--profile', 'lax'], ['--lang', 'py'], ['--on-conflict', 'merge'],
    ] as const) {
      const message = err(['init', flag, bad]);
      expect(message, flag).toContain(flag);
      expectOneSentence(message);
    }
    // The value check is exact and case-sensitive; an empty value is outside the set too.
    expect(err(['init', '--framework', 'Express'])).toContain('--framework');
    expect(err(['init', '--framework='])).toContain('--framework');

    const repeated = err(['init', '--store', 'sqlite', '--store', 'memory']);
    expect(repeated).toContain('--store');
    expectOneSentence(repeated);
    expect(err(['init', '--json', '--json'])).toContain('--json');
    expect(err(['init', '--discord', '--no-discord'])).toContain('--discord');
    expect(err(['init', '--base', '/a', '--base', '/b'])).toContain('--base');

    const missing = err(['init', '--framework']);
    expect(missing).toContain('--framework');
    expectOneSentence(missing);
    expect(err(['init', '--base'])).toContain('--base');

    const positional = err(['init', 'extra']);
    expect(positional).toContain('extra');
    expectOneSentence(positional);
    expect(err(['init', '--json', 'extra'])).toContain('extra');

    const unknownCommand = err(['serve']);
    expect(unknownCommand).toContain('serve');
    expectOneSentence(unknownCommand);

    const disagree = err(['init', '--force', '--on-conflict', 'skip']);
    expect(disagree).toContain('--force');
    expect(disagree).toContain('--on-conflict');
    expectOneSentence(disagree);
    expect(err(['init', '--on-conflict', 'new', '--force'])).toContain('--force');
  });

  it('a flag value that is itself flag-shaped is taken as the value or refused, never run as the other flag', () => {
    // parseArgs reads a value that starts with "-" as a missing value, so this is an error naming the flag, not a silent --json.
    const message = err(['init', '--base', '--json']);
    expect(message).toContain('--base');
    expect(ok(['init', '--base=/--json']).base).toBe('/--json');
  });

  it('--help and --version win over everything', () => {
    expect(ok(['--help']).command).toBe('help');
    expect(ok(['-h']).command).toBe('help');
    expect(ok(['--version']).command).toBe('version');
    expect(ok(['-v']).command).toBe('version');
    expect(ok(['init', '--help']).command).toBe('help');
    expect(ok(['--bogus', '--help']).command).toBe('help');
    expect(ok(['init', '--framework', 'rails', '-v']).command).toBe('version');
    expect(ok(['init', 'extra', '--version']).command).toBe('version');
    expect(ok(['init', '--force', '--on-conflict', 'skip', '-h']).command).toBe('help');
    expect(ok(['--help', '--version']).command).toBe('help');
    expect(ok(['--version', '--help']).command).toBe('help');
    expect(ok(['serve', '--help']).command).toBe('help');
  });

  it('no arguments at all is the help', () => {
    expect(ok([]).command).toBe('help');
  });

  it('the command word must come first and be init', () => {
    expect(ok(['init']).command).toBe('init');
    expect(err(['--json', 'init'])).toContain('init');
  });

  it('does not mutate argv', () => {
    const argv = ['init', '--json'];
    ok(argv);
    expect(argv).toEqual(['init', '--json']);
  });
});

describe('OPTIONS', () => {
  it('has unique names and keys, and every option documents itself', () => {
    expect(new Set(OPTIONS.map((o) => o.name)).size).toBe(OPTIONS.length);
    expect(new Set(OPTIONS.map((o) => o.key)).size).toBe(OPTIONS.length);
    for (const option of OPTIONS) {
      expect(option.name).toMatch(/^[a-z][a-z-]*$/);
      expect(option.help.length).toBeGreaterThan(10);
      expect(option.help).not.toMatch(/\n/);
      if (option.type === 'string') expect(option.values === undefined || option.values.length > 0).toBe(true);
      if (option.values && option.default !== undefined) expect(option.values).toContain(option.default);
    }
  });

  it('the seven questions carry their text, in the design order, and nothing else does', () => {
    const asked = OPTIONS.filter((o) => o.question !== undefined).map((o) => o.name);
    expect(asked).toEqual(['framework', 'store', 'chat', 'chat-transport', 'hub', 'discord', 'profile']);
    for (const option of OPTIONS) if (option.question) expect(option.question).toMatch(/\?$/);
  });
});

describe('helpText', () => {
  const text = helpText();
  const lines = text.split('\n');

  it('lists every option once and matches OPTIONS (generated)', () => {
    for (const option of OPTIONS) {
      const definitions = lines.filter((line) => new RegExp(`^\\s+(-\\w, )?--${option.name}(?![\\w-])`).test(line));
      expect(definitions, `--${option.name}`).toHaveLength(1);
      expect(definitions[0]).toContain(option.help);
      if (option.short) expect(definitions[0]).toContain(`-${option.short}, `);
      for (const value of option.values ?? []) expect(definitions[0] + lines.join('\n')).toContain(value);
    }
    // Nothing is listed that OPTIONS does not hold.
    const listed = lines.map((line) => /^\s+(?:-\w, )?--([a-z-]+)/.exec(line)?.[1]).filter((n): n is string => n !== undefined);
    expect(listed.sort()).toEqual(OPTIONS.map((o) => o.name).sort());
  });

  it('shows the usage, the commands and the exit codes, and is plain text', () => {
    expect(text).toContain('chatwarden init [options]');
    expect(text).toContain('chatwarden --help');
    expect(text).toContain('chatwarden --version');
    for (const code of ['0', '1', '2', '3']) expect(text).toMatch(new RegExp(`^\\s+${code}\\s`, 'm'));
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r') || text.includes('\u001b')).toBe(false);
    expect(text).toMatch(/^[\n\x20-\x7e]*$/); // printable ASCII only
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(110);
  });

  it('says --check exits 1 when it finds something left, and still lists check under exit 0 for a clean project', () => {
    const one = lines.find((l) => /^\s+1\s/.test(l)) ?? '';
    expect(one).toMatch(/--check/);
    expect(one).toMatch(/left|found|remain/);
    const zero = lines.find((l) => /^\s+0\s/.test(l)) ?? '';
    expect(zero).toMatch(/check/);
    expect(zero).not.toBe(one);
  });

  it('names the default of an option that has one and the detection of one that has none', () => {
    const store = lines.find((l) => /^\s+--store\b/.test(l)) ?? '';
    expect(store).toContain('sqlite');
    const base = lines.find((l) => /^\s+--base\b/.test(l)) ?? '';
    expect(base).toContain('/chatwarden');
  });

  it('is the same text every time', () => {
    expect(helpText()).toBe(text);
  });
});

import { describe, expect, it } from 'vitest';
import { helpText, parseCli, serveHelpText, SERVE_OPTIONS } from '../src/cli/args.js';
import { ServeError, resolveServeConfig } from '../src/service/serve.js';
import type { ServeFlags } from '../src/cli/args.js';

// S5: the configuration of `chatwarden serve`: flags beat environment beat defaults. The secrets are environment only and are not read here (startService checks them, in order).

const flags = (over: Partial<ServeFlags> = {}): ServeFlags => ({ printOpenapi: false, ...over });
const refused = (f: ServeFlags, env: Record<string, string | undefined> = {}): string => {
  try {
    resolveServeConfig(f, env);
  } catch (err) {
    expect(err).toBeInstanceOf(ServeError);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('defaults', () => {
  it('port 8787, host 127.0.0.1, db ./chatwarden.db, hub element, shared pacing off, one process, no files', () => {
    expect(resolveServeConfig(flags(), {})).toMatchObject({ port: 8787, host: '127.0.0.1', db: './chatwarden.db', hub: 'element', sharedPacing: false, processes: 1 });
    const config = resolveServeConfig(flags(), {});
    expect(config.profileFile).toBeUndefined();
    expect(config.termsFile).toBeUndefined();
    expect(config.adminToken).toBeUndefined();
  });
});

describe('flags beat environment beat defaults', () => {
  const env = { CHATWARDEN_PORT: '9000', CHATWARDEN_HOST: '0.0.0.0', CHATWARDEN_DB: '/data/env.db', CHATWARDEN_PROFILE_FILE: 'env-profile.json', CHATWARDEN_TERMS_FILE: 'env-terms.json', CHATWARDEN_HUB: 'none', CHATWARDEN_SHARED_PACING: '1' };

  it('the environment beats the defaults', () => {
    expect(resolveServeConfig(flags(), env)).toMatchObject({ port: 9000, host: '0.0.0.0', db: '/data/env.db', profileFile: 'env-profile.json', termsFile: 'env-terms.json', hub: 'none', sharedPacing: true });
  });

  it('a flag beats the environment, field by field', () => {
    const given = flags({ port: '1234', host: 'localhost', db: 'flag.db', profileFile: 'flag-profile.json', termsFile: 'flag-terms.json', hub: 'element', sharedPacing: false });
    expect(resolveServeConfig(given, env)).toMatchObject({ port: 1234, host: 'localhost', db: 'flag.db', profileFile: 'flag-profile.json', termsFile: 'flag-terms.json', hub: 'element', sharedPacing: false });
  });

  it('a flag left out falls back to the environment, not the default', () => {
    expect(resolveServeConfig(flags({ port: '5' }), env)).toMatchObject({ port: 5, host: '0.0.0.0' });
  });

  it('an empty environment variable counts as not set', () => {
    expect(resolveServeConfig(flags(), { CHATWARDEN_PORT: '', CHATWARDEN_HOST: '', CHATWARDEN_HUB: '', CHATWARDEN_SHARED_PACING: '' })).toMatchObject({ port: 8787, host: '127.0.0.1', hub: 'element', sharedPacing: false });
  });
});

describe('the port', () => {
  it('0 to 65535, whole numbers only', () => {
    for (const [given, port] of [['0', 0], ['1', 1], ['8787', 8787], ['65535', 65535]] as const) expect(resolveServeConfig(flags({ port: given }), {}).port).toBe(port);
    for (const bad of ['-1', '65536', '1.5', '80a', 'abc', ' 80', '0x50', '1e3', '99999999999', '+80']) {
      expect(refused(flags({ port: bad })), bad).toMatch(/--port/);
      expect(refused(flags(), { CHATWARDEN_PORT: bad }), bad).toMatch(/CHATWARDEN_PORT/);
    }
  });

  it('the message names the flag or the variable and never repeats the value', () => {
    expect(refused(flags({ port: 'secret-looking-text' }))).not.toContain('secret-looking-text');
    expect(refused(flags(), { CHATWARDEN_PORT: 'secret-looking-text' })).not.toContain('secret-looking-text');
  });
});

describe('host, db and the files', () => {
  it('a host is any non-empty text of printable characters; a space or a control character is refused', () => {
    for (const host of ['127.0.0.1', '0.0.0.0', 'localhost', '::1', 'my-host.example']) expect(resolveServeConfig(flags({ host }), {}).host).toBe(host);
    for (const host of ['has space', 'new\nline', 'tab\there']) expect(refused(flags({ host })), host).toMatch(/--host/);
  });

  it('a path may hold anything printable but not a NUL', () => {
    expect(resolveServeConfig(flags({ db: ':memory:' }), {}).db).toBe(':memory:');
    expect(refused(flags({ db: 'a\u0000b' }))).toMatch(/--db/);
    expect(refused(flags({ profileFile: 'a\u0000b' }))).toMatch(/--profile-file/);
    expect(refused(flags({ termsFile: 'a\u0000b' }))).toMatch(/--terms-file/);
  });
});

describe('--hub', () => {
  it('element and none; anything else is refused naming the flag or the variable', () => {
    for (const hub of ['element', 'none'] as const) expect(resolveServeConfig(flags({ hub }), {}).hub).toBe(hub);
    expect(refused(flags({ hub: 'react' as never }))).toMatch(/--hub/);
    expect(refused(flags(), { CHATWARDEN_HUB: 'react' })).toMatch(/CHATWARDEN_HUB/);
  });
});

describe('a boolean environment variable is only 1 or 0', () => {
  it('1 and 0 are read; true, yes, on and the rest are refused', () => {
    expect(resolveServeConfig(flags(), { CHATWARDEN_SHARED_PACING: '1' }).sharedPacing).toBe(true);
    expect(resolveServeConfig(flags(), { CHATWARDEN_SHARED_PACING: '0' }).sharedPacing).toBe(false);
    for (const bad of ['true', 'yes', 'on', 'TRUE', '2', ' 1', 'false']) expect(refused(flags(), { CHATWARDEN_SHARED_PACING: bad }), bad).toMatch(/CHATWARDEN_SHARED_PACING/);
  });

  it('the flag is a switch: --shared-pacing is true, and it beats an environment 0', () => {
    expect(resolveServeConfig(flags({ sharedPacing: true }), { CHATWARDEN_SHARED_PACING: '0' }).sharedPacing).toBe(true);
  });
});

describe('CHATWARDEN_PROCESSES', () => {
  it('a whole number from 1 to 1000; others are refused', () => {
    expect(resolveServeConfig(flags(), { CHATWARDEN_PROCESSES: '3' }).processes).toBe(3);
    for (const bad of ['0', '-1', '1001', '1.5', 'many']) expect(refused(flags(), { CHATWARDEN_PROCESSES: bad }), bad).toMatch(/CHATWARDEN_PROCESSES/);
  });
});

describe('the secrets are carried, not judged', () => {
  it('the secret, the keys, the admin token and the auth module come from the environment as given', () => {
    const config = resolveServeConfig(flags(), { CHATWARDEN_SECRET: 's', CHATWARDEN_SERVICE_KEYS: 'a,b', CHATWARDEN_ADMIN_TOKEN: 't', CHATWARDEN_AUTH_MODULE: './auth.mjs' });
    expect(config).toMatchObject({ secret: 's', serviceKeys: 'a,b', adminToken: 't', authModule: './auth.mjs' });
  });

  it('there is no flag for a secret: the table of flags names none', () => {
    for (const option of SERVE_OPTIONS) expect(option.name).not.toMatch(/secret|key|token/);
    expect(serveHelpText()).not.toMatch(/--(secret|keys?|token|admin)/);
  });
});

describe('the command line', () => {
  it('serve takes its flags as init does: values, = form, a switch; the table and the parser agree', () => {
    const ok = (argv: string[]) => {
      const parsed = parseCli(argv);
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed;
    };
    expect(ok(['serve']).command).toBe('serve');
    expect(ok(['serve', '--port', '9']).serve).toMatchObject({ port: '9', printOpenapi: false });
    expect(ok(['serve', '--port=9', '--host', 'h', '--db', 'd', '--profile-file', 'p', '--terms-file', 't', '--hub', 'none', '--shared-pacing', '--print-openapi']).serve).toEqual({
      port: '9',
      host: 'h',
      db: 'd',
      profileFile: 'p',
      termsFile: 't',
      hub: 'none',
      sharedPacing: true,
      printOpenapi: true,
    });
    for (const option of SERVE_OPTIONS) {
      const argv = option.type === 'boolean' ? ['serve', `--${option.name}`] : ['serve', `--${option.name}`, option.values?.[0] ?? 'x'];
      const parsed = ok(argv);
      expect((parsed.serve as unknown as Record<string, unknown>)[option.key]).toBe(option.type === 'boolean' ? true : (option.values?.[0] ?? 'x'));
    }
  });

  it('unknown flags are a usage error, as is a stray word, a repeated flag, a bad --hub and an init flag', () => {
    for (const argv of [['serve', '--bogus'], ['serve', 'now'], ['serve', '--port', '1', '--port', '2'], ['serve', '--hub', 'react'], ['serve', '--framework', 'express'], ['serve', '--port'], ['serve', '-q']]) {
      const parsed = parseCli(argv);
      expect('error' in parsed, argv.join(' ')).toBe(true);
    }
  });

  it('serve --help is the serve help, not the init help; --version still answers', () => {
    const command = (argv: string[]): unknown => (parseCli(argv) as { command?: string }).command;
    expect(command(['serve', '--help'])).toBe('serveHelp');
    expect(command(['--help'])).toBe('help');
    expect(command(['serve', '--version'])).toBe('version');
  });

  it('the serve help lists every flag once with its environment twin and the required variables, in printable ASCII', () => {
    const text = serveHelpText();
    for (const option of SERVE_OPTIONS) {
      expect(text.split('\n').filter((l) => new RegExp(`--${option.name}(?![\\w-])`).test(l))).toHaveLength(1);
      if (option.env) expect(text).toContain(option.env);
    }
    for (const name of ['CHATWARDEN_SECRET', 'CHATWARDEN_SERVICE_KEYS', 'CHATWARDEN_ADMIN_TOKEN', 'CHATWARDEN_AUTH_MODULE', 'CHATWARDEN_PROCESSES']) expect(text).toContain(name);
    expect(text).toMatch(/^[\n\x20-\x7e]*$/);
    for (const line of text.split('\n')) expect(line.length).toBeLessThanOrEqual(110);
  });

  it('the main help names the serve command without listing its flags', () => {
    expect(helpText()).toMatch(/chatwarden serve/);
  });
});

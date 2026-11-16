import { describe, expect, it } from 'vitest';
import { parseCli } from '../src/cli/args.js';
import type { Parsed } from '../src/cli/args.js';
import { canPrompt, isAsked, resolveAnswers } from '../src/cli/answers.js';
import { detect } from '../src/cli/detect.js';
import type { Answers, Detected } from '../src/cli/types.js';
import { createWorld } from './cli-world.js';

const DETECTED: Detected = {
  frameworks: [],
  react: false,
  socketio: false,
  manager: 'npm',
  ts: true,
  moduleType: 'module',
  srcDir: false,
  hasDir: false,
};
const detected = (over: Partial<Detected> = {}): Detected => ({ ...DETECTED, ...over });

function parsed(...argv: string[]): Parsed {
  const result = parseCli(['init', ...argv]);
  if ('error' in result) throw new Error(result.error);
  return result;
}
function answers(argv: string[], d: Detected = DETECTED): Answers {
  const result = resolveAnswers(parsed(...argv), d);
  if ('error' in result) throw new Error(`expected answers, got: ${result.error}`);
  return result;
}
function refusal(argv: string[], d: Detected = DETECTED): string {
  const result = resolveAnswers(parsed(...argv), d);
  if (!('error' in result)) throw new Error(`expected an error, got ${JSON.stringify(result)}`);
  expect(result.error).not.toMatch(/\n/);
  expect(result.error).toMatch(/\.$/);
  return result.error;
}

const FRAMEWORKS = ['express', 'fastify', 'next', 'fetch', 'none'] as const;
const HUBS = ['element', 'react', 'none'] as const;

describe('resolveAnswers: combinations', () => {
  it('every legal combination resolves; defaults follow detection', () => {
    let legal = 0;
    let illegal = 0;
    for (const framework of FRAMEWORKS)
      for (const store of ['sqlite', 'memory'] as const)
        for (const chat of ['none', 'box'] as const)
          for (const transport of ['sse', 'socketio'] as const)
            for (const hub of HUBS)
              for (const discord of [true, false])
                for (const profile of ['relaxed', 'standard', 'strict'] as const) {
                  const argv = [
                    '--framework', framework, '--store', store, '--chat', chat, '--chat-transport', transport, '--hub', hub,
                    discord ? '--discord' : '--no-discord', '--profile', profile,
                  ];
                  const isIllegal =
                    (framework === 'none' && (chat === 'box' || hub !== 'none' || transport === 'socketio')) ||
                    (framework === 'next' && hub === 'element') ||
                    (transport === 'socketio' && chat !== 'box');
                  const result = resolveAnswers(parsed(...argv), DETECTED);
                  if (isIllegal) {
                    illegal += 1;
                    expect('error' in result, argv.join(' ')).toBe(true);
                  } else {
                    legal += 1;
                    expect(result, argv.join(' ')).toEqual({
                      framework, store, chat, chatTransport: transport, hub, discord, profile, base: '/chatwarden', dir: 'chatwarden', lang: 'ts',
                    });
                  }
                }
    expect(legal).toBeGreaterThan(100);
    expect(illegal).toBeGreaterThan(100);
  });

  it('with nothing given the defaults are express, sqlite, no chat box, sse, the element hub, no Discord and the standard profile', () => {
    expect(answers([])).toEqual({
      framework: 'express', store: 'sqlite', chat: 'none', chatTransport: 'sse', hub: 'element', discord: false, profile: 'standard',
      base: '/chatwarden', dir: 'chatwarden', lang: 'ts',
    });
  });

  it('the framework follows detection: next wins over express, a lone fastify is fastify, express beats fastify', () => {
    expect(answers([], detected({ frameworks: ['express'] })).framework).toBe('express');
    expect(answers([], detected({ frameworks: ['fastify'] })).framework).toBe('fastify');
    expect(answers([], detected({ frameworks: ['next'] })).framework).toBe('next');
    expect(answers([], detected({ frameworks: ['express', 'next'] })).framework).toBe('next');
    expect(answers([], detected({ frameworks: ['express', 'fastify'] })).framework).toBe('express');
    expect(answers([], detected({ frameworks: ['fastify', 'next'] })).framework).toBe('next');
    // A flag always beats detection.
    expect(answers(['--framework', 'fetch'], detected({ frameworks: ['next'] })).framework).toBe('fetch');
    expect(answers(['--framework', 'none'], detected({ frameworks: ['express'] })).framework).toBe('none');
  });

  it('--framework next defaults the hub to react, others to element', () => {
    expect(answers(['--framework', 'next']).hub).toBe('react');
    expect(answers([], detected({ frameworks: ['next'] })).hub).toBe('react');
    expect(answers([], detected({ frameworks: ['express', 'next'] })).hub).toBe('react');
    for (const framework of ['express', 'fastify', 'fetch'] as const) expect(answers(['--framework', framework]).hub).toBe('element');
    // Library-only has nothing to mount a hub on: its default is none, not an error.
    expect(answers(['--framework', 'none']).hub).toBe('none');
    // An explicit hub is kept.
    expect(answers(['--framework', 'next', '--hub', 'none']).hub).toBe('none');
    expect(answers(['--framework', 'express', '--hub', 'react']).hub).toBe('react');
    // The framework flag decides the default, not detection.
    expect(answers(['--framework', 'express'], detected({ frameworks: ['next'] })).hub).toBe('element');
  });

  it('the chat transport defaults to socketio only when socket.io is installed and the box is wanted', () => {
    expect(answers(['--chat', 'box'], detected({ socketio: true })).chatTransport).toBe('socketio');
    expect(answers(['--chat', 'box'], detected({ socketio: false })).chatTransport).toBe('sse');
    expect(answers(['--chat', 'box', '--chat-transport', 'sse'], detected({ socketio: true })).chatTransport).toBe('sse');
    // No box: the transport is the plain default whatever is installed.
    expect(answers([], detected({ socketio: true })).chatTransport).toBe('sse');
    expect(answers(['--chat', 'none'], detected({ socketio: true })).chatTransport).toBe('sse');
  });

  it('lang follows tsconfig.json unless given; dir follows src/ unless given', () => {
    expect(answers([], detected({ ts: false })).lang).toBe('js');
    expect(answers(['--lang', 'ts'], detected({ ts: false })).lang).toBe('ts');
    expect(answers(['--lang', 'js'], detected({ ts: true })).lang).toBe('js');
    expect(answers([], detected({ srcDir: true })).dir).toBe('src/chatwarden');
    expect(answers([], detected({ srcDir: false })).dir).toBe('chatwarden');
    expect(answers(['--dir', 'lib/vlemmo'], detected({ srcDir: true })).dir).toBe('lib/vlemmo');
  });

  it('none with --chat box or --hub, next with --hub element, and socketio without a framework are rejected with one sentence each', () => {
    const noneBox = refusal(['--framework', 'none', '--chat', 'box']);
    expect(noneBox).toContain('--framework none');
    expect(noneBox).toContain('--chat');
    for (const hub of ['element', 'react']) {
      const message = refusal(['--framework', 'none', '--hub', hub]);
      expect(message).toContain('--framework none');
      expect(message).toContain('--hub');
    }
    const nextElement = refusal(['--framework', 'next', '--hub', 'element']);
    expect(nextElement).toContain('--hub element');
    expect(nextElement).toContain('react');
    const socketNoFramework = refusal(['--framework', 'none', '--chat-transport', 'socketio']);
    expect(socketNoFramework).toContain('--chat-transport');
    expect(socketNoFramework).toContain('framework');
    // Detection can put a rule in force: next detected, element asked for.
    expect(refusal(['--hub', 'element'], detected({ frameworks: ['next'] }))).toContain('--hub element');
    // Socket.IO transport means nothing without the box.
    const noBox = refusal(['--framework', 'express', '--chat-transport', 'socketio']);
    expect(noBox).toContain('--chat box');
  });

  it('the legal neighbours of those rules are accepted', () => {
    expect(answers(['--framework', 'none', '--chat', 'none', '--hub', 'none']).framework).toBe('none');
    expect(answers(['--framework', 'none', '--discord']).discord).toBe(true);
    expect(answers(['--framework', 'next', '--hub', 'react']).hub).toBe('react');
    expect(answers(['--framework', 'fetch', '--chat', 'box', '--chat-transport', 'socketio']).chatTransport).toBe('socketio');
  });
});

describe('resolveAnswers: --base and --dir validation', () => {
  it('accepts a prefix of letters, digits, underscore, dash and single slashes', () => {
    for (const base of ['/chatwarden', '/a', '/a/b', '/a-b_c/D9', '/zorbak/vlemmo']) expect(answers(['--base', base]).base).toBe(base);
  });

  it('--base: //, a trailing /, a lone /, no leading /, spaces, dots, a NUL, a drive letter and the empty string are refused', () => {
    const bad = ['//', '/a//b', '//a', '/a/', '/', '', 'chatwarden', ' /a', '/a b', '/a\tb', '/a.b', '/a..b', '/../a', '/a\0b', '/a\nb', 'C:/a', 'C:\\a', '/a\\b', '/a?x', '/a#x', '/é', '/a%20b'];
    for (const base of bad) {
      const message = refusal(['--base', base]);
      expect(message, JSON.stringify(base)).toContain('--base');
    }
  });

  it('--dir is normalised to posix: backslashes, a leading ./, a trailing slash', () => {
    expect(answers(['--dir', 'src\\chatwarden']).dir).toBe('src/chatwarden');
    expect(answers(['--dir', './src/chatwarden']).dir).toBe('src/chatwarden');
    expect(answers(['--dir', 'src/chatwarden/']).dir).toBe('src/chatwarden');
    expect(answers(['--dir', 'src\\a\\b\\']).dir).toBe('src/a/b');
    expect(answers(['--dir', 'chatwarden']).dir).toBe('chatwarden');
    expect(answers(['--dir', 'my game/chatwarden']).dir).toBe('my game/chatwarden');
  });

  it('--dir: .., an absolute path, a drive letter, a UNC path, //, a NUL and an empty or . folder are refused', () => {
    const bad = [
      '..', '../x', 'a/../b', 'a\\..\\b', '..\\x', 'a/..', '/abs', '/', '\\abs', 'C:\\x', 'C:/x', 'c:x', 'Z:\\', '\\\\server\\share', '//server/share',
      'a//b', 'a\0b', '\0', '', '.', './', '.\\',
    ];
    for (const dir of bad) {
      const message = refusal(['--dir', dir]);
      expect(message, JSON.stringify(dir)).toContain('--dir');
    }
  });

  it('a dot inside a name is fine; only a whole .. segment is refused', () => {
    expect(answers(['--dir', 'a..b']).dir).toBe('a..b');
    expect(answers(['--dir', 'src/chat.warden']).dir).toBe('src/chat.warden');
    expect(answers(['--dir', '..a/b']).dir).toBe('..a/b');
  });
});

describe('isAsked: which questions a terminal run puts', () => {
  const none: Partial<Answers> = {};

  it('socketio is asked about only when socket.io is a dependency and --chat box', () => {
    const asked = (given: Partial<Answers>, d: Detected): boolean => isAsked('chatTransport', given, d);
    expect(asked({ chat: 'box' }, detected({ socketio: true }))).toBe(true);
    expect(asked({ chat: 'box' }, detected({ socketio: false }))).toBe(false);
    expect(asked({ chat: 'none' }, detected({ socketio: true }))).toBe(false);
    expect(asked(none, detected({ socketio: true }))).toBe(false);
    expect(asked({ chat: 'box', chatTransport: 'sse' }, detected({ socketio: true }))).toBe(false);
    expect(asked({ chat: 'box', framework: 'none' }, detected({ socketio: true }))).toBe(false);
  });

  it('a question whose flag was given is not asked', () => {
    const d = detected();
    expect(isAsked('framework', { framework: 'express' }, d)).toBe(false);
    expect(isAsked('store', { store: 'memory' }, d)).toBe(false);
    expect(isAsked('chat', { chat: 'box' }, d)).toBe(false);
    expect(isAsked('hub', { hub: 'none' }, d)).toBe(false);
    expect(isAsked('discord', { discord: false }, d)).toBe(false);
    expect(isAsked('profile', { profile: 'strict' }, d)).toBe(false);
  });

  it('the plain questions are asked when nothing is given', () => {
    const d = detected();
    for (const name of ['store', 'chat', 'hub', 'discord', 'profile'] as const) expect(isAsked(name, none, d), name).toBe(true);
  });

  it('the framework is asked only when detection leaves doubt', () => {
    expect(isAsked('framework', none, detected({ frameworks: [] }))).toBe(true);
    expect(isAsked('framework', none, detected({ frameworks: ['express'] }))).toBe(false);
    expect(isAsked('framework', none, detected({ frameworks: ['fastify'] }))).toBe(false);
    expect(isAsked('framework', none, detected({ frameworks: ['next'] }))).toBe(false);
    expect(isAsked('framework', none, detected({ frameworks: ['express', 'next'] }))).toBe(false); // next wins
    expect(isAsked('framework', none, detected({ frameworks: ['express', 'fastify'] }))).toBe(true);
  });

  it('library-only has nothing to mount: chat, transport and hub are not asked', () => {
    const d = detected({ socketio: true });
    expect(isAsked('chat', { framework: 'none' }, d)).toBe(false);
    expect(isAsked('hub', { framework: 'none' }, d)).toBe(false);
    expect(isAsked('chatTransport', { framework: 'none', chat: 'box' }, d)).toBe(false);
    expect(isAsked('store', { framework: 'none' }, d)).toBe(true);
  });
});

describe('canPrompt: no prompt for --yes, --json or a non-terminal', () => {
  it('asks only on a terminal with neither --yes nor --json', () => {
    expect(canPrompt(parsed(), true)).toBe(true);
    expect(canPrompt(parsed(), false)).toBe(false);
    expect(canPrompt(parsed('--yes'), true)).toBe(false);
    expect(canPrompt(parsed('-y'), true)).toBe(false);
    expect(canPrompt(parsed('--json'), true)).toBe(false);
    expect(canPrompt(parsed('--check'), true)).toBe(false);
    expect(canPrompt(parsed('--dry-run'), true)).toBe(true);
  });
});

describe('Windows: the same answers with path.win32 and a C:\\ root', () => {
  const projects: Array<[string, Record<string, string>, string[]]> = [
    ['plain express', { 'package.json': '{"dependencies":{"express":"^5"}}' }, []],
    ['next with src and no tsconfig', { 'package.json': '{"dependencies":{"next":"15","react":"19","express":"5"}}', 'src/app/page.js': '' }, []],
    ['fastify and socket.io with the box', { 'package.json': '{"dependencies":{"fastify":"5","socket.io":"4"}}', 'tsconfig.json': '{}' }, ['--chat', 'box']],
  ];
  it('detect then resolve gives the same answers on both path modules', async () => {
    for (const [name, files, argv] of projects) {
      const results: Answers[] = [];
      for (const kind of ['posix', 'win32'] as const) {
        const world = createWorld({ kind, files });
        const found = await detect(world.env);
        if ('error' in found) throw new Error(found.error);
        results.push(answers(argv, found));
      }
      expect(results[1], name).toEqual(results[0]);
    }
  });

  it('a backslash --dir gives the same posix answer a slash one does', () => {
    expect(answers(['--dir', 'src\\chatwarden'])).toEqual(answers(['--dir', 'src/chatwarden']));
  });
});

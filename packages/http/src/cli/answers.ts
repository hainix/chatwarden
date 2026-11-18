// From a parsed command line and what detection found to the resolved answers (design 5.1), and which questions a terminal run asks.
import { OPTIONS, show } from './args.js';
import type { Parsed } from './args.js';
import type { Answers, Detected, Framework, GameChoice, HubChoice, ProfileChoice } from './types.js';

export type { Answers } from './types.js';

type Failure = { error: string };

function defaultOf(name: string): string {
  const value = OPTIONS.find((option) => option.name === name)?.default;
  if (value === undefined) throw new Error(`OPTIONS has no default for --${name}`);
  return value;
}

/** The framework detection settles on: next wins over express, then express, then fastify; with none of them, express. */
function detectedFramework(detected: Detected): Framework {
  if (detected.frameworks.includes('next')) return 'next';
  if (detected.frameworks.includes('express')) return 'express';
  if (detected.frameworks.includes('fastify')) return 'fastify';
  return 'express';
}

/**
 * The standard each kind of game starts from. A copy of the core's `GAME_PRESET`: the CLI imports nothing from `@chatwarden/core` (a template is text), and a test
 * (cli-game.test.ts) fails when the two differ.
 */
export const GAME_PRESETS: Readonly<Record<GameChoice, ProfileChoice>> = { competitive: 'relaxed', social: 'standard', kids: 'strict', creator: 'standard' };

/** The team note a creator community starts with. A copy of the core's `CREATOR_TEAM_NOTE`, pinned by the same test. */
export const CREATOR_TEAM_NOTE = 'Protect the creator and their guests from targeted abuse';

const BASE_PATTERN = /^\/[A-Za-z0-9_/-]*$/;

function checkBase(base: string): Failure | undefined {
  if (BASE_PATTERN.test(base) && base !== '/' && !base.includes('//') && !base.endsWith('/')) return undefined;
  return {
    error: `--base must be a path like /chatwarden: it starts with /, uses only letters, digits, - and _, has no // and no trailing / (got ${show(base)}).`,
  };
}

/** `--dir` to the posix, relative, normalised form; or an error. Whether the result is safe on disk is decided again when it is resolved (paths.ts). */
export function normaliseDir(raw: string): string | Failure {
  const bad: Failure = {
    error: `--dir must be a folder inside the project, like src/chatwarden: no .., no absolute path, no drive letter and no // (got ${show(raw)}).`,
  };
  if (raw.includes('\0')) return bad;
  const slashed = raw.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith('/')) return bad;
  const segments = slashed.replace(/\/+$/, '').split('/');
  if (segments.some((segment) => segment === '')) return bad;
  const kept = segments.filter((segment) => segment !== '.');
  if (kept.length === 0 || kept.includes('..')) return bad;
  return kept.join('/');
}

/**
 * Resolve every answer: a flag wins, then detection, then the default. The combination rules are the design's: a library-only setup has
 * nothing to mount a chat box or a hub on, a Next route handler cannot serve the element's script, and the Socket.IO transport needs the box.
 */
export function resolveAnswers(parsed: Parsed, detected: Detected): Answers | Failure {
  const base = parsed.base ?? defaultOf('base');
  const baseError = checkBase(base);
  if (baseError) return baseError;
  let dir: string;
  if (parsed.dir === undefined) {
    dir = detected.srcDir ? 'src/chatwarden' : 'chatwarden';
  } else {
    const normalised = normaliseDir(parsed.dir);
    if (typeof normalised !== 'string') return normalised;
    dir = normalised;
  }

  const framework = parsed.framework ?? detectedFramework(detected);
  const chat = parsed.chat ?? (defaultOf('chat') as Answers['chat']);
  const hub: HubChoice = parsed.hub ?? (framework === 'none' ? 'none' : framework === 'next' ? 'react' : 'element');

  if (parsed.chatTransport === 'socketio' && framework === 'none') {
    return { error: '--chat-transport socketio needs a framework to mount on: pass --framework express, fastify, next or fetch.' };
  }
  if (parsed.chatTransport === 'socketio' && chat !== 'box') {
    return { error: '--chat-transport socketio only applies to the chat box: pass --chat box, or drop --chat-transport.' };
  }
  if (framework === 'none' && chat === 'box') {
    return { error: '--framework none has nothing to mount the chat box on: pass --chat none, or choose a framework.' };
  }
  if (framework === 'none' && hub !== 'none') {
    return { error: '--framework none has nothing to mount the hub on: pass --hub none, or choose a framework.' };
  }
  if (framework === 'next' && hub === 'element') {
    return { error: '--hub element does not work in a Next.js project, which serves no script file from a route handler: pass --hub react (or --hub none).' };
  }

  return {
    framework,
    store: parsed.store ?? (defaultOf('store') as Answers['store']),
    chat,
    chatTransport: parsed.chatTransport ?? (chat === 'box' && detected.socketio ? 'socketio' : 'sse'),
    hub,
    discord: parsed.discord ?? false,
    // --profile wins; else the standard the kind of game starts from; else the default.
    profile: parsed.profile ?? (parsed.game === undefined ? (defaultOf('profile') as Answers['profile']) : GAME_PRESETS[parsed.game]),
    ...(parsed.game === undefined ? {} : { game: parsed.game }),
    base,
    dir,
    lang: parsed.lang ?? (detected.ts ? 'ts' : 'js'),
  };
}

export type QuestionName = 'game' | 'framework' | 'store' | 'chat' | 'chatTransport' | 'hub' | 'discord' | 'profile';

/**
 * Whether a terminal run asks this question, given the answers known so far (flags, then earlier replies). A question is skipped when its
 * flag was given or when it cannot matter: a library-only setup has no chat box or hub, the transport is asked only for the box and only when
 * socket.io is a dependency, and the framework is asked only when the dependencies leave doubt (none, or express with fastify).
 */
export function isAsked(name: QuestionName, given: Partial<Answers>, detected: Detected): boolean {
  if (given[name] !== undefined) return false;
  switch (name) {
    case 'framework':
      return !(detected.frameworks.length === 1 || detected.frameworks.includes('next'));
    // The kind of game stands in for "Which standard?": once it is given or answered, the standard follows from it.
    case 'profile':
      return given.game === undefined;
    case 'chat':
    case 'hub':
      return given.framework !== 'none';
    case 'chatTransport':
      return given.chat === 'box' && detected.socketio && given.framework !== 'none';
    default:
      return true;
  }
}

/** `--yes`, `--json` and `--check` ask nothing, and neither does a run whose input is not a terminal. */
export function canPrompt(parsed: Parsed, isTTY: boolean): boolean {
  return isTTY && !parsed.yes && !parsed.json && !parsed.check;
}

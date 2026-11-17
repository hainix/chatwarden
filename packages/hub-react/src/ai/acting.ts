import type { HubError } from '../client.js';
import type { AiActingState, AiActingStep } from '../types.js';
import type { AiT } from './i18n.js';

// What Settings > AI shows about acting (AI levels 3 and 4, release 2) that is a rule and not a picture: why the Act option cannot be used, and a refusal's words.
// Nothing here decides: the server checks every step again, and the hub only explains what it was told.

/** What the hub knows when it decides whether to offer the Act option. */
export interface ActFacts {
  /** The signed-in role is the owner (the server compares it again). */
  owner: boolean;
  /** `GET /ai/status` says an adapter is set up. */
  adapter: boolean;
  /** The code's ceiling (`GET /ai/acting` `maxLevel`). */
  maxLevel: number;
  /** The hub's saved AI level. */
  level: number;
  /** `GET /me` says appeals are on. */
  appeals: boolean;
}

/** Why the owner cannot switch acting on, as the word key of the first thing in the way (the order is the order a person would fix them: the adapter, then the code, then appeals, then the level), or null when nothing is. */
export function blockedKey(f: ActFacts): 'owner' | 'adapter' | 'code' | 'level' | 'appeals' | null {
  if (!f.owner) return 'owner';
  if (!f.adapter) return 'adapter';
  if (f.maxLevel < 3) return 'code';
  if (!f.appeals) return 'appeals';
  if (f.level < 2) return 'level';
  return null;
}

/** The Act option reads as chosen while acting is anywhere but off (and the level is Recommend, which it needs). */
export const actingOn = (state: AiActingState | undefined): boolean => state !== undefined && state.mode !== 'off';

/** A refused step in words: the server's code picks the sentence, and the server's own text is never shown. */
export function actingErrorText(t: AiT, step: AiActingStep, error: HubError): string {
  switch (error.code) {
    case 'wrong_state':
      return t('hub.settings.ai.act.error.wrong_state');
    case 'acting_unavailable':
      return t('hub.settings.ai.act.blocked.code');
    case 'ai_level':
      return t('hub.settings.ai.act.blocked.level');
    case 'no_appeals':
      return t('hub.settings.ai.act.blocked.appeals');
    case 'too_early':
      return t('hub.settings.ai.act.error.too_early');
    case 'invalid_request':
    case 'forbidden_key':
      return t('hub.settings.ai.act.error.invalid');
    case 'forbidden':
      return t(step === 'pause' ? 'hub.settings.ai.act.error.pause' : step === 'shadow' ? 'hub.settings.ai.act.blocked.owner' : 'hub.settings.ai.act.error.owner');
    default:
      return t('hub.settings.ai.act.error.failed');
  }
}

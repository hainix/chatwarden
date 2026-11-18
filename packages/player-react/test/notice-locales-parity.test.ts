import { describe, expect, it } from 'vitest';
import { NOTICE_WORDS } from '@chatwarden/core/notice-copy';
import { NOTICE_WORDS_ES, NOTICE_WORDS_PT } from '@chatwarden/core/notice-locales';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';

// The server writes notices (the appeal page, the delivery email) with core's Spanish and Portuguese; the player's own dialog uses player-react's.
// For the notice words the two must be the same text, key for key, so a person never reads one wording on the screen and another in the email.

describe('core and player-react word the notice the same way', () => {
  const keys = Object.keys(NOTICE_WORDS) as Array<keyof typeof NOTICE_WORDS>;

  it('every NoticeWordKey: the Spanish text is the same', () => {
    expect(keys.length).toBe(39);
    for (const key of keys) expect(NOTICE_WORDS_ES[key], key).toBe((es as Record<string, string>)[key]);
  });

  it('every NoticeWordKey: the Portuguese text is the same', () => {
    for (const key of keys) expect(NOTICE_WORDS_PT[key], key).toBe((pt as Record<string, string>)[key]);
  });
});

import { describe, expect, it } from 'vitest';
import type { NameReason } from '@chatwarden/core';
import { createT, en } from '../src/i18n.js';
import { nameReasonText } from '../src/names.js';

const NOT_ALLOWED = 'That name is not allowed. Choose another.';
const PROFANE = 'That name is not allowed here. Choose another.';

describe('nameReasonText', () => {
  const t = createT(en, 'en');

  it('covers name_not_allowed and name_profane, each in its own words', () => {
    expect(nameReasonText(t, 'name_not_allowed')).toBe(NOT_ALLOWED);
    expect(nameReasonText(t, 'name_profane')).toBe(PROFANE);
    expect(nameReasonText(t, 'name_not_allowed')).not.toBe(nameReasonText(t, 'name_profane'));
  });

  it('answers a sentence for every reason core names (control: the list is the type)', () => {
    const all: NameReason[] = ['name_not_allowed', 'name_profane'];
    for (const reason of all) expect(nameReasonText(t, reason)).toMatch(/^That name is not allowed/);
  });

  it('a reason a newer server adds reads as the general one, never as a key or blank', () => {
    expect(nameReasonText(t, 'name_something_new' as NameReason)).toBe(NOT_ALLOWED);
    expect(nameReasonText(t, '' as NameReason)).toBe(NOT_ALLOWED);
    expect(nameReasonText(t, undefined as unknown as NameReason)).toBe(NOT_ALLOWED);
  });

  it('does not take a reason named like an inherited property for a key', () => {
    expect(nameReasonText(t, 'constructor' as NameReason)).toBe(NOT_ALLOWED);
    expect(nameReasonText(t, '__proto__' as NameReason)).toBe(NOT_ALLOWED);
  });

  it('uses the host catalog when it has the key', () => {
    const de = createT({ ...en, 'player.name.profane': 'Dieser Name ist hier nicht erlaubt.', 'player.name.not_allowed': 'Dieser Name ist nicht erlaubt.' }, 'de');
    expect(nameReasonText(de, 'name_profane')).toBe('Dieser Name ist hier nicht erlaubt.');
    expect(nameReasonText(de, 'name_not_allowed')).toBe('Dieser Name ist nicht erlaubt.');
  });

  it('a missing key falls back to English, not to the key', () => {
    const bare = createT({}, 'fr');
    expect(nameReasonText(bare, 'name_not_allowed')).toBe(NOT_ALLOWED);
    expect(nameReasonText(bare, 'name_profane')).toBe(PROFANE);
    // One key translated, the other missing: each falls back on its own.
    const half = createT({ 'player.name.profane': 'Nom interdit ici.' }, 'fr');
    expect(nameReasonText(half, 'name_profane')).toBe('Nom interdit ici.');
    expect(nameReasonText(half, 'name_not_allowed')).toBe(NOT_ALLOWED);
  });

  it('the English catalog has the name and rename words of the spec, verbatim', () => {
    expect(en['player.name.not_allowed']).toBe(NOT_ALLOWED);
    expect(en['player.name.profane']).toBe(PROFANE);
    expect(en['player.notice.title.rename_required']).toBe('Please choose a new name');
    expect(en['player.notice.body.rename_required']).toBe(
      'A moderator asked you to change your name because it breaks the community rules. Choose a new name to keep playing.',
    );
  });
});

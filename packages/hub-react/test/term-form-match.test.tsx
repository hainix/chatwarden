import { cleanup, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { renderHub } from './render.js';
import { hubWorld } from './world.js';
import type { HubWorld, WorldOptions } from './world.js';
import { languageLabel, sortLanguages } from '../src/terms/languages.js';

// L2: the Match choice on Add term. It appears only after the typed word is in a script written without spaces (Han, kana, Thai, Lao, Khmer, Myanmar), with whole words (recommended) selected and one sentence on
// each option; the dry run runs for the chosen mode; the saved row shows the mode in the list only when it is not the default. Real routes, real kit. Invented strings only.

afterEach(() => cleanup());

const FRAGMENT = '\u5c14\u5df4\u5c3c';
const INSIDE = '\u6211\u53bb\u8fc7\u963f\u5c14\u5df4\u5c3c\u4e9a\u65c5\u6e38';
const OUTSIDE = '\u4f60\u597d\uff0c\u5c14\u5df4\u5c3c\u3002\u518d\u89c1';
const HAN = '\u4f50\u5c14\u5df4\u514b';
const KATA = '\u30be\u30eb\u30d0\u30af';
const THAI = '\u0e0b\u0e2d\u0e23\u0e4c\u0e1a\u0e31\u0e01';

const sent = (w: HubWorld, method: string, path: string) => w.sent.filter((r) => r.method === method && r.path === path);
const word = (): HTMLInputElement => screen.getByLabelText('Word') as HTMLInputElement;
const language = (): HTMLInputElement => screen.getByLabelText('Language') as HTMLInputElement;
const matchGroup = (): HTMLElement | null => screen.queryByRole('group', { name: 'Match' });
const whole = (): HTMLInputElement => screen.getByRole('radio', { name: /^Whole words/ }) as HTMLInputElement;
const anywhere = (): HTMLInputElement => screen.getByRole('radio', { name: /^Anywhere in the text/ }) as HTMLInputElement;

async function openAdd(options: WorldOptions = {}) {
  const w = await hubWorld({ recentLines: () => [INSIDE, OUTSIDE, '\u4f60\u597d\u518d\u89c1'], ...options });
  const r = renderHub(w, { path: '/terms' });
  await screen.findByRole('heading', { level: 2, name: 'Terms' });
  await screen.findByRole('region', { name: /^English/ });
  await r.user.click(screen.getByRole('button', { name: 'Add a term' }));
  await screen.findByRole('form', { name: 'Add a term' });
  return { w, ...r };
}
type User = Awaited<ReturnType<typeof openAdd>>['user'];
async function typeWord(user: User, text: string, lang = 'zh'): Promise<void> {
  await user.type(word(), text);
  await user.clear(language());
  await user.type(language(), lang);
}

describe('when the Match choice is offered', () => {
  it('a Latin word shows no Match choice, and the request is what it was', async () => {
    const { w, user } = await openAdd();
    await user.type(word(), 'flarpnok');
    expect(matchGroup()).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: 'flarpnok', language: 'en' });
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: 'flarpnok', language: 'en' });
  });

  it.each([
    ['Han', HAN],
    ['Katakana', KATA],
    ['Hiragana', '\u305e\u308b\u3070\u304f'],
    ['Thai', THAI],
    ['Lao', '\u0e9a\u0eb2\u0e81\u0eb2'],
    ['Khmer', '\u1780\u17d2\u1780\u17d2\u1780'],
    ['Myanmar', '\u1019\u1004\u103a\u1039\u1002\u101c\u102c'],
  ])('a %s word shows it, with whole words (recommended) selected', async (_name, text) => {
    const { user } = await openAdd();
    expect(matchGroup()).toBeNull();
    await user.type(word(), text);
    expect(matchGroup()).not.toBeNull();
    expect(whole()).toBeChecked();
    expect(anywhere()).not.toBeChecked();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('it goes away again when the word stops being in such a script, and a mixed Latin and Han word shows it', async () => {
    const { user } = await openAdd();
    await user.type(word(), HAN);
    expect(matchGroup()).not.toBeNull();
    await user.clear(word());
    expect(matchGroup()).toBeNull();
    await user.type(word(), `zorbak${HAN}`);
    expect(matchGroup()).not.toBeNull();
  });

  it('an exception has no Match choice, whatever the phrase is written in', async () => {
    const w = await hubWorld();
    const r = renderHub(w, { path: '/terms' });
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    await screen.findByRole('region', { name: /^English/ });
    await r.user.click(screen.getByRole('button', { name: 'Add an exception' }));
    await screen.findByRole('form', { name: 'Add an exception' });
    await r.user.type(screen.getByLabelText('Phrase'), HAN);
    expect(matchGroup()).toBeNull();
  });
});

describe('the sentences', () => {
  it('each option has one sentence, and the one for the chosen option is the one shown: choosing anywhere in the text changes it', async () => {
    const { user } = await openAdd();
    await user.type(word(), HAN);
    const segment = within(matchGroup() as HTMLElement).getByText(/only where it stands as a word of its own/i);
    expect(segment).toBeInTheDocument();
    expect(within(matchGroup() as HTMLElement).queryByText(/including inside longer words/i)).toBeNull();
    await user.click(anywhere());
    expect(anywhere()).toBeChecked();
    expect(whole()).not.toBeChecked();
    expect(within(matchGroup() as HTMLElement).getByText(/including inside longer words/i)).toBeInTheDocument();
    expect(within(matchGroup() as HTMLElement).queryByText(/only where it stands as a word of its own/i)).toBeNull();
    expect(anywhere()).toHaveAccessibleDescription(/including inside longer words/i);
  });

  it('the language field offers zh, ja, th, lo, km and my for such a word, named for a person', async () => {
    const { container, user } = await openAdd();
    await user.type(word(), HAN);
    const list = container.querySelector(`datalist[id$="-codes"]`) as HTMLDataListElement;
    const codes = [...list.querySelectorAll('option')].map((o) => o.getAttribute('value'));
    for (const code of ['zh', 'ja', 'th', 'lo', 'km', 'my']) expect(codes).toContain(code);
  });
});

describe('the dry run and the save', () => {
  it('whole words is the default: the check and the save carry no mode, the check lists only the line where the word stands alone, and the saved row has no mode', async () => {
    const { w, user } = await openAdd();
    await typeWord(user, FRAGMENT);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('This word would also block 1 line that is fine today.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: FRAGMENT, language: 'zh' });
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: FRAGMENT, language: 'zh' });
    expect(w.live.rows.terms.find((t) => t.term === FRAGMENT)?.matchMode ?? null).toBeNull();
  });

  it('anywhere in the text: the dry run runs for that mode and shows the larger number before saving, and the save carries it', async () => {
    const { w, user } = await openAdd();
    await typeWord(user, FRAGMENT);
    await user.click(anywhere());
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('This word would also block 2 lines that are fine today.')).toBeInTheDocument();
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: FRAGMENT, language: 'zh', matchMode: 'contains' });
    expect(sent(w, 'POST', '/terms')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Save anyway' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: FRAGMENT, language: 'zh', matchMode: 'contains' });
    expect(w.live.rows.terms.find((t) => t.term === FRAGMENT)?.matchMode).toBe('contains');
    expect(w.live.match(INSIDE)).not.toBeNull();
  });

  it('a word with nothing to block saves at once with the chosen mode, and the choice is kept when the form goes back from the hits', async () => {
    const { w, user } = await openAdd({ recentLines: () => [] });
    await typeWord(user, HAN);
    await user.click(anywhere());
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms')[0]?.body).toEqual({ term: HAN, language: 'zh', matchMode: 'contains' });
  });

  it('Go back from the hits keeps the chosen mode', async () => {
    const { user } = await openAdd();
    await typeWord(user, FRAGMENT);
    await user.click(anywhere());
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    await screen.findByText('This word would also block 2 lines that are fine today.');
    await user.click(screen.getByRole('button', { name: 'Go back' }));
    expect(anywhere()).toBeChecked();
  });

  it('a word that does not fit its language (Han with en) is refused by the list and the draft is kept', async () => {
    const { w, user } = await openAdd({ recentLines: () => [] });
    await user.type(word(), HAN);
    await user.click(screen.getByRole('button', { name: 'Add term' }));
    expect(await screen.findByText('The list refused this word (it may be a duplicate, malformed, or the last active word).')).toBeInTheDocument();
    expect(word()).toHaveValue(HAN);
    expect(w.live.rows.terms.some((t) => t.term === HAN)).toBe(false);
  });
});

describe('the list and the edit form', () => {
  async function withRows() {
    const w = await hubWorld({ recentLines: () => [INSIDE, OUTSIDE] });
    await w.direct.addTerm({ term: FRAGMENT, language: 'zh', matchMode: 'contains' } as never);
    await w.direct.addTerm({ term: HAN, language: 'zh' });
    const r = renderHub(w, { path: '/terms' });
    await screen.findByRole('heading', { level: 2, name: 'Terms' });
    await screen.findByRole('region', { name: /^Chinese/ });
    await r.user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    return { w, ...r };
  }
  const rowOf = (text: string): HTMLElement => within(screen.getByRole('region', { name: 'Terms in Chinese (zh)' })).getAllByRole('row').find((x) => x.textContent?.includes(text)) as HTMLElement;

  it('shows the mode only on a row that is not the default: the contains row says it matches anywhere, the others say nothing', async () => {
    await withRows();
    expect(rowOf(FRAGMENT)).toHaveTextContent('Matches anywhere');
    expect(rowOf(HAN)).not.toHaveTextContent('Matches anywhere');
    expect(within(screen.getByRole('region', { name: /^English/ })).queryByText('Matches anywhere')).toBeNull();
  });

  it('editing the contains row opens with anywhere chosen; choosing whole words sends the mode back to the default, and the matcher follows', async () => {
    const { w, user } = await withRows();
    await user.click(within(rowOf(FRAGMENT)).getByRole('button', { name: `Edit ${FRAGMENT}` }));
    await screen.findByRole('form', { name: 'Edit a term' });
    expect(anywhere()).toBeChecked();
    await user.click(whole());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent(w, 'PATCH', `/terms/${w.live.rows.terms.find((t) => t.term === FRAGMENT)?.id}`)).toHaveLength(1));
    expect(sent(w, 'PATCH', `/terms/${w.live.rows.terms.find((t) => t.term === FRAGMENT)?.id}`)[0]?.body).toEqual({ matchMode: null });
    expect(w.live.rows.terms.find((t) => t.term === FRAGMENT)?.matchMode ?? null).toBeNull();
    expect(w.live.match(INSIDE)).toBeNull();
  });

  it('a mode change alone is a change (not "nothing changed"), and it runs the dry run for the new mode first', async () => {
    const { w, user } = await withRows();
    await user.click(within(rowOf(HAN)).getByRole('button', { name: `Edit ${HAN}` }));
    await screen.findByRole('form', { name: 'Edit a term' });
    expect(whole()).toBeChecked();
    await user.click(anywhere());
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(sent(w, 'POST', '/terms/check')).toHaveLength(1));
    expect(sent(w, 'POST', '/terms/check')[0]?.body).toEqual({ term: HAN, language: 'zh', matchMode: 'contains' });
    expect(screen.queryByText(/Nothing was changed/i)).toBeNull();
  });

  it('a Latin row has no Match choice when edited', async () => {
    const w = await hubWorld();
    const r = renderHub(w, { path: '/terms' });
    await screen.findByRole('region', { name: /^English/ });
    await r.user.click(screen.getByRole('checkbox', { name: 'Show words' }));
    await r.user.click(screen.getByRole('button', { name: 'Edit zorbak' }));
    await screen.findByRole('form', { name: 'Edit a term' });
    expect(matchGroup()).toBeNull();
  });
});

describe('words, languages and accessibility', () => {
  it('zh, ja, th, lo, km and my are named for a person by Intl.DisplayNames, and sort among the others', () => {
    const named = new Intl.DisplayNames(['en'], { type: 'language' });
    for (const code of ['zh', 'ja', 'th', 'lo', 'km', 'my']) {
      expect(languageLabel(code, 'en'), code).toBe(`${named.of(code)} (${code})`);
    }
    expect(sortLanguages(['zh', 'en', 'ja', 'th', 'lo', 'km', 'my'], 'en')).toEqual(['zh', 'en', 'ja', 'km', 'lo', 'my', 'th'].sort((a, b) => languageLabel(a, 'en').localeCompare(languageLabel(b, 'en'))));
  });

  it('has no axe violations in the light and the dark theme, with the choice open and anywhere chosen', async () => {
    for (const theme of ['light', 'dark'] as const) {
      cleanup();
      const w = await hubWorld();
      const { container, user } = renderHub(w, { path: '/terms', theme });
      await screen.findByRole('region', { name: /^English/ });
      await user.click(screen.getByRole('button', { name: 'Add a term' }));
      await screen.findByRole('form', { name: 'Add a term' });
      await user.type(word(), HAN);
      await user.click(anywhere());
      const found = (await axe.run(container, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] })).violations.map((v) => `${v.id} ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
      expect(found, theme).toEqual([]);
    }
  });

  it('the words are in the catalogue, in plain text, and the choice is one fieldset with a legend', async () => {
    const { user, container } = await openAdd();
    await user.type(word(), HAN);
    const group = matchGroup() as HTMLElement;
    expect(group.tagName).toBe('FIELDSET');
    expect(within(group).getByText('Match')).toBeInTheDocument();
    expect(container.querySelector('img, script')).toBeNull();
  });
});

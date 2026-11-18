import { act, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatBox } from '../src/chat/ChatBox.js';
import type { ChatBoxProps } from '../src/chat/ChatBox.js';
import type { ChatTransport } from '../src/chat/transport.js';
import { enChat } from '../src/chat/words.js';
import { NoticeQueue } from '../src/NoticeQueue.js';
import { createT, en } from '../src/i18n.js';
import { es } from '../src/locales/es.js';
import { pt } from '../src/locales/pt.js';
import { chatWorld } from './chat-world.js';
import type { ChatWorld } from './chat-world.js';
import { FIXED, renderUi } from './render.js';
import { ALICE, DAY, playerWorld } from './world.js';

// The components are catalogue-agnostic: they render in Spanish or Portuguese with `createT`, in a 360 px column, and axe finds nothing.
// axe runs in jsdom (no painted colours), so `color-contrast` is off; the stylesheet tokens are checked in static.test.ts.
const RULES = { 'color-contrast': { enabled: false } } as const;
async function violations(container: HTMLElement): Promise<string[]> {
  const result = await axe.run(container, { rules: RULES, resultTypes: ['violations'] });
  return result.violations.map((v) => `${v.impact ?? 'unknown'}: ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).join('; ')}`);
}

const CATALOGS = { es: es as Record<string, string>, pt: pt as Record<string, string> };
const tFor = (locale: 'es' | 'pt') => createT({ ...en, ...enChat, ...CATALOGS[locale] }, locale);

let w: ChatWorld;
beforeEach(async () => {
  w = await chatWorld();
});
afterEach(() => w.close());

const box = (transport: ChatTransport, locale: 'es' | 'pt', props: Partial<ChatBoxProps> = {}) => (
  <div style={{ width: 360 }}>
    <ChatBox transport={transport} room="lobby" {...FIXED} locale={locale} t={tFor(locale)} now={w.clock.now} {...props} />
  </div>
);

describe.each(['es', 'pt'] as const)('the chat box in %s', (locale) => {
  const words = CATALOGS[locale] as Record<string, string>;

  it('renders its words from the catalogue: the log, the input, the Send button', async () => {
    renderUi(box(w.transportFor('snerp'), locale));
    expect(await screen.findByRole('log', { name: words['player.chat.label'] as string })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: words['player.chat.input'] as string })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: words['player.chat.send'] as string })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('the refusal words, the block words and the phrase words exist and are not English', () => {
    const keys = Object.keys(enChat).filter((k) => /^player.chat.(refused.(link|personal_info|filter|phrases_only|phrase_unknown|account_too_new)|block|unblock|phrase)/.test(k));
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const k of keys) {
      expect(words[k], k).toBeTypeOf('string');
      expect(words[k], k).not.toBe((enChat as Record<string, string>)[k]);
    }
  });

  it('axe: the open box with lines, light and dark, in a 360 px column', async () => {
    w.say('lobby', 'tarvo', 'anyone for a round?');
    for (const theme of ['light', 'dark'] as const) {
      const { container, unmount } = renderUi(box(w.transportFor('snerp'), locale, { theme }));
      await within(await screen.findByRole('log')).findAllByText('anyone for a round?');
      expect(await violations(container), theme).toEqual([]);
      unmount();
    }
  });

  it('axe: reconnecting and closed', async () => {
    const transport = w.transportFor('snerp');
    const { container } = renderUi(box(transport, locale));
    await screen.findByRole('textbox', { name: words['player.chat.input'] as string });
    act(() => transport.status('reconnecting'));
    expect(await violations(container)).toEqual([]);
    act(() => transport.status('closed', 'banned'));
    expect(await violations(container)).toEqual([]);
  });
});

describe.each(['es', 'pt'] as const)('the notice queue in %s', (locale) => {
  it.each(['light', 'dark'] as const)('shows the Spanish or Portuguese notice and passes axe, %s, 360 px', async (theme) => {
    const pw = await playerWorld();
    await pw.sanction(ALICE, 'chat', { durationMs: DAY });
    const t = tFor(locale);
    const { container } = renderUi(
      <div style={{ width: 360 }}>
        <NoticeQueue client={pw.client} now={pw.now} theme={theme} {...FIXED} locale={locale} t={t} />
      </div>,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(CATALOGS[locale]['player.notice.title.chat'] as string)).toBeInTheDocument();
    expect(within(dialog).queryByText(en['player.notice.title.chat'])).toBeNull();
    expect(await violations(container)).toEqual([]);
  });
});

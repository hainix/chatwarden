import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { PlayerT, PlayerText } from '../i18n.js';
import { errorText } from '../ui.js';
import type { Ui } from '../ui.js';
import { failureOf, REFUSAL_MS, refusalText, waitOf } from './Composer.js';
import type { SendResult, WireLine, WirePhrase, WireRefusal } from './wire.js';

/** More phrases than this and the list gets a filter box. */
const FILTER_ABOVE = 12;

/**
 * A phrase as this viewer reads it: the viewer's own catalogue's `phrase.<id>` when it has the key, else the phrase's own (canonical) text. A catalogue that has no text for a key answers with the key itself,
 * so "no key" is that answer (the same rule the chat words use for a host's `t`).
 */
export function phraseText(t: PlayerT, id: string, text: string): string {
  const key = `phrase.${id}`;
  const own = t(key as PlayerText);
  return own === key ? text : own;
}

export interface PhrasePickerProps {
  ui: Ui;
  /** The room's book, from `hello`. */
  phrases: readonly WirePhrase[];
  maxLength: number;
  /** Send one phrase by id: resolves with the kit's answer, rejects when none arrived. */
  send: (phrase: string) => Promise<SendResult>;
  /** The phrase was delivered. */
  onDelivered: (line: WireLine) => void;
  /** The phrase was refused. The box acts on `restricted`, `banned` and `noticeId`; the picker words the rest. */
  onRefused: (refusal: WireRefusal) => void;
  /** The room's mode keeps this viewer from posting: the phrases stay in the tab order but send nothing (`aria-disabled`). */
  paused?: boolean;
  /** The id of the mode's status line, while there is one: it describes the list. */
  modeLine?: string | undefined;
}

interface Section {
  heading: string | null;
  items: Array<{ id: string; text: string; shown: string }>;
}

/**
 * The phrase picker of a phrase-only room, in place of the input: a labelled list of buttons, grouped under headings, with a filter box above 12 phrases. One tab stop (arrow keys, Home and End move between phrases), Enter or
 * Space sends, and the status line under the list says what became of it, in the same words a line's refusal gets.
 */
export function PhrasePicker({ ui, phrases, maxLength, send, onDelivered, onRefused, paused = false, modeLine }: PhrasePickerProps) {
  const { t } = ui;
  const filterId = useId();
  const [query, setQuery] = useState('');
  const [stop, setStop] = useState<string | null>(null);
  const [held, setHeld] = useState(false);
  const [notice, setNotice] = useState<{ text: string; wait: boolean; ok: boolean } | null>(null);
  const sending = useRef(false);
  const waiting = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controls = useRef(new Map<string, HTMLButtonElement>());

  useEffect(
    () => () => {
      clearTimeout(clearTimer.current);
      clearTimeout(waitTimer.current);
    },
    [],
  );

  const show = (text: string, wait: boolean, ok = false): void => {
    clearTimeout(clearTimer.current);
    setNotice(text === '' ? null : { text, wait, ok });
    if (!wait && text !== '') clearTimer.current = setTimeout(() => setNotice(null), REFUSAL_MS);
  };

  const refuse = (refusal: WireRefusal): void => {
    const wait = waitOf(refusal);
    show(refusalText(ui, refusal, maxLength), wait !== null);
    if (wait !== null) {
      clearTimeout(waitTimer.current);
      waiting.current = true;
      setHeld(true);
      waitTimer.current = setTimeout(() => {
        waiting.current = false;
        setHeld(false);
        setNotice(null);
      }, wait);
    }
  };

  const submit = async (id: string, shown: string): Promise<void> => {
    if (paused || sending.current || waiting.current) return;
    sending.current = true;
    try {
      const result = await send(id);
      if (result.ok) {
        show(t('player.chat.phraseSent', { text: shown }), false, true);
        onDelivered(result.line);
      } else {
        refuse(result.refused);
        onRefused(result.refused);
      }
    } catch (error) {
      show(errorText(t, failureOf(error)), false);
    } finally {
      sending.current = false;
    }
  };

  const filterable = phrases.length > FILTER_ABOVE;
  const needle = query.trim().toLowerCase();
  // Each phrase in this viewer's words; the filter reads what is on screen. Ungrouped phrases come first with no heading, then each group in the order it first appears.
  const sections: Section[] = [];
  let total = 0;
  for (const p of phrases) {
    const shown = phraseText(t, p.id, p.text);
    if (needle !== '' && !shown.toLowerCase().includes(needle)) continue;
    total += 1;
    const heading = p.group ?? null;
    let section = sections.find((s) => s.heading === heading);
    if (section === undefined) {
      section = { heading, items: [] };
      if (heading === null) sections.unshift(section);
      else sections.push(section);
    }
    section.items.push({ id: p.id, text: p.text, shown });
  }
  const order = sections.flatMap((s) => s.items.map((i) => i.id));
  // The one tab stop: the phrase last moved to, else the first one shown.
  const active = stop !== null && order.includes(stop) ? stop : (order[0] ?? null);

  const focusAt = (index: number): void => {
    const id = order[(index + order.length) % order.length];
    if (id === undefined) return;
    setStop(id);
    controls.current.get(id)?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const from = order.findIndex((id) => controls.current.get(id) === e.target);
    if (from === -1) return;
    const moves: Record<string, number> = { ArrowDown: from + 1, ArrowRight: from + 1, ArrowUp: from - 1, ArrowLeft: from - 1, Home: 0, End: order.length - 1 };
    const to = moves[e.key];
    if (to === undefined) return;
    e.preventDefault();
    focusAt(to);
  };

  return (
    <div className="cw-chat-form cw-chat-phrases">
      {filterable && (
        <div className="cw-chat-row">
          <label htmlFor={filterId} className="cw-chat-sr">
            {t('player.chat.phraseFilter')}
          </label>
          <input id={filterId} type="search" className="cw-chat-input cw-chat-phrasefilter" placeholder={t('player.chat.phraseFilter')} value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      )}
      <div role="group" aria-label={t('player.chat.phrases')} aria-describedby={modeLine} className="cw-chat-phrasebook" onKeyDown={onKeyDown}>
        {sections.map((section) => (
          <div key={section.heading ?? ''} className="cw-chat-phrasegroup">
            {section.heading !== null && <h4 className="cw-chat-phrasehead">{section.heading}</h4>}
            <ul className="cw-chat-phrases-list">
              {section.items.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    ref={(el) => {
                      if (el === null) controls.current.delete(item.id);
                      else controls.current.set(item.id, el);
                    }}
                    className="cw-btn cw-chat-phrase"
                    tabIndex={item.id === active ? 0 : -1}
                    aria-disabled={paused || held || undefined}
                    onFocus={() => setStop(item.id)}
                    onClick={() => void submit(item.id, item.shown)}
                  >
                    {item.shown}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {total === 0 && <p className="cw-chat-phrasenone">{t('player.chat.phraseNone')}</p>}
      </div>
      {filterable && (
        <p role="status" className="cw-chat-sr">
          {needle !== '' && total > 0 ? t('player.chat.phraseMatches', { count: total }) : ''}
        </p>
      )}
      <div role="status" className="cw-chat-refusal">
        {notice !== null && <p className={notice.ok ? 'cw-chat-sent' : undefined}>{notice.text}</p>}
      </div>
    </div>
  );
}

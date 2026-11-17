import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { PlayerError } from '../client.js';
import { clockText } from '../format.js';
import type { PlayerText } from '../i18n.js';
import { errorText } from '../ui.js';
import type { Ui } from '../ui.js';
import type { SendResult, WireLine, WireRefusal } from './wire.js';

/** How long a refusal stays under the input (a wait stays until it ends). */
const REFUSAL_MS = 8000;
/** The reasons with a sentence of their own; any other gets the generic one. */
const KNOWN = new Set(['length', 'rate', 'gate', 'blocked', 'profanity', 'link', 'personal_info', 'filter', 'slow_mode', 'flood', 'duplicate', 'locked', 'new_account', 'probation']);
/** The reasons whose sentence holds the wait. */
const WITH_WAIT = new Set(['slow_mode', 'flood', 'duplicate', 'probation']);
/** The counter shows in the last this many characters. */
const COUNT_FROM = 20;

/** A failure to send as an error the components can word: anything that is not already a PlayerError is a dropped connection. */
const failureOf = (e: unknown): PlayerError => (e instanceof PlayerError ? e : new PlayerError({ status: 0, code: 'network', message: 'Could not reach the server.' }));

/** The wait as words: whole seconds up to 120, then minutes, rounded up. */
export function waitText(ui: Ui, ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  return seconds <= 120 ? ui.t('player.chat.wait.seconds', { count: seconds }) : ui.t('player.chat.wait.minutes', { count: Math.ceil(seconds / 60) });
}

/** A wait from the answer: a whole number of ms from 1 to an hour; anything else is no wait. */
export function waitOf(refusal: WireRefusal): number | null {
  const ms = refusal.retryAfterMs;
  return typeof ms === 'number' && Number.isInteger(ms) && ms >= 1 && ms <= 3_600_000 ? ms : null;
}

/** The one sentence a refusal gets (or none, for an empty line), with the rule and the notice when it carries them. */
function refusalText(ui: Ui, refusal: WireRefusal, maxLength: number): string {
  if (refusal.reason === 'empty') return '';
  const wait = waitOf(refusal);
  const key = KNOWN.has(refusal.reason) ? refusal.reason : 'unknown';
  // A pace refusal with no valid wait has sentences of its own with no time in them, never "in ." (the wait is bare: the sentence has the "in").
  const soon = wait === null && WITH_WAIT.has(key) ? '.soon' : '';
  const left = wait === null ? '' : waitText(ui, wait);
  let first: string;
  if (key === 'locked') {
    // The room's mode: the same words as the status line above the input. With no end, the sentence has no time in it.
    const until = refusal.until;
    first = typeof until === 'number' && Number.isFinite(until) ? ui.t('player.chat.locked', { time: clockText(until, ui.locale, ui.timeZone) }) : ui.t('player.chat.lockedNoEnd');
  } else if (key === 'new_account') first = ui.t('player.chat.readOnlyNew');
  else if (key === 'probation') first = soon === '' ? ui.t('player.chat.probation', { left }) : ui.t('player.chat.probationSoon');
  else first = ui.t(`player.chat.refused.${key}${soon}` as PlayerText, { max: maxLength, left });
  const parts = [first];
  if (refusal.rule !== undefined) parts.push(ui.t('player.chat.refused.rule', { rule: refusal.rule }));
  if (refusal.noticeId !== undefined) parts.push(ui.t('player.chat.refused.notice'));
  return parts.join(' ');
}

export interface ComposerProps {
  ui: Ui;
  maxLength: number;
  autoFocus: boolean;
  /** Send a line: resolves with the kit's answer, rejects when none arrived. */
  send: (text: string) => Promise<SendResult>;
  /** The line was delivered. */
  onDelivered: (line: WireLine) => void;
  /** The line was refused. The box acts on `restricted`, `banned` and `noticeId`; the composer words the rest. */
  onRefused: (refusal: WireRefusal) => void;
  /**
   * The room's mode keeps this viewer from posting (a lock, or a new account in an emergency): the input stays, in the tab order, but cannot be typed in (`aria-disabled`, read-only) and Send does nothing.
   */
  paused?: boolean;
  /** The id of the mode's status line, while there is one: it describes the input whether or not the viewer can post. */
  modeLine?: string | undefined;
}

/** The one input and its Send button, with the counter and the refusal line. */
export function Composer({ ui, maxLength, autoFocus, send, onDelivered, onRefused, paused = false, modeLine }: ComposerProps) {
  const { t } = ui;
  const inputId = useId();
  const countId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const sending = useRef(false);
  const waiting = useRef(false);
  const composing = useRef(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const waitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [held, setHeld] = useState(false);
  const [notice, setNotice] = useState<{ text: string; wait: boolean } | null>(null);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  useEffect(
    () => () => {
      clearTimeout(clearTimer.current);
      clearTimeout(waitTimer.current);
    },
    [],
  );

  const show = (text: string, wait: boolean): void => {
    clearTimeout(clearTimer.current);
    setNotice(text === '' ? null : { text, wait });
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

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (paused || text === '' || sending.current || waiting.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = await send(text);
      if (result.ok) {
        setDraft('');
        show('', false);
        onDelivered(result.line);
      } else {
        refuse(result.refused);
        onRefused(result.refused);
      }
    } catch (error) {
      show(errorText(t, failureOf(error)), false);
    } finally {
      sending.current = false;
      setBusy(false);
      // The player was typing: keep them there, unless they moved to something else.
      const at = document.activeElement;
      if (at === null || at === document.body || at === button.current) field.current?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== 'Enter' || e.shiftKey || composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    void submit();
  };

  const left = maxLength - draft.length;
  const rows = Math.min(4, Math.max(1, draft.split('\n').length));

  return (
    <form
      className="cw-chat-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={inputId} className="cw-chat-sr">
        {t('player.chat.input')}
      </label>
      <div className="cw-chat-row">
        <textarea
          id={inputId}
          ref={field}
          className="cw-chat-input"
          rows={rows}
          maxLength={maxLength}
          placeholder={t('player.chat.placeholder')}
          value={draft}
          readOnly={paused || undefined}
          aria-disabled={paused || undefined}
          aria-describedby={[modeLine ?? '', left <= COUNT_FROM ? countId : ''].filter((id) => id !== '').join(' ') || undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            // A wait is not cleared by typing: it ends when it ends.
            if (notice !== null && !notice.wait) show('', false);
          }}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        <button ref={button} type="submit" className="cw-btn cw-btn--primary cw-chat-send" disabled={busy || held} aria-disabled={paused || undefined}>
          {t('player.chat.send')}
        </button>
      </div>
      {left <= COUNT_FROM && (
        <p id={countId} className="cw-chat-count">
          {t('player.chat.count', { count: Math.max(0, left) })}
        </p>
      )}
      <div role="status" className="cw-chat-refusal">
        {notice !== null && <p>{notice.text}</p>}
      </div>
    </form>
  );
}

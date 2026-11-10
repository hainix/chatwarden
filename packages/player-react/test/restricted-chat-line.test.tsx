import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RestrictedChatLine } from '../src/RestrictedChatLine.js';
import { createT, en } from '../src/i18n.js';
import { timeLeft, untilText } from '../src/format.js';
import { DAY, HOUR, T0 } from './world.js';

const now = () => T0;
const common = { locale: 'en', timeZone: 'UTC', now } as const;

describe('RestrictedChatLine', () => {
  it('a moderator restriction with an end: what happened, until when, how long is left', () => {
    const until = T0 + 3 * HOUR;
    render(<RestrictedChatLine {...common} until={until} byModerator />);
    expect(screen.getByRole('status')).toHaveTextContent(`A moderator turned off your chat until ${untilText(until, 'en', 'UTC')} (${timeLeft(until, T0, 'en')}).`);
    expect(screen.getByRole('status')).toHaveTextContent('Jan 15, 2027, 11:00 AM (in 3 hours).');
  });

  it('an automatic restriction says the filter caught a message, and does not say a moderator did it', () => {
    const until = T0 + 10 * 60_000;
    render(<RestrictedChatLine {...common} until={until} byModerator={false} />);
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Your chat is off until Jan 15, 2027, 8:10 AM (in 10 minutes). The automatic filter caught a message.');
    expect(line).not.toHaveTextContent('moderator');
  });

  it('a restriction with no end says it does not end on its own, for a moderator and for the filter', () => {
    const { unmount } = render(<RestrictedChatLine {...common} until={null} byModerator />);
    expect(screen.getByRole('status')).toHaveTextContent('A moderator turned off your chat. It does not end on its own.');
    unmount();
    render(<RestrictedChatLine {...common} until={null} byModerator={false} />);
    expect(screen.getByRole('status')).toHaveTextContent('Your chat is off. It does not end on its own. The automatic filter caught a message.');
  });

  it('an end that has passed says when it ended', () => {
    const until = T0 - DAY;
    render(<RestrictedChatLine {...common} until={until} byModerator />);
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent(`Your chat is back on. The restriction ended ${untilText(until, 'en', 'UTC')}.`);
    expect(line).not.toHaveTextContent('in 0');
  });

  it('shows the reference code when there is one, and nothing about it when there is not', () => {
    const { unmount } = render(<RestrictedChatLine {...common} until={T0 + HOUR} byModerator refCode="M-4K7QW" />);
    expect(screen.getByRole('status')).toHaveTextContent('Reference M-4K7QW');
    unmount();
    render(<RestrictedChatLine {...common} until={T0 + HOUR} byModerator />);
    expect(screen.getByRole('status')).not.toHaveTextContent('Reference');
  });

  it('shows a reference code as text, and shows nothing else it was not given', () => {
    const { container } = render(<RestrictedChatLine {...common} until={T0 + HOUR} byModerator refCode={'<b>M-1</b>'} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container).toHaveTextContent('<b>M-1</b>');
  });

  it('has a card for the restriction (decoration) beside the words', () => {
    const { container } = render(<RestrictedChatLine {...common} until={T0 + HOUR} byModerator />);
    expect(container.querySelector('.cw-card')).toHaveClass('cw-card--restriction');
    expect(container.querySelector('.cw-card')).toHaveAttribute('aria-hidden', 'true');
  });

  it('takes its words from t, and its theme and className from props', () => {
    const t = createT({ ...en, 'player.restricted.moderator.until': 'Chat aus bis {when} ({left}).' }, 'de');
    const until = T0 + 3 * HOUR;
    const { container } = render(<RestrictedChatLine {...common} t={t} locale="de" until={until} byModerator theme="dark" className="z" />);
    expect(screen.getByRole('status')).toHaveTextContent(/^Chat aus bis .* \(in 3 Stunden\)\.$/);
    const root = container.querySelector('.cw-player') as HTMLElement;
    expect(root).toHaveAttribute('data-cw-theme', 'dark');
    expect(root).toHaveClass('z');
  });

  it('a value that is not a finite time is treated as no end, never as "Invalid Date"', () => {
    render(<RestrictedChatLine {...common} until={Number.NaN} byModerator />);
    expect(screen.getByRole('status')).toHaveTextContent('A moderator turned off your chat. It does not end on its own.');
    expect(screen.getByRole('status')).not.toHaveTextContent('Invalid');
  });

  it('uses the real clock when no now is given', () => {
    render(<RestrictedChatLine locale="en" timeZone="UTC" until={Date.now() + 3 * HOUR} byModerator />);
    expect(screen.getByRole('status')).toHaveTextContent('(in 3 hours)');
  });
});

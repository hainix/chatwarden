import { render } from '@testing-library/react';
import type { PlayerReporting } from '@chatwarden/core';
import type { ReactElement } from 'react';
import { userEvent } from '@testing-library/user-event';

/** Renders a component with a user-event instance; the components take no provider, so this is all it needs. */
export function renderUi(ui: ReactElement) {
  const user = userEvent.setup();
  const utils = render(ui);
  return { ...utils, user };
}

/** The props every test passes so a time is the same wherever the tests run: English, in UTC. */
export const FIXED = { locale: 'en', timeZone: 'UTC' } as const;

/** Waits for the thank-you in a report dialog: its status region is always there, so the text in it is what to wait for. */
export async function findStatus(): Promise<HTMLElement> {
  const { screen } = await import('@testing-library/react');
  return (await screen.findAllByText(/./, { selector: '[role="status"] p' }))[0] as HTMLElement;
}

/**
 * A `reporting` payload that makes the dialog a required picker over the six reasons the kit's 0.1.1 categories had, each with a note
 * field: the vehicle for tests of the form itself (focus, double submit, refusals). The flows have their own tests in report-flows.
 */
export const SIX_REASONS: PlayerReporting = {
  flow: 'reason_required',
  thanks: '',
  reasons: [
    ['harassment', 'Harassment'],
    ['hate', 'Hateful language'],
    ['cheating', 'Cheating'],
    ['spam', 'Spam'],
    ['disruption', 'Disrupting the game'],
    ['other', 'Something else'],
  ].map(([id, label]) => ({ id: id as string, label: label as string, hint: '', group: '', asksNote: true })),
};

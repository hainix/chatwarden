import { render } from '@testing-library/react';
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

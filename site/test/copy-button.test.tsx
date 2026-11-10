import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CopyButton } from '../src/components/CopyButton';

function stubClipboard(impl: (t: string) => Promise<void>) {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  return writeText;
}

describe('CopyButton', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });

  it('is a real button with an accessible name that says what it copies', () => {
    stubClipboard(async () => {});
    render(<CopyButton text="npm i x" label="Copy install command" />);
    const btn = screen.getByRole('button', { name: 'Copy install command' });
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('writes the exact text to the clipboard and confirms', async () => {
    const writeText = stubClipboard(async () => {});
    render(<CopyButton text="npm i @chatwarden/core" label="Copy" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith('npm i @chatwarden/core');
    expect(screen.getByRole('status').textContent).toBe('Copied');
    expect(screen.getByRole('button').textContent).toContain('Copied');
  });

  it('goes back to idle after a moment', async () => {
    stubClipboard(async () => {});
    render(<CopyButton text="a" label="Copy" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('status').textContent).toBe('Copied');
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    expect(screen.getByRole('status').textContent).toBe('');
    expect(screen.getByRole('button').textContent).not.toContain('Copied');
  });

  it('can be copied again after it resets', async () => {
    const writeText = stubClipboard(async () => {});
    render(<CopyButton text="a" label="Copy" />);
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fireEvent.click(screen.getByRole('button'));
      });
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
    }
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('says so, and does not claim success, when the clipboard refuses', async () => {
    stubClipboard(async () => {
      throw new Error('denied');
    });
    render(<CopyButton text="a" label="Copy" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    const status = screen.getByRole('status').textContent ?? '';
    expect(status).not.toBe('Copied');
    expect(status).toMatch(/copy failed/i);
  });

  it('does not throw when there is no clipboard API at all', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<CopyButton text="a" label="Copy" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(screen.getByRole('status').textContent).toMatch(/copy failed|copied/i);
  });

  it('announces through a polite live region', () => {
    stubClipboard(async () => {});
    render(<CopyButton text="a" label="Copy" />);
    const status = screen.getByRole('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
  });
});

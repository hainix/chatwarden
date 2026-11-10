import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeToggle } from '../src/components/ThemeToggle';
import { applyTheme, readStoredTheme } from '../src/lib/theme';

function stubMatchMedia(light: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: q.includes('light') ? light : !light,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
    stubMatchMedia(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('defaults to dark when nothing is stored and the OS has no light preference', () => {
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/light/i);
  });

  it('follows prefers-color-scheme: light on a first visit', () => {
    stubMatchMedia(true);
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/dark/i);
  });

  it('a stored choice beats the OS preference', () => {
    stubMatchMedia(true);
    localStorage.setItem('cw-theme', 'dark');
    render(<ThemeToggle />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/light/i);
  });

  it('toggles, writes data-theme and remembers', () => {
    render(<ThemeToggle />);
    act(() => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('cw-theme')).toBe('light');
    act(() => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem('cw-theme')).toBe('dark');
  });

  it('still works when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    render(<ThemeToggle />);
    act(() => {
      fireEvent.click(screen.getByRole('button'));
    });
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores a junk stored value', () => {
    localStorage.setItem('cw-theme', 'purple');
    expect(readStoredTheme()).toBeNull();
  });

  it('applyTheme sets the attribute', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

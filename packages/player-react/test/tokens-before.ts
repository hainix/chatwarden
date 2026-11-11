// What the stylesheet declared for each token BEFORE the tokens were made private (--cw-x -> --cwd-x), copied from the stylesheet as it
// stood at HEAD 89e99bd (the same change hub-react made at Task 7j). The tokens test checks that, with nothing overridden, every
// token resolves to these same values in both themes. --cw-font is not here on purpose: the player leaves it unset and inherits.

export const TOKENS_BEFORE: Record<string, string> = {
  "--cw-surface": "light-dark(#ffffff, #151c28)",
  "--cw-surface-sunken": "light-dark(#eef0f4, #111722)",
  "--cw-border": "light-dark(#e0e3ea, #242d3c)",
  "--cw-border-strong": "light-dark(#7a8397, #6b7893)",
  "--cw-ink": "light-dark(#151b27, #e8ebf1)",
  "--cw-ink-muted": "light-dark(#4f5a6e, #9ba4b6)",
  "--cw-accent": "light-dark(#2950d3, #7d9bff)",
  "--cw-accent-ink": "light-dark(#ffffff, #0e131c)",
  "--cw-accent-soft": "light-dark(#e7ecfb, #1d2847)",
  "--cw-red": "light-dark(#c42f3b, #ff6b74)",
  "--cw-red-soft": "light-dark(#fbe4e6, #3a1a1f)",
  "--cw-yellow": "light-dark(#e5ad00, #f2c84b)",
  "--cw-shadow-ink": "light-dark(#151b27, #000000)",
  "--cw-text-s": "0.8125rem",
  "--cw-text-m": "0.9375rem",
  "--cw-text-l": "1.125rem",
  "--cw-leading": "1.5",
  "--cw-radius": "10px",
  "--cw-radius-s": "6px",
  "--cw-border-width": "1px",
  "--cw-space-1": "0.25rem",
  "--cw-space-2": "0.5rem",
  "--cw-space-3": "0.75rem",
  "--cw-space-4": "1rem",
  "--cw-space-5": "1.5rem",
  "--cw-control-height": "2.5rem",
  "--cw-dialog-width": "30rem",
  "--cw-layer": "1000",
};

/** The light-only values the `@supports not (color: light-dark())` block declared. */
export const FALLBACK_BEFORE: Record<string, string> = {
  "--cw-surface": "#ffffff",
  "--cw-surface-sunken": "#eef0f4",
  "--cw-border": "#e0e3ea",
  "--cw-border-strong": "#7a8397",
  "--cw-ink": "#151b27",
  "--cw-ink-muted": "#4f5a6e",
  "--cw-accent": "#2950d3",
  "--cw-accent-ink": "#ffffff",
  "--cw-accent-soft": "#e7ecfb",
  "--cw-red": "#c42f3b",
  "--cw-red-soft": "#fbe4e6",
  "--cw-yellow": "#e5ad00",
  "--cw-shadow-ink": "#151b27",
};

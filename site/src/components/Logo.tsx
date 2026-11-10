/** The warden glyph: a shield holding a chat bubble with a tick. Colours come from CSS variables. */
export function WardenGlyph({ size = 32 }: { size?: number }) {
  return (
    <svg viewBox="0 0 32 36" width={size} height={(size * 36) / 32} aria-hidden="true" focusable="false">
      <path
        d="M16 1.5 29.5 6.8v11.2c0 8-5.6 13.6-13.5 16.5C8.1 31.6 2.5 26 2.5 18V6.8Z"
        fill="var(--warden)"
        stroke="var(--logo-edge)"
        strokeWidth="2.5"
        strokeLinejoin="round"
      />
      <path
        d="M9.5 11.5h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H17l-3.5 3.2v-3.2h-4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"
        fill="var(--logo-edge)"
      />
      <path d="m12 16.6 2.6 2.6 5.2-5.4" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Glyph plus the wordmark, as one SVG image. The wordmark is set in the self-hosted display face. */
export function Logo({ height = 34 }: { height?: number }) {
  return (
    <svg
      role="img"
      aria-label="Chatwarden"
      viewBox="0 0 188 36"
      height={height}
      width={(height * 188) / 36}
      className="logo"
    >
      <g transform="translate(0 0)">
        <path
          d="M16 1.5 29.5 6.8v11.2c0 8-5.6 13.6-13.5 16.5C8.1 31.6 2.5 26 2.5 18V6.8Z"
          fill="var(--warden)"
          stroke="var(--logo-edge)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        />
        <path
          d="M9.5 11.5h13a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H17l-3.5 3.2v-3.2h-4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z"
          fill="var(--logo-edge)"
        />
        <path d="m12 16.6 2.6 2.6 5.2-5.4" fill="none" stroke="var(--accent)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <text
        x="40"
        y="26"
        fill="var(--text)"
        fontFamily="'Bungee', 'Arial Black', Impact, sans-serif"
        fontSize="21"
        textLength="146"
        lengthAdjust="spacingAndGlyphs"
      >
        chatwarden
      </text>
    </svg>
  );
}

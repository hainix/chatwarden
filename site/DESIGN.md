# chatwarden.dev: design direction

**Arena at night, warden on duty.** A dark game-arena backdrop (faint grid, two colour glows) with chunky arcade controls,
and one calm teal "warden" that does the protecting. It should read as a game studio's site and still be credible to an engineer.

The one memorable thing is the hero chat HUD: lines arrive, and when an invented slur is sent it is struck through and a
**REFUSED!** stamp slams onto it. Everything else stays quiet and disciplined so that moment lands.

## Palette tokens (CSS variables in `src/styles.css`)

| Token | Dark | Light | Job |
| --- | --- | --- | --- |
| `--bg` | `#0a0d1a` | `#f6f4ff` | page |
| `--panel` / `--panel-hi` | `#141a31` / `#1b2342` | `#ffffff` / `#f1eeff` | cards, hover |
| `--edge` | `#2c376a` | `#1d1a42` | chunky 2px borders and hard shadows |
| `--text` / `--muted` | `#eef1ff` / `#aab4dc` | `#17133a` / `#4a4676` | copy |
| `--accent` | `#ff3d8f` hot magenta | `#d10f6c` | the one hot colour: primary button, the stamp, limits |
| `--warden` | `#35e3c5` teal | `#12a58e` (text `#0a6b5d`) | the signature colour: logo, icons, "available", focus-adjacent |
| `--gold` | `#ffc83d` | `#8a5a00` | step numbers, "coming soon" pills |

"Screens" (the hero HUD, code blocks, the install pill and the demo panes) stay dark in both themes, like a terminal on a
desk. Syntax colours: keyword `#ff80b9`, string `#6ff0d6`, comment `#8c97c6`, number `#ffd479`, call `#94b8ff`.
Contrast is AA or better for text on every surface (button text is the dark ink on magenta in dark mode, white on the deeper
magenta in light mode). Dark is the default; `prefers-color-scheme: light` is honoured on a first visit, and the toggle
stores the choice in `localStorage` (guarded, the page works without it).

## Type

- Display: **Bungee** (SIL OFL), self-hosted, Latin subset, 14 KB woff2. Used only for h1, h2, the logo wordmark, step
  numbers, the HUD title and the stamp. It is wide and chunky, so it is kept to short lines.
- Body: **Atkinson Hyperlegible Next** (SIL OFL), self-hosted variable woff2, Latin subset, 34 KB. Chosen for legibility.
- Code: the system monospace stack. No download.

Scale: hero `clamp(2.35rem, 1.1rem + 5.2vw, 4.6rem)`, h2 `clamp(1.7rem, 1.1rem + 2.6vw, 2.7rem)`, h3 `1.1875rem`
(bold body face), body `1.0625rem` / 1.6, small `0.9375rem`. Body lines are capped near 34 to 44em. Headings are
sentence-case content set in a display face, never tracked-out caps labels above a heading.

Licences for both fonts sit in `public/fonts/OFL-*.txt`.

## Shape and structure

- Chunky 2px borders, 6px radius (10px for big "screens"), hard offset shadows instead of soft blur: arcade-panel feel.
- HUD corner ticks on cards (teal L-brackets) that grow on hover.
- Dashed borders mean "not here yet" (coming-soon pills, AI levels 1 to 4, the demo slot). Solid teal means live.
- Numbers appear only where the content is a sequence: the three steps and AI levels 0 to 4.
- Alignment: left-aligned throughout, one 1120px column, alternating plain and tinted bands for rhythm.

## Motion

- One orchestrated moment on load: hero chat lines pop in, the refused line shakes, strikes through and gets the stamp.
  "Replay" restarts it.
- Motion that answers a person: buttons press down (hard shadow collapses), cards lift, copy buttons confirm, FAQ chevrons turn.
- No scroll-triggered entrance effects.
- `prefers-reduced-motion: reduce` turns every animation and transition off. Every animated element's base style is its
  final state, so the page is complete without motion.

## Logo

An SVG wordmark: a teal shield (the warden) holding a dark chat bubble with a magenta tick, then "chatwarden" set in
Bungee (`src/components/Logo.tsx`; the same mark is `public/favicon.svg`). The glyph and wordmark use the theme tokens
so they work on both backgrounds.

## Performance and accessibility rules this design keeps

- No third-party script, font, analytics or tracker; every asset is same-origin. `test/dist.test.ts` scans the build.
- Fonts use `font-display: swap`; the display face is preloaded. Initial JS is about 78 KB gzip.
- Semantic landmarks, a skip link, one h1, labelled sections, visible 3px focus rings, 44px touch targets, native
  `<details>` for the FAQ, focusable scrollable code blocks, copy results announced in a polite live region.
- Works at 360px: single column, no horizontal scroll, the stamp moves to the bubble's bottom edge so the line stays readable.

## Honesty rules the copy keeps

No customer logos (only the true "Used by Moxgate"), no invented numbers, install commands and code come from the READMEs
(`test/content.test.ts`), AI levels 1 to 4 are marked coming soon, the hub UI is marked coming while the HTTP admin API
and Discord feed are described as shipping, and "free forever, no SLA" is stated plainly. Demo words are the invented
terms from `@chatwarden/matcher/fixtures` only.

// What the two scripted players say. Bo is the troublemaker, but only with trash talk, plus ONE invented blocked word in the
// opening. The real kit counts blocked lines: three inside an hour earn an automatic 30 minute timeout. So the loop below
// has none, and Bo can never time himself out however long the page is open (test/kitReal.test.ts plays ten loops).
// `rude` is a UI hint for the tour (which of Bo's lines to point at); the kit never reads tone, the demo's heuristic does.

export interface ScriptLine {
  seat: 'ada' | 'bo';
  text: string;
  rude?: boolean;
}

/** The conversation that is already in the room when the demo opens. */
export const SEED: readonly ScriptLine[] = [
  { seat: 'ada', text: 'gg, that last clutch was wild' },
  { seat: 'bo', text: "ez, you're trash lol" },
  { seat: 'bo', text: 'you absolute zorbak' }, // refused: only Bo sees it, staff see it in a report
  { seat: 'ada', text: 'ok that was close' },
  { seat: 'bo', text: "uninstall the game, you're hopeless", rude: true },
];

/** What they say next, one line about every 4 to 6 seconds, round and round. No blocked words: see the note at the top. */
export const LOOP: readonly ScriptLine[] = [
  { seat: 'ada', text: 'rematch?' },
  { seat: 'bo', text: "sure, i'll carry again" },
  { seat: 'ada', text: 'ha, you wish' },
  { seat: 'bo', text: 'that was embarrassing, uninstall already', rude: true },
  { seat: 'ada', text: 'nice dodge on the boss' },
  { seat: 'bo', text: 'who even picked you for this team' },
  { seat: 'ada', text: 'gg, same lobby after this?' },
  { seat: 'bo', text: 'worthless team, honestly', rude: true },
  { seat: 'ada', text: 'my bad, lag spike' },
  { seat: 'bo', text: 'ez' },
  { seat: 'ada', text: 'one more round' },
  { seat: 'bo', text: 'fine. last one' },
];

export interface TourStep {
  title: string;
  body: string;
  /** The last two steps look at the hub's settings and the other view; the tour is complete without them. */
  optional?: boolean;
}

/**
 * The tour on the real hub. The hub has no tour-hook option, so the page points at its controls by their accessible names (see
 * hubTarget.ts); the words here use the names the hub shows.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: 'Report a message',
    body: 'Bo is being rude. Press Report on one of Bo’s lines, then Report again. One tap files it, and the thank-you can wait.',
  },
  {
    title: 'The case appears in the hub',
    body: 'The report is in the moderator hub with the chat as its evidence. The hub never moves the list under your cursor, so a new case waits behind a “1 new case” pill. Close the thank-you if it is open, then press the pill.',
  },
  {
    title: 'Open it in Simple',
    body: 'Open the case. Simple mode is one card: what Bo said, their record and the ladder’s suggestion. If it asks which rule this breaks, pick one.',
  },
  {
    title: 'Apply the suggestion',
    body: 'Press the suggested step. An Undo bar shows for five seconds before it is sent; press Undo to take it back, or wait.',
  },
  {
    title: 'The player sees the notice',
    body: 'Bo now has a notice. Press See what Bo sees to open the player’s own dialog, then acknowledge it.',
  },
  {
    title: 'The Detailed switch',
    body: 'Simple is the hub’s default view. The Simple and Detailed switch in the top bar opens the full workbench for a bigger team.',
    optional: true,
  },
  {
    title: 'Steps and ladder',
    body: 'Press More, then Steps and ladder (in Detailed it is under Settings). The 1, 6 and 12 hour lengths moderators can pick are set there, and an owner can edit them.',
    optional: true,
  },
];

export const NO_NOTICE_HINT = 'That choice tells the player nothing. Report a line again and apply a step to see their screen.';
export const NO_REPORT_HINT = 'Nothing to decide yet. Report a line first.';

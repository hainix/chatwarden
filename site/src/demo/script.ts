// What the two scripted players say. Bo is the troublemaker, but only with trash talk and the invented blocked words.
// `rude` is a UI hint for the tour (which of Bo's lines to point at); the engine decides what is rude on its own.

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

/** What they say next, one line about every 4 to 6 seconds, round and round. */
export const LOOP: readonly ScriptLine[] = [
  { seat: 'ada', text: 'rematch?' },
  { seat: 'bo', text: "sure, i'll carry again" },
  { seat: 'ada', text: 'ha, you wish' },
  { seat: 'bo', text: 'that was embarrassing, uninstall already', rude: true },
  { seat: 'ada', text: 'nice dodge on the boss' },
  { seat: 'bo', text: 'who even picked you, snerp' }, // refused: only Bo sees it
  { seat: 'ada', text: 'gg, same lobby after this?' },
  { seat: 'bo', text: 'worthless team, honestly', rude: true },
  { seat: 'ada', text: 'my bad, lag spike' },
  { seat: 'bo', text: 'ez' },
  { seat: 'ada', text: 'one more round' },
  { seat: 'bo', text: 'fine. last one' },
];

export const TOUR_STEPS = [
  {
    title: 'Say something bad',
    body: 'Send a line with one of the invented blocked words, like zorbak.',
  },
  {
    title: 'Report a line',
    body: 'Bo is being rude. Press Report on one of Bo’s lines and say why.',
  },
  {
    title: 'Decide',
    body: 'Now you are the moderator. Read the evidence, then warn, time out, note it or let it go.',
  },
  {
    title: 'See the player’s view',
    body: 'This is what Bo sees: their own line only, blocked words starred out. Press Acknowledge.',
  },
] as const;

export const NO_NOTICE_HINT = 'That choice tells the player nothing. Report a line again and pick Warn to see their screen.';
export const NO_REPORT_HINT = 'Nothing to decide yet. Report a line first.';

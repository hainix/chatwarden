// What the two scripted players say. Bo is the troublemaker, but only with trash talk, plus ONE invented blocked word in the
// opening. The real kit counts blocked lines: three inside an hour earn an automatic 30 minute timeout. So nothing they say after
// the opening has one, and Bo can never time himself out (test/kitReal.test.ts plays the replies, the thanks and ten loops).
// `rude` is a UI hint for the tour (which of Bo's lines to point at); the kit never reads tone, the demo's heuristic does.
//
// The room is finite and reactive (docs/design/2026-11-11-site-copy-rewrite.md, fix A): the opening plays once and then the room
// goes quiet. Ada and Bo answer only when something happens: a line the visitor sends, a decision. Nothing on a timer moves the
// chat under the visitor's pointer. The old endless script is kept as LOOP, behind `scripted="loop"`, for tests of the chat's
// scrolling and the Pause button.

export interface ScriptLine {
  seat: 'ada' | 'bo';
  text: string;
  rude?: boolean;
}

/** The conversation that is already in the room when the demo opens. It ends on Bo's rude line, the one the tour points at. */
export const SEED: readonly ScriptLine[] = [
  { seat: 'ada', text: 'gg, that last clutch was wild' },
  { seat: 'bo', text: "ez, you're trash lol", rude: true },
  { seat: 'bo', text: 'you absolute zorbak' }, // blocked: only Bo sees it, staff see it in a report
  { seat: 'ada', text: 'ok that was close' },
  { seat: 'bo', text: "uninstall the game, you're hopeless", rude: true },
];

/** One of these answers a line the visitor sends, two seconds later, round and round. No blocked words: see the note at the top. */
export const REPLIES: readonly ScriptLine[] = [
  { seat: 'ada', text: 'ha, fair enough' },
  { seat: 'bo', text: 'sure, whatever' },
  { seat: 'ada', text: 'nice, same lobby after this?' },
  { seat: 'bo', text: 'ok ok, one more round' },
];

/** What Ada says after a moderator decides. Bo adds a line only if the decision left him able to chat. */
export const THANKS: ScriptLine = { seat: 'ada', text: 'thanks mods' };
export const AFTERWARDS: ScriptLine = { seat: 'bo', text: 'ok ok, my bad' };

/** The pause before a reply, in milliseconds. */
export const REPLY_DELAY_MS = 2000;
export const THANKS_DELAY_MS = 1500;

/** The old endless script, one line about every 4 to 6 seconds, round and round. Only `scripted="loop"` plays it. */
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
}

/**
 * The tour on the real hub. The hub has no tour-hook option, so the page points at its controls by their accessible names (see
 * hubTarget.ts); the words here use the names the hub and the game pane show ("1 new case", "See Bo's screen"). Each title is an
 * instruction: on a phone it is the bar's whole text.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    title: "Report Bo's message",
    body: 'Bo\'s being rude. Press Report next to his highlighted message, choose "Insults or harassment", then press Report.',
  },
  {
    title: 'Open the report in the hub',
    body: 'It just reached your moderator hub, with the chat around it as evidence. A case is all the open reports about one player. Press "1 new case", then open Bo\'s case.',
  },
  {
    title: 'Take the suggested action',
    body: "This is the hub's default view: one card per player. It shows what Bo said, his history, and the action your rules suggest. Press the suggested action. You have five seconds to undo.",
  },
  {
    title: 'See what Bo sees',
    body: "Bo gets a plain notice: what he did, which rule, and for how long. Press See Bo's screen.",
  },
];

/** Shown when the picked action tells the player nothing. */
export const NO_NOTICE_HINT = "You chose no action, so Bo isn't told anything. Report another message and take the suggested action to see his notice.";
/** Shown on a hub step when nothing has been reported yet. */
export const NO_REPORT_HINT = "Nothing to handle yet. Report one of Bo's messages first.";
/** Shown when the report named no reason, so the hub's card asks for a rule first. */
export const RULE_PICKER_HINT = 'Pick the rule this breaks. The hub then suggests an action.';

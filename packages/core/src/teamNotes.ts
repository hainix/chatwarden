import { ProfileError } from './profileError.js';
import { cleanText, given, plain, wholeIn } from './settingsCheck.js';

/**
 * Team notes: short working guidance for the moderation team ("weigh distinct tables over raw counts"). Staff only: a note is never
 * shown to a player, and it reaches the AI read as one screened line. A note may cite the Community Rule it is about.
 */
export interface TeamNote {
  /** The note, one line of 1 to {@link TEAM_NOTE_MAX} characters once cleaned. */
  text: string;
  /** The number of the Community Rule the note is about (a retired rule is allowed). Optional. */
  rule?: number;
}

/** The most notes a profile may hold. */
export const TEAM_NOTES_MAX = 30;
/** The most characters (code points) in one note. */
export const TEAM_NOTE_MAX = 500;

const NOTE_KEYS = ['text', 'rule'] as const;

/**
 * Check and clean a list of team notes, returning a fresh list of `{ text }` or `{ text, rule }`. Text has control, bidi and
 * zero-width characters removed, is trimmed, and is joined to one line; an empty or too long text is refused, never cut. A refusal is a
 * {@link ProfileError} naming the path, never the value.
 */
export function resolveTeamNotes(input: readonly TeamNote[] | undefined, path = 'teamNotes'): TeamNote[] {
  if (input === undefined) return [];
  if (!Array.isArray(input)) throw new ProfileError(path, 'must be a list of notes');
  if (input.length > TEAM_NOTES_MAX) throw new ProfileError(path, `must hold at most ${TEAM_NOTES_MAX} notes`);
  return (input as readonly unknown[]).map((item, i) => {
    const at = `${path}[${i}]`;
    const o = plain(item, NOTE_KEYS, at, 'must be an object with a text');
    const text = cleanText(given(o, 'text'), `${at}.text`, 1, TEAM_NOTE_MAX, true);
    const rule = given(o, 'rule');
    if (rule === undefined) return { text };
    return { text, rule: wholeIn(rule, 1, Number.MAX_SAFE_INTEGER, `${at}.rule`) };
  });
}

/**
 * Every note that cites a rule must cite one the registry has (a retired rule still counts: its number is never reused). Checked where the
 * rules are known: at creation for a code profile, and when a layer is saved or previewed. Throws {@link ProfileError} naming `<path>[i].rule`.
 */
export function checkTeamNoteRules(notes: readonly TeamNote[], ruleExists: (n: number) => boolean, path: string): void {
  notes.forEach((note, i) => {
    if (note.rule !== undefined && !ruleExists(note.rule)) throw new ProfileError(`${path}[${i}].rule`, 'must be the number of a Community Rule');
  });
}

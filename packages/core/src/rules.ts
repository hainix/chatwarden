import type { RulesFlavour } from './profile.js';
import type { ReportCategory } from './types.js';

/**
 * The numbered Community Rules. Pure data and lookups: no store, no IO.
 *
 * A rule number is never reused or renumbered. A rule that no longer applies stays listed with `retired: true`, so
 * old records that cite it still read correctly. `defineRules(next, { previous })` enforces this at the point a
 * rules list is changed.
 */
export interface CommunityRule {
  number: number;
  title: string;
  /** One or two plain sentences. The AI read is prompted from this text, so it has to say what it means. */
  text: string;
  retired?: boolean;
}

/** A rule a sanction can cite: a numbered rule, or `'uncovered'` when no rule fits yet. */
export type RuleRef = number | 'uncovered';

/** A rules list that fails validation. The message never carries chat text or an identifier. */
export class RulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulesError';
  }
}

/**
 * Read a stored rule (`'1'`, `'12'` or `'uncovered'`) back into a `RuleRef`. The one conversion point between the
 * TEXT a sanction row keeps and the typed value the rest of the code uses. Throws `RulesError` for anything else;
 * the message never echoes the bad text.
 */
export function parseRuleRef(text: string): RuleRef {
  if (text === 'uncovered') return 'uncovered';
  if (typeof text === 'string' && /^[1-9][0-9]*$/.test(text)) {
    const n = Number(text);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new RulesError('Not a stored rule reference');
}

export class CommunityRules {
  private readonly byNumber = new Map<number, CommunityRule>();
  private readonly sorted: CommunityRule[];

  constructor(rules: readonly CommunityRule[]) {
    this.sorted = rules.map((x) => ({ ...x })).sort((a, b) => a.number - b.number);
    for (const rule of this.sorted) this.byNumber.set(rule.number, rule);
  }

  /** A rule by number, retired ones included. */
  get(n: number): CommunityRule | undefined {
    const rule = this.byNumber.get(n);
    return rule === undefined ? undefined : { ...rule };
  }

  /** Rules a moderator may still cite, in number order. */
  active(): CommunityRule[] {
    return this.sorted.filter((x) => x.retired !== true).map((x) => ({ ...x }));
  }

  /** Every rule, retired ones included, in number order. */
  all(): CommunityRule[] {
    return this.sorted.map((x) => ({ ...x }));
  }

  /** True for an active rule number and for `'uncovered'`. A retired or unknown rule is not citable. */
  isCitable(ref: RuleRef): boolean {
    if (ref === 'uncovered') return true;
    const rule = this.byNumber.get(ref);
    return rule !== undefined && rule.retired !== true;
  }

  /** The player-facing name of a rule. A retired rule keeps its title; an unknown number has none. */
  label(ref: RuleRef): string {
    if (ref === 'uncovered') return 'Not covered by a rule yet';
    const rule = this.byNumber.get(ref);
    return rule === undefined ? `Community Rule ${ref}` : `Community Rule ${rule.number}: ${rule.title}`;
  }
}

/**
 * Trim a title or text and check it is one non-empty line. A line break is refused, not flattened: the text goes
 * into the AI read's prompt one rule per line, so a line break would let a rule smuggle in extra prompt lines.
 */
function cleanLine(v: unknown, n: number, what: string): string {
  if (typeof v !== 'string' || v.trim() === '') throw new RulesError(`Rule ${n} needs ${what}`);
  const trimmed = v.trim();
  if (/[\r\n]/.test(trimmed)) throw new RulesError(`Rule ${n} ${what} must be a single line`);
  return trimmed;
}

/**
 * Validate a rules list and build the registry. Throws `RulesError` on a duplicate number, a number that is not a
 * positive integer, an empty title or text, or a line break in a title or text. Surrounding whitespace is trimmed.
 *
 * With `previous`, a number that was in the previous list and is missing from `next` is refused: a rule can be
 * retired, never removed or renumbered.
 */
export function defineRules(
  rules: readonly CommunityRule[],
  options: { previous?: readonly CommunityRule[] | CommunityRules } = {},
): CommunityRules {
  const seen = new Set<number>();
  const clean: CommunityRule[] = [];
  for (const rule of rules) {
    const n: unknown = rule.number;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
      throw new RulesError('A rule number must be a positive whole number');
    }
    if (seen.has(n)) throw new RulesError(`Rule number ${n} is used twice`);
    seen.add(n);
    clean.push({ ...rule, title: cleanLine(rule.title, n, 'a title'), text: cleanLine(rule.text, n, 'text') });
  }
  const { previous } = options;
  if (previous !== undefined) {
    const before = previous instanceof CommunityRules ? previous.all() : previous;
    for (const old of before) {
      if (!seen.has(old.number)) {
        throw new RulesError(`Rule ${old.number} cannot be removed or renumbered: retire it instead`);
      }
    }
  }
  return new CommunityRules(clean);
}

/** The starter rules for the standard profile. {@link starterRules} copies and adjusts them per profile flavour. */
const STANDARD_RULES: readonly CommunityRule[] = [
  {
    number: 1,
    title: 'No slurs or hate aimed at who someone is',
    text: 'Do not use slurs, or put someone down for their race, religion, gender, sexuality, disability or similar. This applies to what you say about other players and about anyone else.',
  },
  {
    number: 2,
    title: 'No insulting, threatening or targeting another player',
    text: 'Do not insult, threaten or target another player as a person in chat. Talk about the game itself, like destroying or killing an opposing unit or character in play, is fine.',
  },
  {
    number: 3,
    title: 'No sexual messages',
    text: 'Do not send sexual messages or comments, and do not pressure anyone for them.',
  },
  {
    number: 4,
    title: 'No spam, flooding or advertising',
    text: 'Do not repeat the same message, flood the chat or advertise. Stick to talking about the game and the people in it.',
  },
  {
    number: 5,
    title: 'No cheating or exploiting',
    text: 'Do not cheat, or use a bug or loophole to get an unfair edge. Report bugs instead of using them.',
  },
  {
    number: 6,
    title: 'No throwing, stalling or ruining games on purpose',
    text: 'Do not lose on purpose, stall the game or leave a game running just to spoil it for others. Play to finish, or concede.',
  },
  {
    number: 7,
    title: 'No offensive names',
    text: 'Do not pick a name that breaks any other rule here, such as a slur, a sexual name or a name aimed at another player.',
  },
  {
    number: 8,
    title: 'No false reports',
    text: 'Do not report someone to get them in trouble when they have not broken a rule. Use reports for real problems.',
  },
];

/** CR 2 where trash talk is part of the game: the moderator's wording. */
const RELAXED_CR2: Pick<CommunityRule, 'title' | 'text'> = {
  title: 'No harassment or threats',
  text: "Trash talk about the game and each other's play is fine. Harassing, threatening or personally attacking someone, again and again, is not.",
};

/** CR 2 where swearing is not allowed: it also covers swearing aimed at a player. */
const STRICT_CR2_TEXT =
  'Do not insult, swear at, threaten or target another player in chat. Talking about the game itself is fine; aiming it at a person is not.';

/**
 * The starter Community Rules for a profile flavour: a fresh copy each call, so editing one list changes no other.
 * The numbers and titles are the same in every flavour, so a rule number means the same thing under any profile;
 * only the wording a profile needs differs:
 * - `relaxed`: CR 2 is "No harassment or threats", with trash talk about the game explicitly fine.
 * - `standard`: the original starter set (what {@link STARTER_RULES} holds).
 * - `strict`: CR 2 also covers swearing aimed at a player (CR 3 stays the standard text).
 *
 * Throws {@link RulesError} for any other flavour. No flavour uses the vocabulary of a single game.
 */
export function starterRules(flavour: RulesFlavour): CommunityRule[] {
  if (flavour !== 'relaxed' && flavour !== 'standard' && flavour !== 'strict') {
    throw new RulesError("A starter rules flavour must be 'relaxed', 'standard' or 'strict'");
  }
  return STANDARD_RULES.map((rule) => {
    if (flavour === 'relaxed' && rule.number === 2) return { number: 2, ...RELAXED_CR2 };
    if (flavour === 'strict' && rule.number === 2) return { ...rule, text: STRICT_CR2_TEXT };
    return { ...rule };
  });
}

/** The standard profile's starter rules, kept for compatibility: `starterRules('standard')`. */
export const STARTER_RULES: CommunityRule[] = starterRules('standard');

/** The rule a report category points to by default. A moderator can still pick another. */
export const CATEGORY_TO_RULE: Record<ReportCategory, RuleRef> = {
  hate: 1,
  harassment: 2,
  spam: 4,
  cheating: 5,
  disruption: 6,
  other: 'uncovered',
};

/**
 * A numbered plain-text rendering of the active rules, one line each: `CR n. Title: text`. The AI read is prompted
 * from this, so the model and the moderators judge against the same words.
 */
export function rulesPolicyText(rules: CommunityRules | readonly CommunityRule[]): string {
  const list = rules instanceof CommunityRules ? rules.active() : defineRules(rules).active();
  return list.map((x) => `CR ${x.number}. ${x.title}: ${x.text}`).join('\n');
}

import type { GuidelineTier } from '../profile.js';
import { CONDUCT_LEVELS } from '../types.js';
import { looksLikeInjection } from './injection.js';
import { cleanText } from './redact.js';

// The team's moderation principles as the AI read sees them (design 2026-11-18, sections 3.3, 5.2 and 5.7): one line per guideline tier
// that covers a conduct level, then the team notes, screened and capped. Pure and deterministic. It sits in the AI folder so the prompt can use it
// without widening the folder's import allowlist; `core/src/principles.ts` is its public face.

/** The longest tier line, in code points. */
export const PRINCIPLES_LINE_MAX = 400;
/** The longest whole block (the tier lines and the kept note lines, joined by newlines), in code points. */
export const PRINCIPLES_BLOCK_MAX = 4000;

/**
 * What was left out of the prompt, as indexes into the profile's `guidelines` and `teamNotes`. `tiers` were screened (the tier line keeps its
 * title and covers only, or only its covers when the title was the flagged field); `notes` were screened and left out; `capped` were dropped
 * for length (a kept prefix: the first note that does not fit and every one after it, ascending); `aiContext` is true when the AI standard was
 * screened and left out.
 */
export interface PromptExcluded {
  tiers: number[];
  notes: number[];
  capped: number[];
  aiContext: boolean;
}

/** The principles block as the prompt gets it, and what was excluded. */
export interface PromptPrinciples {
  lines: string[];
  excluded: PromptExcluded;
}

/** What {@link promptPrinciples} reads of a profile. Structural, so a resolved profile, a profile as written and a plain object all fit. */
export interface PrinciplesInput {
  guidelines: readonly GuidelineTier[];
  teamNotes?: ReadonlyArray<{ text: string; rule?: number | undefined }> | undefined;
  aiContext?: string | undefined;
}

const len = (s: string): number => Array.from(s).length;
const cut = (s: string, n: number): string => Array.from(s).slice(0, n).join('');
const isLevel = (c: string): boolean => (CONDUCT_LEVELS as readonly string[]).includes(c);

/** One tier line, fitted: examples dropped from the last, then the description cut and ended with "...", and as a last resort the whole line cut. */
function fitLine(title: string, levels: string, description: string, examples: readonly string[]): string {
  const head = `- ${title === '' ? '' : `${title} `}(covers: ${levels})`;
  const withTail = (desc: string, ex: readonly string[]): string =>
    `${head}${desc === '' ? '' : `: ${desc}`}${ex.length === 0 ? '' : `${desc === '' ? ':' : ''} Examples: ${ex.join('; ')}`}`;
  let ex = [...examples];
  for (;;) {
    const line = withTail(description, ex);
    if (len(line) <= PRINCIPLES_LINE_MAX) return line;
    if (ex.length === 0) break;
    ex = ex.slice(0, -1);
  }
  // Examples are all gone and the line is still too long: cut the description, if there is room for any of it.
  const room = PRINCIPLES_LINE_MAX - len(`${head}: `) - 3;
  if (description !== '' && room > 0) return `${head}: ${cut(description, room).trimEnd()}...`;
  return cut(withTail(description, []), PRINCIPLES_LINE_MAX);
}

/**
 * The principles block for the AI prompt. Tier lines first: `- <title> (covers: <levels>): <description> Examples: <examples>` for each tier
 * that covers a conduct level (a tier covering only `repeated` or `after_warning` has no line), never the tier outcome. Then one
 * `- Team note: <text>` line per note. All text is cleaned (NFKC, invisible characters out, one line) and screened by `looksLikeInjection`: a flagged
 * tier keeps its title and covers only, a flagged note is left out. The block is capped at {@link PRINCIPLES_BLOCK_MAX}: tiers are always
 * kept, notes are a kept prefix. Never throws on a validated profile.
 */
export function promptPrinciples(profile: PrinciplesInput): PromptPrinciples {
  const excluded: PromptExcluded = { tiers: [], notes: [], capped: [], aiContext: false };
  const tierLines: string[] = [];
  profile.guidelines.forEach((tier, i) => {
    const levels = tier.covers.filter(isLevel);
    if (levels.length === 0) return;
    const title = cleanText(tier.title);
    const description = cleanText(tier.description);
    const examples = tier.examples.map(cleanText).filter((e) => e !== '');
    const titleFlagged = looksLikeInjection(title);
    const flagged = titleFlagged || looksLikeInjection(description) || examples.some(looksLikeInjection);
    if (flagged) {
      excluded.tiers.push(i);
      tierLines.push(fitLine(titleFlagged ? '' : title, levels.join(', '), '', []));
      return;
    }
    tierLines.push(fitLine(title, levels.join(', '), description, examples));
  });

  const noteLines: string[] = [];
  let used = len(tierLines.join('\n'));
  let full = false;
  (profile.teamNotes ?? []).forEach((note, i) => {
    const text = cleanText(note.text);
    if (text === '') return;
    if (looksLikeInjection(text)) {
      excluded.notes.push(i);
      return;
    }
    const line = `- Team note: ${text}`;
    const next = used + (tierLines.length + noteLines.length > 0 ? 1 : 0) + len(line);
    if (full || next > PRINCIPLES_BLOCK_MAX) {
      full = true;
      excluded.capped.push(i);
      return;
    }
    noteLines.push(line);
    used = next;
  });

  excluded.aiContext = typeof profile.aiContext === 'string' && looksLikeInjection(cleanText(profile.aiContext));
  return { lines: [...tierLines, ...noteLines], excluded };
}

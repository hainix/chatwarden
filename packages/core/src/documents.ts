import { DEFAULT_SEVERE_RULES, lengthLabel, outcomeLabel } from './ladder.js';
import type { LadderCell } from './ladder.js';
import { validateProfile } from './profile.js';
import type { GuidelineCover, GuidelineTier, ModerationProfile, Outcome } from './profile.js';
import type { CommunityRule, CommunityRules } from './rules.js';
import { CONDUCT_LEVELS } from './types.js';
import type { ConductLevel } from './types.js';

/**
 * Generated policy documents. One source of truth, the resolved profile and the Community Rules, produces every
 * document, so the text a player reads, the guide a moderator follows, the brief an agent is given and the
 * enforcement itself cannot drift apart. Every function here is pure: the same policy gives the same text.
 *
 * Each document is first built as a few plain blocks (headings, paragraphs, lists, tables) and then rendered to
 * `markdown`, `html` or `text`. Every interpolated value is reduced to one line and escaped for the format it lands
 * in, so a team-written title, a game name or a rule text can neither add structure nor inject markup.
 */

/** The shapes a document can be rendered in. */
export type DocumentFormat = 'markdown' | 'html' | 'text';

/** What every document is generated from. */
export interface DocumentPolicy {
  profile: ModerationProfile;
  rules: CommunityRules;
}

/** Options for {@link codeOfConduct}. */
export interface CodeOfConductOptions {
  format: DocumentFormat;
  /** Named in the title and the "mistake" section. */
  gameName: string;
  /** Where a player can contest a decision. Linked only when it is an http(s) URL; anything else is left out. */
  contactUrl?: string;
}

/**
 * The sections of the moderator guide a caller may leave out: `rules` (the Community Rules list) and `ladder` (the escalation
 * ladder: its heading, the step note, the table and the notes on area and severe rules). The moderator hub draws both from data
 * and asks for the rest of the guide.
 */
export const GUIDE_SECTIONS = ['rules', 'ladder'] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

/** Options for {@link moderatorGuide}. */
export interface ModeratorGuideOptions {
  format: DocumentFormat;
  /** Sections to leave out. Default none: the whole guide. The rest keeps its order. */
  omitSections?: readonly GuideSection[];
}

/** The policy as data, for tools that import it. */
export interface PolicyJson {
  version: 1;
  profile: ModerationProfile;
  /** Every rule, retired ones included, in number order. */
  rules: CommunityRule[];
}

/** The documents bound to one policy: `cw.documents`. */
export interface Documents {
  codeOfConduct(options: CodeOfConductOptions): string;
  moderatorGuide(options: ModeratorGuideOptions): string;
  agentBrief(): string;
  policyJson(): PolicyJson;
}

// ---------------------------------------------------------------------------------------------------------------
// Blocks and renderers

type Inline = string | { strong: string } | { link: string; href: string };
type Rich = string | readonly Inline[];
type Block =
  | { k: 'h'; level: 1 | 2 | 3; text: string }
  | { k: 'p'; text: Rich }
  | { k: 'ul'; items: Rich[] }
  | { k: 'table'; head: string[]; rows: string[][] };

const FORMATS: readonly string[] = ['markdown', 'html', 'text'];

/** Collapse every run of whitespace and control characters (line breaks included) to one space. */
function flat(v: string): string {
  return v.replace(/[\p{Cc}\s]+/gu, ' ');
}

/** A value from outside this file (team text, a name, a rule): one trimmed line. */
function clean(v: string): string {
  return flat(v).trim();
}

function parts(r: Rich): readonly Inline[] {
  return typeof r === 'string' ? [r] : r;
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] ?? c);
}

/** Escape what would break Markdown structure inside a line. */
function escapeMarkdown(v: string): string {
  return flat(v).replace(/[\\`*_[\]<>&|~#]/g, '\\$&');
}

/** Escape what would start a block when a value opens a line (a list marker, a rule, an ordered list, `=`). */
function escapeLineStart(v: string): string {
  return v.replace(/^([-+=])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2').replace(/^\s+/, '');
}

/** Make a link destination safe inside `(...)` of a Markdown link. */
function markdownDestination(href: string): string {
  return href.replace(/[()\\<>\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

function renderMarkdownInline(r: Rich): string {
  return parts(r)
    .map((p, i) => {
      if (typeof p === 'string') {
        const escaped = escapeMarkdown(p);
        return i === 0 ? escapeLineStart(escaped) : escaped;
      }
      if ('strong' in p) return `**${escapeMarkdown(p.strong.trim())}**`;
      return `[${escapeMarkdown(p.link)}](${markdownDestination(p.href)})`;
    })
    .join('')
    .trim();
}

function renderHtmlInline(r: Rich): string {
  return parts(r)
    .map((p) => {
      if (typeof p === 'string') return escapeHtml(flat(p));
      if ('strong' in p) return `<strong>${escapeHtml(flat(p.strong.trim()))}</strong>`;
      return `<a href="${escapeHtml(p.href)}" rel="noopener">${escapeHtml(flat(p.link))}</a>`;
    })
    .join('')
    .trim();
}

function renderTextInline(r: Rich): string {
  return parts(r)
    .map((p) => {
      if (typeof p === 'string') return flat(p);
      if ('strong' in p) return flat(p.strong);
      return `${flat(p.link)} (${p.href})`;
    })
    .join('')
    .trim();
}

function renderMarkdown(blocks: readonly Block[]): string {
  const out = blocks.map((b): string => {
    switch (b.k) {
      case 'h':
        return `${'#'.repeat(b.level)} ${escapeMarkdown(b.text).trim()}`;
      case 'p':
        return renderMarkdownInline(b.text);
      case 'ul':
        return b.items.map((item) => `- ${renderMarkdownInline(item)}`).join('\n');
      case 'table': {
        const row = (cells: readonly string[]): string => `| ${cells.map((c) => escapeMarkdown(c).trim()).join(' | ')} |`;
        return [row(b.head), `| ${b.head.map(() => '---').join(' | ')} |`, ...b.rows.map(row)].join('\n');
      }
    }
  });
  return `${out.join('\n\n')}\n`;
}

function renderHtml(blocks: readonly Block[]): string {
  const out = blocks.map((b): string => {
    switch (b.k) {
      case 'h':
        return `<h${b.level}>${escapeHtml(clean(b.text))}</h${b.level}>`;
      case 'p':
        return `<p>${renderHtmlInline(b.text)}</p>`;
      case 'ul':
        return `<ul>\n${b.items.map((item) => `<li>${renderHtmlInline(item)}</li>`).join('\n')}\n</ul>`;
      case 'table': {
        const head = b.head.map((c) => `<th scope="col">${escapeHtml(clean(c))}</th>`).join('');
        const rows = b.rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(clean(c))}</td>`).join('')}</tr>`);
        return `<table>\n<thead>\n<tr>${head}</tr>\n</thead>\n<tbody>\n${rows.join('\n')}\n</tbody>\n</table>`;
      }
    }
  });
  return `${out.join('\n')}\n`;
}

function renderText(blocks: readonly Block[]): string {
  const out = blocks.map((b): string => {
    switch (b.k) {
      case 'h': {
        const text = clean(b.text);
        if (b.level === 1) return `${text}\n${'='.repeat(text.length)}`;
        if (b.level === 2) return `${text}\n${'-'.repeat(text.length)}`;
        return text;
      }
      case 'p':
        return renderTextInline(b.text);
      case 'ul':
        return b.items.map((item) => `- ${renderTextInline(item)}`).join('\n');
      case 'table': {
        const row = (cells: readonly string[]): string => cells.map((c) => clean(c)).join(' | ');
        return [row(b.head), ...b.rows.map(row)].join('\n');
      }
    }
  });
  return `${out.join('\n\n')}\n`;
}

function render(blocks: readonly Block[], format: DocumentFormat): string {
  if (format === 'markdown') return renderMarkdown(blocks);
  if (format === 'html') return renderHtml(blocks);
  return renderText(blocks);
}

// ---------------------------------------------------------------------------------------------------------------
// Checks

function checkSections(sections: unknown): ReadonlySet<GuideSection> {
  if (sections === undefined) return new Set();
  if (!Array.isArray(sections) || !sections.every((x) => typeof x === 'string' && (GUIDE_SECTIONS as readonly string[]).includes(x))) {
    throw new RangeError(`omitSections must be a list of: ${GUIDE_SECTIONS.join(', ')}`);
  }
  return new Set(sections as GuideSection[]);
}

function checkFormat(format: unknown): DocumentFormat {
  if (typeof format !== 'string' || !FORMATS.includes(format)) {
    throw new RangeError("A document format must be 'markdown', 'html' or 'text'");
  }
  return format as DocumentFormat;
}

/** The policy must be one the kit could enforce: the profile is validated (a `ProfileError` names the field). */
function checkPolicy(policy: DocumentPolicy): void {
  const p: unknown = policy;
  if (typeof p !== 'object' || p === null) throw new TypeError('A document policy needs a profile and rules');
  const rules = (p as { rules?: unknown }).rules;
  if (typeof rules !== 'object' || rules === null || typeof (rules as { active?: unknown }).active !== 'function') {
    throw new TypeError('A document policy needs a profile and rules');
  }
  validateProfile((p as { profile?: unknown }).profile);
}

/**
 * The URL as a link target, or null. Only `http:` and `https:` with a host and no embedded credentials; no
 * whitespace or control characters. The result is the parsed, percent-encoded form.
 */
function safeLink(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t === '' || t.length > 2000 || /[\p{Cc}\s]/u.test(t)) return null;
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.hostname === '' || url.username !== '' || url.password !== '') return null;
  return url.href;
}

// ---------------------------------------------------------------------------------------------------------------
// Wording shared by the documents

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function cellOutcome(c: LadderCell): Outcome {
  if (c.kind === 'warning' || c.kind === 'note') return c.kind;
  return { kind: c.kind, durationMs: c.durationMs };
}

/** The player's side of an outcome, as a clause: `you get a warning`, `your chat is restricted for 24 hours`. */
function clause(o: Outcome): string {
  if (o === 'none') return 'nothing happens';
  if (o === 'note') return 'the moderators may keep a private record';
  if (o === 'warning') return 'you get a warning';
  const len = o.durationMs === null ? 'good' : lengthLabel(o.durationMs);
  if (o.kind === 'chat') return `your chat is restricted for ${len}`;
  if (o.kind === 'area') return `you are banned from public rooms and matchmaking for ${len}`;
  return `you are banned for ${len}`;
}

/** An outcome as a noun phrase: `a warning`, `a chat timeout of 24 hours`, `a permanent ban`. */
function noun(o: Outcome): string {
  if (o === 'none') return 'no action';
  if (o === 'note') return 'a private record';
  if (o === 'warning') return 'a warning';
  if (o.kind === 'chat') return o.durationMs === null ? 'a permanent chat restriction' : `a chat timeout of ${lengthLabel(o.durationMs)}`;
  if (o.kind === 'area') {
    return o.durationMs === null
      ? 'a permanent ban from public rooms and matchmaking'
      : `a ban from public rooms and matchmaking for ${lengthLabel(o.durationMs)}`;
  }
  return o.durationMs === null ? 'a permanent ban' : `a ban of ${lengthLabel(o.durationMs)}`;
}

function capitalise(s: string): string {
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
}

function sentence(s: string): string {
  const t = clean(s);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function withoutStop(s: string): string {
  return clean(s).replace(/[.!?]+$/, '');
}

/** The moderator-facing statement of the repeat rule, shared by the guide and the agent brief. */
function repeatRule(profile: ModerationProfile): string {
  const r = profile.repeat;
  const games = r.distinctGames ? ', from different games,' : '';
  return `${plural(r.notes, 'note')} in ${plural(r.windowDays, 'day')}${games} counts as repeated: ${outcomeLabel(r.outcome)}`;
}

function coverName(c: GuidelineCover): string {
  if (c === 'repeated') return 'repeated behaviour';
  if (c === 'after_warning') return 'after a warning';
  return c;
}

function isLevel(c: GuidelineCover): c is ConductLevel {
  return (CONDUCT_LEVELS as readonly string[]).includes(c);
}

/** `CR 5. Title` for each active rule in `numbers`, in the order given. Retired and unknown numbers are skipped. */
function ruleLabels(rules: CommunityRules, numbers: readonly number[] | undefined): Array<{ number: number; title: string }> {
  const out: Array<{ number: number; title: string }> = [];
  for (const n of numbers ?? []) {
    const rule = rules.get(n);
    if (rule !== undefined && rule.retired !== true && !out.some((o) => o.number === n)) out.push({ number: n, title: clean(rule.title) });
  }
  return out;
}

/** What each record step means: the one definition the guide and the agent brief share. */
const RECORD_STEPS =
  '0 is notes only, 1 is a warning, 2 is a chat or area restriction under 7 days (or two warnings), 3 is a restriction of 7 days or more or a ban under 7 days, 4 is a ban of 7 to 29 days, 5 is a ban of 30 days or more or anything permanent';

const DEFAULT_AREA_RULES: readonly number[] = [5, 6];

function areaRuleList(policy: DocumentPolicy): Array<{ number: number; title: string }> {
  return ruleLabels(policy.rules, policy.profile.areaRules ?? DEFAULT_AREA_RULES);
}

function severeRuleList(policy: DocumentPolicy): Array<{ number: number; title: string }> {
  return ruleLabels(policy.rules, policy.profile.severeRules ?? DEFAULT_SEVERE_RULES);
}

function ruleItems(rules: CommunityRules): Rich[] {
  return rules.active().map((rule): Rich => [{ strong: `CR ${rule.number}. ${clean(rule.title)}` }, `: ${clean(rule.text)}`]);
}

function listOf(items: readonly string[]): string {
  return items.map((i) => clean(i)).join(', ');
}

// ---------------------------------------------------------------------------------------------------------------
// Code of conduct (players)

/** What the repeat rule means to a player. */
function repeatForPlayer(profile: ModerationProfile): string {
  const r = profile.repeat;
  const times = r.notes <= 2 ? 'again' : `${r.notes} times`;
  const where = r.distinctGames ? (r.notes <= 2 ? ' in a different game' : ' in different games') : '';
  return `If you do it ${times}${where} within ${plural(r.windowDays, 'day')}, ${clause(r.outcome)}.`;
}

/** What happens after a warning, taken from the ladder's rows. */
function afterWarningForPlayer(profile: ModerationProfile): string {
  const next = profile.ladder[1];
  const last = profile.ladder[profile.ladder.length - 1];
  const nextText = next === undefined ? 'a stricter action' : noun(cellOutcome(next.lowMedium));
  const lastText = last === undefined ? 'a permanent ban' : noun(cellOutcome(last.lowMedium));
  return `If you carry on after a warning, the next step is at least ${nextText}. It gets stricter each time, up to ${lastText}.`;
}

function playerTierBlocks(profile: ModerationProfile, tier: GuidelineTier): Block[] {
  const blocks: Block[] = [{ k: 'h', level: 3, text: clean(tier.title) }];
  const levels = tier.covers.filter(isLevel);

  const counts: string[] = levels.map((l) => sentence(profile.levels[l].meaning));
  if (levels.length === 0 && tier.covers.includes('after_warning')) counts.push('Carrying on after you have been warned.');
  if (counts.length > 0) blocks.push({ k: 'p', text: [{ strong: 'What counts:' }, ` ${counts.join(' ')}`] });

  const happens: Rich[] = [];
  let repeatPrinted = false;
  for (const cover of tier.covers) {
    if (isLevel(cover)) {
      const first = profile.firstOffense[cover];
      const prefix = levels.length > 1 ? `${withoutStop(profile.levels[cover].meaning)}: ` : '';
      let text: string;
      if (first === 'none') text = 'Nothing happens.';
      else if (first === 'note') text = 'The moderators may keep a private record.';
      else text = `The first time, ${clause(first)}.`;
      happens.push(`${prefix}${prefix === '' ? text : text.charAt(0).toLowerCase() + text.slice(1)}`);
      if (first === 'note' && !repeatPrinted) {
        // The repeat rule counts notes, so it is only true of a level whose first offense IS a note.
        happens.push(repeatForPlayer(profile));
        repeatPrinted = true;
      }
      if (cover === 'severe') happens.push('This is acted on straight away, whatever your record.');
    } else if (cover === 'repeated') {
      // Elsewhere a first offense is already an action, so a repeat follows the ladder, which only gets stricter.
      if (!levels.some((l) => profile.firstOffense[l] === 'note')) happens.push('If you carry on, each action is stricter than the last.');
    } else {
      happens.push(afterWarningForPlayer(profile));
    }
  }
  if (happens.length > 0) {
    blocks.push({ k: 'p', text: [{ strong: 'What happens:' }] });
    blocks.push({ k: 'ul', items: happens });
  }

  const examples = tier.examples.map((e) => `"${clean(e)}"`);
  if (examples.length > 0) blocks.push({ k: 'p', text: `For example: ${examples.join(', ')}.` });
  return blocks;
}

function swearingForPlayer(profile: ModerationProfile): string {
  switch (profile.profanity.mode) {
    case 'allow':
      return 'Swearing is allowed in chat. Swearing on its own is never a reason for action. Aiming abuse at a player is covered by the rules above.';
    case 'star':
      return 'Swear words are replaced with stars in chat. Swearing on its own is never a reason for action. Aiming abuse at a player is covered by the rules above.';
    case 'refuse':
      return 'Messages with swear words are not sent, and you will see a message when that happens. Swearing on its own is never a reason for action. Aiming abuse at a player is covered by the rules above.';
  }
}

/**
 * The player-facing code of conduct, for a website or a rules page: the summary, the numbered Community Rules, what
 * happens in plain words, how to report, what a notice means and what to do about a mistake. It is written to
 * "you" and uses none of the moderators' internal terms; records are only ever "a private record".
 *
 * `gameName` must be a non-empty string. `contactUrl` is linked only when it is an http(s) URL with a host, no
 * embedded credentials and no whitespace; anything else is left out and the section stays. Every interpolated value
 * is escaped for the format. Retired rules are omitted. Throws `RangeError` for an unknown format or a missing game
 * name and `ProfileError` for an invalid profile.
 */
export function codeOfConduct(policy: DocumentPolicy, options: CodeOfConductOptions): string {
  checkPolicy(policy);
  const format = checkFormat(options.format);
  const gameName = typeof options.gameName === 'string' ? clean(options.gameName) : '';
  if (gameName === '') throw new RangeError('A code of conduct needs a game name');
  const href = safeLink(options.contactUrl);
  const { profile, rules } = policy;
  const firstRule = rules.active()[0];
  const example = firstRule === undefined ? '' : ` (for example, CR ${firstRule.number})`;

  const blocks: Block[] = [
    { k: 'h', level: 1, text: `${gameName} code of conduct` },
    { k: 'p', text: clean(profile.summary) },
    { k: 'h', level: 2, text: 'The rules' },
    { k: 'ul', items: ruleItems(rules) },
    { k: 'h', level: 2, text: 'What happens if you break a rule' },
    { k: 'p', text: 'What happens depends on what you did and on whether it has happened before. Reported messages are reviewed before a decision is made.' },
  ];
  for (const tier of profile.guidelines) blocks.push(...playerTierBlocks(profile, tier));

  const area = areaRuleList(policy);
  const severe = severeRuleList(policy);
  if (area.length > 0 || severe.length > 0) blocks.push({ k: 'h', level: 3, text: 'Some rules work differently' });
  if (area.length > 0) {
    const names = area.map((r) => `CR ${r.number} (${r.title})`).join(' or ');
    blocks.push({ k: 'p', text: `A chat timeout is a ban from public rooms and matchmaking instead when you break ${names}.` });
  }
  if (severe.length > 0) {
    const names = severe.map((r) => `CR ${r.number} (${r.title})`).join(' or ');
    blocks.push({ k: 'p', text: `Breaking ${names} is always treated as serious, whatever your record.` });
  }

  blocks.push(
    { k: 'h', level: 2, text: 'Swearing' },
    { k: 'p', text: swearingForPlayer(profile) },
    { k: 'h', level: 2, text: 'How to report' },
    {
      k: 'p',
      text: 'Use the report option in the game. Pick the reason that fits best and describe what happened. Recent chat from that game is reviewed before a decision is made.',
    },
    {
      k: 'p',
      text: 'Only report real problems. If the moderators decide not to act on a report, that is not a problem for you. Reports made on purpose to get someone in trouble can mean you lose the ability to report.',
    },
    { k: 'h', level: 2, text: 'If you get a notice' },
    {
      k: 'p',
      text: `If you are warned or restricted, you will see a notice. It shows the rule number${example} and a reference code that starts with M-. Keep the code: you will need it if you contact us about the decision.`,
    },
    { k: 'h', level: 2, text: "Think it's a mistake?" },
  );
  if (href === null) {
    blocks.push({ k: 'p', text: `If you think a decision was a mistake, contact the moderators of ${gameName} and quote the reference code from your notice.` });
  } else {
    blocks.push({
      k: 'p',
      text: ['If you think a decision was a mistake, ', { link: 'contact the moderators', href }, ' and quote the reference code from your notice.'],
    });
  }
  return render(blocks, format);
}

// ---------------------------------------------------------------------------------------------------------------
// Moderator guide (moderators)

function profanityForModerators(profile: ModerationProfile): string[] {
  const p = profile.profanity;
  const out: string[] = [];
  if (p.mode === 'allow') out.push('Swearing is allowed in chat and is left alone.');
  else if (p.mode === 'star') out.push(`Swearing is replaced with stars in chat (style: ${p.style}).`);
  else out.push('A message with swearing is refused before it is sent.');
  if (p.add.length > 0) out.push(`Extra words treated as swearing: ${listOf(p.add)}.`);
  if (p.remove.length > 0) out.push(`Built-in words allowed here: ${listOf(p.remove)}.`);
  if (p.only !== null) out.push(`Only these words count as swearing: ${listOf(p.only)}.`);
  out.push(`Word lists: ${listOf(p.languages)}.`);
  out.push('The profanity filter never creates a strike, note, sanction or notice. Swearing aimed at a player is still judged as rude.');
  return out;
}

function aiForModerators(profile: ModerationProfile): string {
  return profile.aiAutoAct.length === 0
    ? 'The AI may not act on its own: a moderator decides every report.'
    : `The AI may act on its own for: ${listOf(profile.aiAutoAct)}. It never acts on its own for banter or rude; a moderator decides those.`;
}

/**
 * The moderators' guide: the rules, the levels with meanings and examples, the team's guideline tiers, the
 * first-offense outcomes, the repeat rule, the escalation ladder, and the standing guidance (writing a reason,
 * dismissed reports, rule-gap notes, what is private). It uses the internal terms, so it is not for players.
 * Retired rules are omitted. Throws `RangeError` for an unknown format and `ProfileError` for an invalid profile.
 */
export function moderatorGuide(policy: DocumentPolicy, options: ModeratorGuideOptions): string {
  checkPolicy(policy);
  const format = checkFormat(options.format);
  const omit = checkSections(options.omitSections);
  const { profile, rules } = policy;

  const blocks: Block[] = [
    { k: 'h', level: 1, text: `Moderator guide: ${profile.name}` },
    { k: 'p', text: clean(profile.summary) },
    {
      k: 'p',
      text: 'This guide is generated from the moderation profile and the Community Rules in force, so it matches what the kit enforces. It is for the moderation team: do not publish it.',
    },
    ...(omit.has('rules') ? [] : ([{ k: 'h', level: 2, text: 'Community Rules' }, { k: 'ul', items: ruleItems(rules) }] as Block[])),
    { k: 'h', level: 2, text: 'Conduct levels' },
    {
      k: 'table',
      head: ['Level', 'Meaning', 'Examples'],
      rows: CONDUCT_LEVELS.map((l) => [l, clean(profile.levels[l].meaning), profile.levels[l].examples.map(clean).join('; ')]),
    },
    { k: 'h', level: 2, text: 'Our guidelines' },
  ];
  for (const tier of profile.guidelines) {
    blocks.push(
      { k: 'h', level: 3, text: clean(tier.title) },
      { k: 'p', text: clean(tier.description) },
    );
    if (tier.examples.length > 0) blocks.push({ k: 'p', text: `Examples: ${tier.examples.map(clean).join('; ')}` });
    blocks.push(
      { k: 'p', text: `Covers: ${tier.covers.map(coverName).join(', ')}` },
      { k: 'p', text: `Outcome: ${clean(tier.outcome)}` },
    );
  }

  blocks.push(
    { k: 'h', level: 2, text: 'First offense' },
    { k: 'p', text: 'What a person with a clean record gets for each level.' },
    { k: 'table', head: ['Level', 'Outcome'], rows: CONDUCT_LEVELS.map((l) => [l, outcomeLabel(profile.firstOffense[l])]) },
    { k: 'p', text: 'Banter is never acted on, whatever the record.' },
    { k: 'h', level: 2, text: 'Repeated behaviour' },
    { k: 'p', text: `${capitalise(repeatRule(profile))}.` },
    {
      k: 'p',
      text: 'Repeated applies while the person has no warning or restriction on record; once they do, the ladder below applies. At least one earlier note is always needed. Revoked notes, and notes older than the window, do not count. An escalation is never milder than the first-offense outcome.',
    },
  );
  if (!omit.has('ladder')) {
    blocks.push(
      { k: 'h', level: 2, text: 'Escalation ladder' },
      {
        k: 'p',
        text: `A person's step is the heaviest action on their record in the last 90 days. Step ${RECORD_STEPS}.`,
      },
      {
        k: 'table',
        head: ['Step', 'Low / medium (banter, rude)', 'High (hostile with a record, severe)'],
        rows: profile.ladder.map((row) => [String(row.step), clean(row.lowMedium.label), clean(row.high.label)]),
      },
    );
    const area = areaRuleList(policy);
    if (area.length > 0) {
      blocks.push({
        k: 'p',
        text: `Rules that turn a chat restriction into a ban from public rooms and matchmaking at the same length: ${area.map((r) => `CR ${r.number}. ${r.title}`).join('; ')}.`,
      });
    }
    const severe = severeRuleList(policy);
    if (severe.length > 0) {
      blocks.push({ k: 'p', text: `Rules that always read the High column: ${severe.map((r) => `CR ${r.number}. ${r.title}`).join('; ')}.` });
    }
  }

  blocks.push(
    { k: 'h', level: 2, text: 'The AI read' },
    { k: 'p', text: aiForModerators(profile) },
    { k: 'h', level: 2, text: 'Profanity' },
    { k: 'ul', items: profanityForModerators(profile) },
    { k: 'h', level: 2, text: 'Writing a reason' },
    {
      k: 'p',
      text: 'Write the reason in your own words: what was said, and why it breaks the rule you cite. The reason is for the record. The player never sees it, only the rule number and a reference code.',
    },
    { k: 'h', level: 2, text: 'Dismissing a report' },
    {
      k: 'p',
      text: 'A dismissed report is not bad faith; bad faith needs evidence. Use no_action when a report does not hold up. Use bad_faith only when you can write down the evidence of deliberate abuse of the report tool (for example, reports made to get someone in trouble when no rule was broken), and then only as the evidence shows.',
    },
    { k: 'h', level: 2, text: 'Rule gaps' },
    {
      k: 'p',
      text: 'When no Community Rule fits what happened, cite "uncovered" and write a rule-gap note: what happened, and which rule would have covered it. Gap notes are reviewed together; each is closed as a new rule or as not a rule.',
    },
    { k: 'h', level: 2, text: 'What is private' },
    {
      k: 'p',
      text: 'Notes are private. A note is a record for moderators only: the player is not told, and it restricts nothing. The reason you write, a rule-gap note, the reporter and any AI output are private too.',
    },
  );
  return render(blocks, format);
}

// ---------------------------------------------------------------------------------------------------------------
// Agent brief (coding agents and the AI read)

/**
 * A compact, stable plain-text statement of the policy, for a coding agent's `AGENTS.md`, a support bot or the AI
 * read's prompt: the rules, then the levels, then the outcomes, then what the AI may do on its own. The same policy
 * always gives the same text, so it can be a cached prompt prefix. Values are reduced to one line each, so a
 * team-written value cannot add a line of policy. Retired rules are omitted.
 */
export function agentBrief(policy: DocumentPolicy): string {
  checkPolicy(policy);
  const { profile, rules } = policy;
  const lines: string[] = [
    `Moderation policy for ${clean(profile.name)} (generated by Chatwarden)`,
    `Summary: ${clean(profile.summary)}`,
    '',
    'RULES',
    ...rules.active().map((r) => `CR ${r.number}. ${clean(r.title)}: ${clean(r.text)}`),
    '',
    'CONDUCT LEVELS',
    ...CONDUCT_LEVELS.map((l) => {
      const d = profile.levels[l];
      const examples = d.examples.length > 0 ? ` (examples: ${d.examples.map(clean).join('; ')})` : '';
      return `${l}: ${clean(d.meaning)}${examples}`;
    }),
    '',
    'OUTCOMES',
    'First offense, with a clean record:',
    ...CONDUCT_LEVELS.map((l) => `- ${l}: ${outcomeLabel(profile.firstOffense[l])}`),
    `Repeated: ${repeatRule(profile)}. Applies only while the record holds no warning or restriction, and is never milder than the first offense.`,
    `Record steps: ${RECORD_STEPS}.`,
    'Escalation after the first offense. Step = heaviest action on the record in the last 90 days. Low = banter and rude; high = hostile once the record has a warning or restriction, and severe:',
    ...profile.ladder.map((row) => `- step ${row.step}: low ${clean(row.lowMedium.label)} | high ${clean(row.high.label)}`),
  ];
  const area = areaRuleList(policy);
  if (area.length > 0) {
    lines.push(`A chat restriction becomes a ban from public rooms and matchmaking (same length) for: ${area.map((r) => `CR ${r.number}`).join(', ')}.`);
  }
  const severe = severeRuleList(policy);
  if (severe.length > 0) lines.push(`Always read the high column for: ${severe.map((r) => `CR ${r.number}`).join(', ')}.`);
  lines.push(
    'Guidelines:',
    ...profile.guidelines.map((t) => `- ${clean(t.title)} (covers: ${t.covers.map(coverName).join(', ')}): ${clean(t.outcome)}`),
    `Profanity: ${profile.profanity.mode}. The profanity filter never creates a strike, note, sanction or notice. Swearing aimed at a player is still judged as rude.`,
    '',
    'AI AUTO-ACT',
    profile.aiAutoAct.length === 0
      ? 'The AI may not act on its own; a moderator decides every report.'
      : `The AI may act on its own for: ${listOf(profile.aiAutoAct)}. Auto-act is never banter or rude; a moderator decides those.`,
    `Standard for the AI read: ${clean(profile.aiContext)}`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------------------------
// Policy JSON (tools)

/**
 * The resolved policy as data: `{ version: 1, profile, rules }`, rules in number order with retired ones marked.
 * It is a deep copy, so editing it changes nothing in the kit. `JSON.stringify` it for a file; the parts feed back
 * into `defineProfile` and `defineRules`. Throws `ProfileError` for an invalid profile.
 */
export function policyJson(policy: DocumentPolicy): PolicyJson {
  checkPolicy(policy);
  return { version: 1, profile: structuredClone(policy.profile), rules: policy.rules.all() };
}

/** The four documents bound to one policy, as `cw.documents` exposes them. */
export function bindDocuments(policy: DocumentPolicy): Documents {
  return {
    codeOfConduct: (options) => codeOfConduct(policy, options),
    moderatorGuide: (options) => moderatorGuide(policy, options),
    agentBrief: () => agentBrief(policy),
    policyJson: () => policyJson(policy),
  };
}

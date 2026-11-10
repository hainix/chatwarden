import { randomBytes } from 'node:crypto';
import { CATEGORY_TO_RULE, CONDUCT_LEVELS, DEFAULT_SEVERE_RULES, safeWarn } from '@chatwarden/core';
import type { Chatwarden, Clock, DiscordThreadRow, KitEvent, KitEventOf, Limits, Logger, ModerationProfile } from '@chatwarden/core';
import { CONTENT_MAX, cutText, isSnowflake, makeForumClient, parseWebhookUrl } from './forum.js';
import type { ForumMessage } from './forum.js';
import { CATEGORY_LABELS, KIND_LABELS, VERDICT_LABELS, humanDuration, labelOf, safeText } from './text.js';

/** The most events held while one is being delivered; on overflow the oldest waiting event is dropped. */
export const QUEUE_MAX = 1000;
/** Drop warnings are coalesced: at most one line in this window. */
const DROP_LOG_WINDOW_MS = 60_000;
/** The people kept in memory (thread rows, and the sanction groups seen) before the oldest are forgotten. */
const CACHE_MAX = 10_000;
const RULE_TITLE_MAX = 120;

/** The shared threads' keys in `kit_discord_threads`. Not subject ids: those start with `s_`. */
const UNATTRIBUTED = { key: '__unattributed__', label: 'Unattributed reports' } as const;
const MODERATION_LOG = { key: '__log__', label: 'Moderation log' } as const;
type Shared = typeof UNATTRIBUTED | typeof MODERATION_LOG;

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** `Case <5 Crockford base32 characters>`, random: it names no one and is derived from nothing. */
const newLabel = (): string => `Case ${Array.from(randomBytes(5), (b) => CROCKFORD[b & 31]).join('')}`;

/** The part of the kit the feed uses. A `Chatwarden` is one. */
export interface FeedKit {
  on: Chatwarden['on'];
  reports: Pick<Chatwarden['reports'], 'get'>;
  profile: Pick<ModerationProfile, 'severeRules'>;
  rules: { all(): ReadonlyArray<{ number: number; title: string }> };
  limits: { strikes: Pick<Limits['strikes'], 'firstMs' | 'repeatMs'> };
  people: Chatwarden['people'];
  discordThreads: Chatwarden['discordThreads'];
}

export interface DiscordFeedOptions {
  /**
   * The forum channel's webhook URL: `https://discord.com/api/webhooks/<id>/<token>` (also `discordapp.com`, and the
   * `ptb.` and `canary.` hosts). It is a credential: checked once here (`RangeError`, never echoing it) and never logged.
   */
  webhookUrl: string;
  /**
   * Where staff land when they click: a URL in your moderator hub for a report or a person. Ids appear in the posts
   * ONLY inside these links. A value that is not an http(s) URL, or a throw, drops that one link and not the post.
   */
  hubLink: (kind: 'report' | 'person', id: string) => string;
  /** A Discord role id (digits) to ping on a severe report or a severe sanction. Nothing else ever pings anyone. */
  mentionRoleId?: string;
  /** Post only severe reports and their outcomes. Default false. */
  severeOnly?: boolean;
  /** The `fetch` to POST with. Default: the global one. */
  fetch?: typeof fetch;
  /** Where failures are logged: an operation, an HTTP status or an error class, and a count; never the URL or any id. Defaults to `console.warn`. */
  logger?: Logger;
  /** The time source for thread timestamps and sanction lengths. Default: `Date.now`. */
  clock?: Clock;
  /** Jitter source in [0, 1) for retry backoff. Default `Math.random`; a test passes a fixed one. */
  random?: () => number;
}

export interface DiscordFeed {
  /** Unsubscribe, drop the queue, abort the request in flight and clear every timer. Safe to call more than once. */
  dispose(): void;
}

const systemClock: Clock = { now: () => Date.now() };

const errName = (err: unknown): string => {
  try {
    return err instanceof Error ? err.name : typeof err;
  } catch {
    return 'unknown';
  }
};

const isString = (v: unknown): v is string => typeof v === 'string' && v !== '';

/** The staff report, as far as the feed reads it. `conductLevel` arrives with the AI read (K3c). */
interface ReportView {
  category?: unknown;
  targetPerson?: unknown;
  conductLevel?: unknown;
}

/** What the feed remembers about a sanction group, to place its lift or gap in the person's thread. */
interface GroupInfo {
  person: string;
  severe: boolean;
}

/** One event, ready to deliver. The text is fixed when the event is raised. */
interface Job {
  /** The event type, for the log. */
  op: string;
  /** The canonical person (when raised) whose thread this goes to, or the shared thread. */
  target: { person: string } | { shared: Shared };
  message: ForumMessage;
}

/**
 * Feed the staff review queue into a Discord forum, through the forum channel's webhook.
 *
 * - One forum thread per reported person, opened by their first post and named `Case XXXXX` (5 random Crockford base32
 *   characters, never derived from an id, hash or handle). The map person to thread lives in `kit_discord_threads` (and in
 *   memory), so it survives a restart. After a merge the canonical person's thread is used; if only an alias has one it
 *   is reused and the map repointed. A report whose target is unknown, and `report.closed` for a report that cannot be
 *   read, go to one shared "Unattributed reports" thread; `auto.restricted` and a lift or gap whose person is not known
 *   (the events name only a sanction group) go to a shared "Moderation log" thread.
 * - `report.created`: category, Community Rule, conduct level (when the staff report carries one), hub links.
 *   `report.closed`: the verdict. `sanction.applied`: kind, length, ref code, rule. `auto.restricted`: "Automatic
 *   timeout" and its length. `sanction.revoked`: "Lifted" and the ref code. `gap.created`: a note, the ref code and a
 *   hub link. Plain staff text: no chat text, handle, reporter note, reason or evidence, and no id except inside
 *   `hubLink` URLs.
 * - Severe means category `hate`, or the rule (the report's default rule, or the sanction's) is in
 *   `cw.profile.severeRules` (default Community Rule 1). Only a severe report or sanction pings `mentionRoleId`;
 *   `allowed_mentions` is `{ parse: [] }` on every other post, so no adopter or rule text can ping `@everyone`.
 *   `severeOnly` posts only severe reports, their closing, a severe sanction and its lift.
 * - Delivery: one queue, one request at a time (a webhook's rate limit is shared), so a thread is created exactly once
 *   and a person's posts stay in order. A 429 waits the `retry_after` it names (0.5 to 60 s); a 5xx or network error backs
 *   off 1, 2, 4, 8, 16 s; at most 5 retries; 10 s per request. The queue is in memory, bounded at 1000 waiting events
 *   (the oldest is dropped, logged as a coalesced count `chatwarden.discord_dropped`).
 * - Every listener is fenced: a throw or a rejection (fetch, store, lookup) never reaches the kit, and only the error
 *   class is logged (`chatwarden.discord_failed`).
 *
 * Everything is checked once, here: a bad webhook URL, role id or option throws `RangeError` and subscribes nothing. Call
 * `dispose()` on shutdown.
 */
export function discordFeed(cw: FeedKit, options: DiscordFeedOptions): DiscordFeed {
  if (typeof options !== 'object' || options === null) throw new RangeError('discordFeed: options are required');
  // Every field is read exactly once, here.
  const { webhookUrl, hubLink, mentionRoleId, severeOnly, logger } = options;
  const base = parseWebhookUrl(webhookUrl);
  if (typeof hubLink !== 'function') throw new RangeError('discordFeed: hubLink must be a function');
  if (mentionRoleId !== undefined && !isSnowflake(mentionRoleId)) throw new RangeError('discordFeed: mentionRoleId must be a Discord role id (digits)');
  if (severeOnly !== undefined && typeof severeOnly !== 'boolean') throw new RangeError('discordFeed: severeOnly must be a boolean');
  const onlySevere = severeOnly === true;
  const clock = options.clock ?? systemClock;
  const forum = makeForumClient({
    webhookUrl: base,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(logger === undefined ? {} : { logger }),
    ...(options.random === undefined ? {} : { random: options.random }),
  });

  let disposed = false;
  const unsubscribes: Array<() => void> = [];
  const queue: Job[] = [];
  let busy = false;
  /** Thread rows by key (a canonical subject or a shared key): a failing store write must not open a second thread. */
  const rows = new Map<string, DiscordThreadRow>();
  const groups = new Map<string, GroupInfo>();

  const fail = (op: string, err: unknown): void => {
    safeWarn(logger, 'chatwarden.discord_failed', { op, error: errName(err) });
  };

  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    if (!map.has(key) && map.size >= CACHE_MAX) {
      const oldest = map.keys().next();
      if (oldest.done !== true) map.delete(oldest.value);
    }
    map.set(key, value);
  };

  // ---- drops, logged as a coalesced count ----

  let dropped = 0;
  let lastDropLog: number | null = null;
  let dropTimer: ReturnType<typeof setTimeout> | undefined;
  const flushDrops = (): void => {
    if (dropTimer !== undefined) clearTimeout(dropTimer);
    dropTimer = undefined;
    if (dropped === 0) return;
    safeWarn(logger, 'chatwarden.discord_dropped', { count: dropped });
    dropped = 0;
    lastDropLog = clock.now();
  };
  const noteDrop = (): void => {
    dropped++;
    const since = lastDropLog === null ? Infinity : clock.now() - lastDropLog;
    if (since >= DROP_LOG_WINDOW_MS) flushDrops();
    else if (dropTimer === undefined) {
      dropTimer = setTimeout(flushDrops, DROP_LOG_WINDOW_MS - since);
      dropTimer.unref?.();
    }
  };

  // ---- the thread map ----

  const rowOf = (key: string): DiscordThreadRow | null => {
    const cached = rows.get(key);
    if (cached !== undefined) return cached;
    const stored = cw.discordThreads.get(key);
    if (stored === null || stored === undefined) return null;
    remember(rows, key, stored);
    return stored;
  };

  /** Remember a row in memory first, then in the store: a store that fails costs persistence, never a duplicate thread. */
  const keep = (row: DiscordThreadRow): void => {
    remember(rows, row.subject, row);
    try {
      cw.discordThreads.put(row);
    } catch (err) {
      fail('threadMap', err);
    }
  };

  /** The person's thread: theirs, else an alias's (the map is repointed at the person), else none. */
  const findPerson = (person: string): DiscordThreadRow | null => {
    const own = rowOf(person);
    if (own !== null) return own;
    for (const alias of cw.people.aliases(person)) {
      if (alias === person) continue;
      const theirs = rowOf(alias);
      if (theirs === null) continue;
      const repointed = { ...theirs, subject: person };
      keep(repointed);
      return repointed;
    }
    return null;
  };

  const deliver = async (job: Job): Promise<void> => {
    const shared = 'shared' in job.target ? job.target.shared : null;
    const key = shared !== null ? shared.key : cw.people.canonical((job.target as { person: string }).person);
    const row = shared !== null ? rowOf(key) : findPerson(key);
    if (row === null) {
      const label = shared !== null ? shared.label : newLabel();
      const opened = await forum.openThread(label, job.message);
      if (opened !== null && !disposed) keep({ subject: key, threadId: opened.threadId, label, createdAt: clock.now() });
      return;
    }
    const posted = await forum.post(row.threadId, job.message);
    if (posted !== null && 'gone' in posted && !disposed) {
      // The thread was deleted in Discord: the same post opens a new one, once, under the same label. A failure there is given up on.
      const opened = await forum.openThread(row.label, job.message);
      if (opened !== null && !disposed) keep({ subject: key, threadId: opened.threadId, label: row.label, createdAt: clock.now() });
    }
  };

  const drain = async (): Promise<void> => {
    if (busy || disposed) return;
    busy = true;
    try {
      for (let next = queue.shift(); next !== undefined && !disposed; next = queue.shift()) {
        try {
          await deliver(next);
        } catch (err) {
          fail(next.op, err);
        }
      }
    } finally {
      busy = false;
    }
  };

  const enqueue = (job: Job): void => {
    if (disposed) return;
    if (queue.length >= QUEUE_MAX) {
      queue.shift();
      noteDrop();
    }
    queue.push(job);
    void drain();
  };

  // ---- reading the kit ----

  const severeRules = (): readonly number[] => cw.profile.severeRules ?? DEFAULT_SEVERE_RULES;
  const isSevereRule = (rule: unknown): boolean => typeof rule === 'number' && severeRules().includes(rule);

  /** The default rule of a report category: a number, 'uncovered', or undefined for a category we do not know. */
  const ruleOfCategory = (category: unknown): number | 'uncovered' | undefined =>
    typeof category === 'string' && Object.hasOwn(CATEGORY_TO_RULE, category)
      ? (CATEGORY_TO_RULE as Record<string, number | 'uncovered'>)[category]
      : undefined;

  const isSevereCategory = (category: unknown): boolean => category === 'hate' || isSevereRule(ruleOfCategory(category));

  /** `Community Rule 2 (Title)`, the title escaped; `No Community Rule yet` for 'uncovered'; undefined when there is no rule. */
  const ruleText = (rule: unknown): string | undefined => {
    if (rule === 'uncovered') return 'No Community Rule yet';
    if (typeof rule !== 'number') return undefined;
    const title = cw.rules.all().find((r) => r.number === rule)?.title;
    return title === undefined ? `Community Rule ${rule}` : `Community Rule ${rule} (${safeText(title, RULE_TITLE_MAX)})`;
  };

  const categoryText = (category: unknown): string | undefined =>
    labelOf(CATEGORY_LABELS, category) ?? (isString(category) ? safeText(category, 30) : undefined);

  const readReport = (op: string, reportId: unknown): ReportView | null => {
    if (!isString(reportId)) return null;
    try {
      return (cw.reports.get(reportId) as ReportView | null) ?? null;
    } catch (err) {
      fail(op, err);
      return null;
    }
  };

  /** The canonical person of a staff ref, or null for none. */
  const personOf = (subject: unknown): string | null => (isString(subject) ? cw.people.canonical(subject) : null);

  /** `[label](<url>)`, or null when `hubLink` gave nothing usable. The URL is re-serialised, so it cannot break out of its brackets. */
  const link = (kind: 'report' | 'person', id: string, label: string): string | null => {
    try {
      const url = new URL(hubLink(kind, id));
      return url.protocol === 'https:' || url.protocol === 'http:' ? `[${label}](<${url.href}>)` : null;
    } catch {
      return null;
    }
  };

  /** Facts, then links, within Discord's limit: when it is too long the facts are shortened, never the links. */
  const compose = (head: string, facts: ReadonlyArray<string | undefined>, links: ReadonlyArray<string | null>, pingRole: boolean): ForumMessage => {
    const linkLine = links.filter((l): l is string => l !== null).join(' · ');
    const lines = [pingRole && mentionRoleId !== undefined ? `<@&${mentionRoleId}> ${head}` : head, ...facts.filter((f): f is string => f !== undefined)];
    const text = lines.join('\n');
    const room = CONTENT_MAX - linkLine.length - 1;
    const body = linkLine === '' ? cutText(text, CONTENT_MAX) : text.length <= room ? `${text}\n${linkLine}` : `${cutText(text, Math.max(room - 1, 0))}…\n${linkLine}`;
    return { content: body, ...(pingRole && mentionRoleId !== undefined ? { mentionRoleId } : {}) };
  };

  const toPerson = (op: string, person: string | null, fallback: Shared, message: ForumMessage): void => {
    enqueue({ op, target: person === null ? { shared: fallback } : { person }, message });
  };

  // ---- the events ----

  const onCreated = (e: KitEventOf<'report.created'>): void => {
    const severe = isSevereCategory(e.category);
    if (onlySevere && !severe) return;
    const report = readReport(e.type, e.reportId);
    const person = report === null ? null : personOf(report.targetPerson);
    const rule = ruleOfCategory(e.category);
    const level = CONDUCT_LEVELS.find((l) => l === report?.conductLevel);
    const category = categoryText(e.category);
    const message = compose(
      severe ? '**Severe report**' : '**New report**',
      [
        category === undefined ? undefined : `Category: ${category}`,
        rule === undefined || rule === 'uncovered' ? undefined : `Rule: ${ruleText(rule)}`,
        level === undefined ? undefined : `Conduct level: ${level}`,
      ],
      [link('report', e.reportId, 'Open report'), person === null ? null : link('person', person, 'Open person')],
      severe,
    );
    toPerson(e.type, person, UNATTRIBUTED, message);
  };

  const onClosed = (e: KitEventOf<'report.closed'>): void => {
    const report = readReport(e.type, e.reportId);
    const severe = report !== null && isSevereCategory(report.category);
    if (onlySevere && !severe) return;
    const person = report === null ? null : personOf(report.targetPerson);
    const category = report === null ? undefined : categoryText(report.category);
    const message = compose(
      `**Report closed** · ${labelOf(VERDICT_LABELS, e.verdict) ?? 'Closed'}`,
      [category === undefined ? undefined : `Category: ${category}`],
      [link('report', e.reportId, 'Open report'), person === null ? null : link('person', person, 'Open person')],
      false,
    );
    toPerson(e.type, person, UNATTRIBUTED, message);
  };

  const onApplied = (e: KitEventOf<'sanction.applied'>): void => {
    const severe = isSevereRule(e.rule);
    const person = personOf(e.target);
    if (person !== null && isString(e.groupId)) remember(groups, e.groupId, { person, severe });
    if (onlySevere && !severe) return;
    const unlimited = e.kind === 'warning' || e.kind === 'note';
    const length = unlimited ? undefined : e.until === null ? 'permanent' : humanDuration(e.until - clock.now());
    const kind = labelOf(KIND_LABELS, e.kind) ?? 'Sanction';
    const rule = ruleText(e.rule);
    const message = compose(
      `**Sanction applied** · ${kind}${length === undefined ? '' : ` · ${length}`}`,
      [
        isString(e.refCode) ? `Ref: ${safeText(e.refCode, 40)}` : undefined,
        rule === undefined ? undefined : `Rule: ${rule}`,
        e.automated === true ? 'Applied automatically.' : undefined,
      ],
      [person === null ? null : link('person', person, 'Open person')],
      severe,
    );
    toPerson(e.type, person, MODERATION_LOG, message);
  };

  const onRevoked = (e: KitEventOf<'sanction.revoked'>): void => {
    const known = isString(e.groupId) ? groups.get(e.groupId) : undefined;
    if (onlySevere && known?.severe !== true) return;
    const message = compose(
      '**Lifted**',
      [isString(e.refCode) ? `Ref: ${safeText(e.refCode, 40)}` : undefined],
      [known === undefined ? null : link('person', known.person, 'Open person')],
      false,
    );
    toPerson(e.type, known?.person ?? null, MODERATION_LOG, message);
  };

  const onGap = (e: KitEventOf<'gap.created'>): void => {
    if (onlySevere) return;
    const known = isString(e.groupId) ? groups.get(e.groupId) : undefined;
    const message = compose(
      '**Rule gap filed** for review',
      [isString(e.refCode) ? `Ref: ${safeText(e.refCode, 40)}` : undefined],
      [known === undefined ? null : link('person', known.person, 'Open person')],
      false,
    );
    toPerson(e.type, known?.person ?? null, MODERATION_LOG, message);
  };

  const onAuto = (e: KitEventOf<'auto.restricted'>): void => {
    if (onlySevere) return;
    const second = e.second === true;
    const message = compose(
      `**Automatic timeout**${second ? ' (repeat)' : ''} · ${humanDuration(second ? cw.limits.strikes.repeatMs : cw.limits.strikes.firstMs)}`,
      [isString(e.refCode) ? `Ref: ${safeText(e.refCode, 40)}` : undefined],
      [],
      false,
    );
    toPerson(e.type, null, MODERATION_LOG, message);
  };

  /** Fence a handler: a sync throw is logged by class and goes no further. It returns at once; delivery is queued. */
  const fenced =
    <E extends KitEvent>(handler: (e: E) => void) =>
    (e: E): void => {
      if (disposed) return;
      try {
        handler(e);
      } catch (err) {
        fail(typeof e === 'object' && e !== null && typeof e.type === 'string' ? e.type : 'event', err);
      }
    };

  unsubscribes.push(
    cw.on('report.created', fenced(onCreated)),
    cw.on('report.closed', fenced(onClosed)),
    cw.on('sanction.applied', fenced(onApplied)),
    cw.on('sanction.revoked', fenced(onRevoked)),
    cw.on('gap.created', fenced(onGap)),
    cw.on('auto.restricted', fenced(onAuto)),
  );

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      queue.length = 0;
      forum.dispose();
      flushDrops();
    },
  };
}

// TEMPORARY. FakeEngine is an in-memory stand-in for the real kit behind the DemoEngine interface. Task 3 replaces it with
// `@chatwarden/core` running in the browser. It mimics the kit's behaviour (refusal under Community Rule 1, evidence in
// reports, the ladder suggestion, notices with the quoted line masked, acks), but it is NOT the real matcher or ladder:
// the term matching below is a small look-alike of the matcher's mechanisms and nothing more.
//
// Every word that is refused here is invented (the matcher's fixtures pack). No real slur is written anywhere.

import { LINE_MAX } from './engine';
import type {
  ChatResult,
  DecisionAction,
  DecisionGroup,
  DecisionInput,
  DecisionResult,
  DemoEngine,
  DemoSeat,
  EvidenceLine,
  PlayerNotice,
  ReportCategory,
  ReportInput,
  ReportPage,
  ReportResult,
  RuleRef,
  SeatState,
  StaffReport,
  Suggestion,
} from './engine';
import { REPORT_CATEGORIES } from './engine';

/** The invented words of @chatwarden/matcher's fixtures pack (copied; test/fakeEngine.test.ts compares the two). */
export const INVENTED_TERMS = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp'] as const;

/** Phrases that contain a term but are fine (the pack's exceptions). */
const EXCEPTION_PHRASES = ['tarvo lake', 'glarn zorbak'];

const SEATS: readonly DemoSeat[] = [
  { id: 'you', name: 'You', you: true },
  { id: 'ada', name: 'Ada', you: false },
  { id: 'bo', name: 'Bo', you: false },
];

// The standard preset's starter Community Rules (titles only: that is all a notice shows).
const RULE_TITLES: Record<number, string> = {
  1: 'No slurs or hate aimed at who someone is',
  2: 'No insulting, threatening or targeting another player',
  3: 'No sexual messages',
  4: 'No spam, flooding or advertising',
  5: 'No cheating or exploiting',
  6: 'No throwing, stalling or ruining games on purpose',
  7: 'No offensive names',
  8: 'No false reports',
};
const CATEGORY_TO_RULE: Record<ReportCategory, RuleRef> = {
  hate: 1,
  harassment: 2,
  spam: 4,
  cheating: 5,
  disruption: 6,
  other: 'uncovered',
};

const EXCERPT_LINES = 6;
const BUFFER_MAX = 100;
const RATE_WINDOW_MS = 5000;
const RATE_MAX = 6;
const REPORTS_PER_DAY = 5;
const REASON_MAX = 500;
const DAY_MS = 86_400_000;
const NOTICE_WINDOW_MS = 90 * DAY_MS;
const TIMEOUT_MAX_MS = 365 * DAY_MS;
const NOTICE_LINES_MAX = 5;

/** Words that make a reported line "rude" rather than plain trash talk. The real kit reads this from a person or an AI. */
const RUDE = /\b(uninstall|hopeless|worthless|pathetic|garbage|loser|shut up)\b/i;

export interface Clock {
  now(): number;
}

// ---------- the term matcher look-alike ----------

const SEPARATORS = /[\s/|\\,;:.()"<>?[\]{}\-_+=*#&%~^']+/u;
const EDGE = /^[!$@\u200b-\u200d\u2060\ufeff\u00ad]+|[!$@\u200b-\u200d\u2060\ufeff\u00ad]+$/gu;
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', $: 's', '!': 'i', '@': 'a' };

interface Tok {
  start: number;
  end: number;
  /** Folded for comparison: width, accents, case, look-alike characters. Repeated letters are kept. */
  norm: string;
}

function fold(core: string): string {
  const base = core
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[̀-ͯ\u200b-\u200d\u2060\ufeff\u00ad]/g, '')
    .toLowerCase();
  return [...base].map((c) => LEET[c] ?? c).join('');
}

const collapse = (s: string) => s.replace(/(.)\1+/gu, '$1');

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  let from = 0;
  for (const part of text.split(SEPARATORS)) {
    if (part === '') continue;
    const at = text.indexOf(part, from);
    from = at + part.length;
    const lead = /^[!$@\u200b-\u200d\u2060\ufeff\u00ad]*/u.exec(part)?.[0].length ?? 0;
    const core = part.replace(EDGE, '');
    if (core === '') continue;
    out.push({ start: at + lead, end: at + lead + core.length, norm: fold(core) });
  }
  return out;
}

const TERM_KEYS = INVENTED_TERMS.map((t) => collapse(t));

/** The spans of `text` that are an invented term, whole words only, minus the exception phrases. */
export function blockedSpans(text: string): Array<{ start: number; end: number }> {
  const toks = tokens(text);
  const excepted = new Set<number>();
  for (const phrase of EXCEPTION_PHRASES) {
    const words = phrase.split(' ');
    for (let i = 0; i + words.length <= toks.length; i++) {
      let ok = true;
      for (let j = 0; j < words.length && ok; j++) {
        const t = toks[i + j] as Tok;
        if (t.norm !== words[j]) ok = false;
        const next = toks[i + j + 1];
        if (ok && j < words.length - 1 && next !== undefined && !/^\s+$/.test(text.slice(t.end, next.start))) ok = false;
      }
      if (ok) for (let j = 0; j < words.length; j++) excepted.add(i + j);
    }
  }
  const spans: Array<{ start: number; end: number }> = [];
  toks.forEach((t, i) => {
    if (!excepted.has(i) && TERM_KEYS.includes(collapse(t.norm))) spans.push({ start: t.start, end: t.end });
  });
  return spans;
}

/** Replaces each span with stars of the same length. */
export function maskSpans(text: string, spans: ReadonlyArray<{ start: number; end: number }>): string {
  let out = '';
  let at = 0;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.start < at) continue;
    out += text.slice(at, s.start) + '*'.repeat(s.end - s.start);
    at = s.end;
  }
  return out + text.slice(at);
}

// ---------- the engine ----------

interface Sanction {
  groupId: string;
  seat: string;
  kind: 'warning' | 'chat' | 'note';
  rule: RuleRef;
  until: number | null;
  createdAt: number;
}
interface ReportRec {
  id: string;
  seq: number;
  createdAt: number;
  category: ReportCategory;
  note: string | null;
  reporterSeat: string;
  targetSeat: string;
  lineId: string | null;
  excerpt: EvidenceLine[];
  status: 'open' | 'actioned' | 'dismissed';
  decisionKey: string | null;
  groups: DecisionGroup[];
}
interface NoticeRec {
  seat: string;
  notice: PlayerNotice;
  ackedAt: number | null;
}

const subjectOf = (seat: string) => `s_${seat}`;
const seatOf = (subject: string) => (subject.startsWith('s_') ? subject.slice(2) : subject);
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export class FakeEngine implements DemoEngine {
  readonly note = 'This demo runs a small in-browser stand-in for the kit, not the kit itself yet.';
  readonly seats = SEATS;
  private readonly clock: Clock;
  private n = 0;
  private lines: EvidenceLine[] = [];
  private sent = new Map<string, number[]>();
  private reportRecs: ReportRec[] = [];
  private reportsBy = new Map<string, number>();
  private sanctions: Sanction[] = [];
  private noticeRecs: NoticeRec[] = [];

  constructor(opts: { clock?: Clock } = {}) {
    this.clock = opts.clock ?? { now: () => Date.now() };
  }

  private id(prefix: string): string {
    this.n += 1;
    return `${prefix}${this.n}`;
  }
  private seat(id: string): DemoSeat | undefined {
    return SEATS.find((s) => s.id === id);
  }

  async reset(): Promise<void> {
    this.n = 0;
    this.lines = [];
    this.sent = new Map();
    this.reportRecs = [];
    this.reportsBy = new Map();
    this.sanctions = [];
    this.noticeRecs = [];
  }

  rules = {
    label: (ref: RuleRef): string => {
      if (ref === 'uncovered') return 'Not covered by a rule yet';
      const title = RULE_TITLES[ref];
      return title === undefined ? `Community Rule ${ref}` : `Community Rule ${ref}: ${title}`;
    },
  };

  rooms = {
    seats: async (): Promise<SeatState[]> => {
      const now = this.clock.now();
      return SEATS.map((s) => ({ ...s, restrictedUntil: this.restrictionOf(s.id, now)?.until ?? null }));
    },
  };

  private restrictionOf(seat: string, now: number): Sanction | null {
    let best: Sanction | null = null;
    for (const s of this.sanctions) {
      if (s.seat === seat && s.kind === 'chat' && s.until !== null && s.until > now && (best === null || s.until > (best.until ?? 0))) best = s;
    }
    return best;
  }

  chat = {
    accept: async (seatId: string, text: string): Promise<ChatResult> => {
      const seat = this.seat(seatId);
      const trimmed = typeof text === 'string' ? text.trim() : '';
      if (seat === undefined || trimmed === '') return { refuse: { reason: 'empty' } };
      const now = this.clock.now();
      const restriction = this.restrictionOf(seatId, now);
      if (restriction !== null) {
        return {
          refuse: {
            reason: 'restricted',
            until: restriction.until,
            byModerator: true,
            ...(typeof restriction.rule === 'number' ? { rule: restriction.rule } : {}),
          },
        };
      }
      if ([...trimmed].length > LINE_MAX) return { refuse: { reason: 'length' } };
      const recent = (this.sent.get(seatId) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
      if (recent.length >= RATE_MAX) {
        this.sent.set(seatId, recent);
        return { refuse: { reason: 'rate' } };
      }
      this.sent.set(seatId, [...recent, now]);
      const blocked = blockedSpans(trimmed).length > 0;
      const line: EvidenceLine = {
        lineId: this.id('l'),
        ts: now,
        seatId,
        handle: seat.name,
        raw: trimmed,
        delivered: blocked ? null : trimmed,
        blocked,
      };
      this.lines.push(line);
      if (this.lines.length > BUFFER_MAX) this.lines.shift();
      return blocked ? { refuse: { reason: 'blocked', rule: 1 } } : { deliver: { lineId: line.lineId, text: trimmed } };
    },
  };

  reports = {
    submit: async (input: ReportInput): Promise<ReportResult> => {
      const reporter = this.seat(input.reporterSeat);
      if (reporter === undefined) return { ok: false, refused: 'not_player' };
      if (!REPORT_CATEGORIES.includes(input.category)) return { ok: false, refused: 'off' };
      const idx = input.lineId === undefined ? -1 : this.lines.findIndex((l) => l.lineId === input.lineId);
      const line = idx >= 0 ? this.lines[idx] : undefined;
      // A refused line was seen by its sender only, so nobody else can point at it.
      if (line?.blocked === true && line.seatId !== input.reporterSeat) return { ok: false, refused: 'not_player' };
      const targetSeat = line?.seatId ?? input.targetSeat;
      if (this.seat(targetSeat) === undefined) return { ok: false, refused: 'not_player' };
      if (targetSeat === input.reporterSeat) return { ok: false, refused: 'self' };
      const dup = this.reportRecs.some(
        (r) =>
          r.reporterSeat === input.reporterSeat &&
          r.targetSeat === targetSeat &&
          (line !== undefined ? r.lineId === line.lineId : r.lineId === null && r.status === 'open'),
      );
      if (dup) return { ok: false, refused: 'duplicate' };
      const used = this.reportsBy.get(input.reporterSeat) ?? 0;
      if (used >= REPORTS_PER_DAY) return { ok: false, refused: 'rate', remaining: 0 };
      this.reportsBy.set(input.reporterSeat, used + 1);
      const end = idx >= 0 ? Math.min(this.lines.length, idx + 3) : this.lines.length;
      const excerpt = this.lines.slice(Math.max(0, end - EXCERPT_LINES), end).map((l) => ({ ...l }));
      const note = input.note?.trim() ?? '';
      const rec: ReportRec = {
        id: this.id('r'),
        seq: this.n,
        createdAt: this.clock.now(),
        category: input.category,
        note: note === '' ? null : note,
        reporterSeat: input.reporterSeat,
        targetSeat,
        lineId: line?.lineId ?? null,
        excerpt,
        status: 'open',
        decisionKey: null,
        groups: [],
      };
      this.reportRecs.push(rec);
      return { ok: true, reportId: rec.id, remaining: REPORTS_PER_DAY - used - 1 };
    },

    list: async (query: { status?: StaffReport['status'] } = {}): Promise<ReportPage> => {
      const items = this.reportRecs
        .filter((r) => query.status === undefined || r.status === query.status)
        .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
        .map((r) => this.view(r));
      return { items, next: null };
    },

    get: async (id: string): Promise<StaffReport | null> => {
      const rec = this.reportRecs.find((r) => r.id === id);
      return rec === undefined ? null : this.view(rec);
    },
  };

  private view(r: ReportRec): StaffReport {
    const ownLineIds: Record<string, string[]> = {};
    for (const l of r.excerpt) (ownLineIds[subjectOf(l.seatId)] ??= []).push(l.lineId);
    return {
      id: r.id,
      createdAt: r.createdAt,
      category: r.category,
      note: r.note,
      reporterHandle: this.seat(r.reporterSeat)?.name ?? '',
      targetHandle: this.seat(r.targetSeat)?.name ?? '',
      lineId: r.lineId,
      excerpt: r.excerpt.map((l) => ({ ...l })),
      status: r.status,
      targetPerson: subjectOf(r.targetSeat),
      ownLineIds,
    };
  }

  suggest = async (reportId: string): Promise<Suggestion | null> => {
    const rec = this.reportRecs.find((r) => r.id === reportId);
    if (rec === undefined) return null;
    const rule = CATEGORY_TO_RULE[rec.category];
    const ruleName = rule === 'uncovered' ? 'no rule yet' : `Community Rule ${rule}`;
    const reported = rec.excerpt.find((l) => l.lineId === rec.lineId);
    const theirs = rec.excerpt.filter((l) => l.seatId === rec.targetSeat);
    const rude = (reported !== undefined ? [reported] : theirs).some((l) => RUDE.test(l.raw));
    const now = this.clock.now();
    const step = this.sanctions.filter(
      (s) => s.seat === rec.targetSeat && (s.kind === 'warning' || s.kind === 'chat') && now - s.createdAt < NOTICE_WINDOW_MS,
    ).length;
    const timeout: Suggestion['outcome'] = { kind: 'chat', durationMs: 600_000 };
    if (rec.category === 'hate') {
      return { outcome: timeout, label: 'Timeout 10m', why: `hate is acted on at once under ${ruleName}`, rule };
    }
    if (!rude) {
      return {
        outcome: 'none',
        label: 'No action',
        why: rule === 2 ? 'trash talk is fine under Community Rule 2' : `the lines do not clearly break ${ruleName}`,
        rule,
      };
    }
    if (step >= 1) {
      return {
        outcome: timeout,
        label: 'Timeout 10m',
        why: `repeat offence, a warning or timeout is already on the record, under ${ruleName}`,
        rule,
      };
    }
    return { outcome: 'warning', label: 'Warning', why: `first offence under ${ruleName}`, rule };
  };

  decide = async (input: DecisionInput): Promise<DecisionResult> => {
    const rec = this.reportRecs.find((r) => r.id === input?.reportId);
    if (rec === undefined) return { ok: false, error: 'not_found' };
    const checked = this.check(rec, input);
    if (checked === null) return { ok: false, error: 'invalid' };
    const key = JSON.stringify({ v: input.verdict, a: input.actions.map((a) => [a.subject, a.kind, a.durationMs, a.rule, a.lineIds ?? []]) });
    if (rec.status !== 'open') {
      return rec.decisionKey === key ? { ok: true, groups: rec.groups.map((g) => ({ ...g })), replay: true } : { ok: false, error: 'already_decided' };
    }
    const now = this.clock.now();
    const groups: DecisionGroup[] = [];
    for (const action of input.actions) {
      const seat = seatOf(action.subject);
      const groupId = this.id('g');
      const refCode = `CW-${(46_656 + this.n * 7919).toString(36).toUpperCase()}`;
      this.sanctions.push({
        groupId,
        seat,
        kind: action.kind,
        rule: action.rule,
        until: action.kind === 'chat' ? now + (action.durationMs ?? 0) : null,
        createdAt: now,
      });
      let noticeId: string | null = null;
      if (action.kind !== 'note') {
        noticeId = this.id('n');
        const lines = rec.excerpt.filter((l) => (action.lineIds ?? []).includes(l.lineId));
        this.noticeRecs.push({
          seat,
          ackedAt: null,
          notice: {
            id: noticeId,
            kind: action.kind,
            rule: action.rule,
            ruleLabel: this.rules.label(action.rule),
            until: action.kind === 'chat' ? now + (action.durationMs ?? 0) : null,
            refCode,
            excerpt: lines.map((l) => ({ text: maskSpans(l.raw, blockedSpans(l.raw)), day: day(l.ts) })),
            createdAt: now,
            mustAcknowledge: action.kind === 'warning',
          },
        });
      }
      groups.push({ subject: action.subject, groupId, refCode, kind: action.kind, noticeId });
    }
    rec.status = input.verdict === 'upheld' || input.verdict === 'noted' ? 'actioned' : 'dismissed';
    rec.decisionKey = key;
    rec.groups = groups;
    return { ok: true, groups: groups.map((g) => ({ ...g })), replay: false };
  };

  /** Validates a decision the way the kit does. Null when it cannot be applied. */
  private check(rec: ReportRec, input: DecisionInput): true | null {
    if (!['upheld', 'noted', 'no_action', 'bad_faith'].includes(input.verdict)) return null;
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason === '' || reason.length > REASON_MAX) return null;
    if (!Array.isArray(input.actions)) return null;
    const evidence = input.evidence?.trim() ?? '';
    if (input.verdict === 'bad_faith' ? evidence === '' || evidence.length > REASON_MAX : input.evidence !== undefined) return null;
    const target = subjectOf(rec.targetSeat);
    if (input.verdict === 'upheld' && (input.actions.length === 0 || input.actions.some((a) => a.kind === 'note'))) return null;
    if (input.verdict === 'noted' && (input.actions.length === 0 || input.actions.some((a) => a.kind !== 'note'))) return null;
    if ((input.verdict === 'no_action' || input.verdict === 'bad_faith') && input.actions.some((a) => a.subject === target)) return null;
    for (const a of input.actions) if (!this.checkAction(rec, a)) return null;
    return true;
  }

  private checkAction(rec: ReportRec, a: DecisionAction): boolean {
    if (!SEATS.some((s) => subjectOf(s.id) === a.subject)) return false;
    if (a.kind === 'chat') {
      if (typeof a.durationMs !== 'number' || !Number.isInteger(a.durationMs) || a.durationMs <= 0 || a.durationMs > TIMEOUT_MAX_MS) return false;
    } else if (a.kind === 'warning' || a.kind === 'note') {
      if (a.durationMs !== null) return false;
    } else return false;
    if (a.rule === 'uncovered') {
      if (typeof a.gapNote !== 'string' || a.gapNote.trim() === '') return false;
    } else if (RULE_TITLES[a.rule] === undefined) return false;
    const ids = a.lineIds ?? [];
    if (!Array.isArray(ids) || new Set(ids).size > NOTICE_LINES_MAX) return false;
    for (const id of ids) {
      const line = rec.excerpt.find((l) => l.lineId === id);
      if (line === undefined || subjectOf(line.seatId) !== a.subject) return false;
    }
    return true;
  }

  notices = {
    pending: async (seat: string): Promise<PlayerNotice[]> =>
      this.noticeRecs.filter((n) => n.seat === seat && n.ackedAt === null).map((n) => ({ ...n.notice, excerpt: n.notice.excerpt.map((e) => ({ ...e })) })),
    ack: async (seat: string, id: string): Promise<boolean> => {
      const row = this.noticeRecs.find((n) => n.seat === seat && n.notice.id === id);
      if (row === undefined) return false;
      row.ackedAt ??= this.clock.now();
      return true;
    },
    record: async (seat: string): Promise<PlayerNotice[]> => {
      const now = this.clock.now();
      return this.noticeRecs
        .filter((n) => n.seat === seat && n.notice.kind !== 'report_outcome' && now - n.notice.createdAt < NOTICE_WINDOW_MS)
        .map((n) => ({ ...n.notice, excerpt: n.notice.excerpt.map((e) => ({ ...e })) }));
    },
  };
}

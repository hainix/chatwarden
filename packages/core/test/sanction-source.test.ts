import { MemoryStore } from '@chatwarden/store-memory';
import { describe, expect, it } from 'vitest';
import * as index from '../src/index.js';
import { AI_SOURCE_TOKEN, applySanction, SanctionError, validateSanctionInput, writeSanction } from '../src/sanctions.js';
import type { SanctionInput } from '../src/sanctions.js';
import { SubjectIndex } from '../src/subjects.js';

// The exported sanction writers refuse the internal source `ai` unless the kit's own AI actor holds the token (design 6.1, review R1a I1). The
// refusal lives in the one place every writer shares (validation), reads `source` ONCE, and is the same for `applySanction`, `writeSanction` and
// `validateSanctionInput`. The token is not exported from the package index.

const NOW = 1_800_000_000_000;

function setup() {
  const store = new MemoryStore();
  const clock = { t: NOW, now: () => clock.t };
  const subjects = new SubjectIndex(store, clock, { logger: { warn() {} } });
  const subject = subjects.resolve({ clientKey: 'key-1', accountId: null, ipHash: null }) as string;
  return { store, subjects, subject };
}

const base = (subject: string, over: Partial<SanctionInput> = {}): SanctionInput => ({
  kind: 'warning',
  subject,
  includeIp: false,
  durationMs: null,
  reason: 'a reason about tarvo',
  actor: 'mod_ann',
  source: 'moderator',
  automated: false,
  rule: 2,
  ...over,
});

const rowsOf = (s: ReturnType<typeof setup>) => s.store.listSubjectSanctions({ limit: 50 });

describe('the exported writers refuse the internal source', () => {
  it('applySanction with source ai rejects and writes nothing', async () => {
    const s = setup();
    await expect(applySanction(s.store, s.subjects, base(s.subject, { source: 'ai', automated: true }), NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rowsOf(s)).toEqual([]);
  });

  it('applySanction through the package index is the same function and refuses too', async () => {
    const s = setup();
    expect(index.applySanction).toBe(applySanction);
    await expect(index.applySanction(s.store, s.subjects, base(s.subject, { source: 'ai' }), NOW)).rejects.toThrow(/invalid source/);
    expect(rowsOf(s)).toEqual([]);
  });

  it('writeSanction and validateSanctionInput refuse it', () => {
    const s = setup();
    expect(() => writeSanction(s.store, s.subjects, base(s.subject, { source: 'ai' }), NOW, false)).toThrow(SanctionError);
    expect(() => validateSanctionInput(base(s.subject, { source: 'ai' }))).toThrow(/invalid source/);
    expect(rowsOf(s)).toEqual([]);
  });

  it('refuses for every kind, with automated either way, and with or without a rule', async () => {
    const s = setup();
    for (const kind of ['warning', 'note', 'chat', 'ban', 'area'] as const) {
      for (const automated of [true, false]) {
        const input = base(s.subject, { kind, source: 'ai', automated, durationMs: kind === 'warning' || kind === 'note' ? null : 3_600_000 });
        await expect(applySanction(s.store, s.subjects, input, NOW), `${kind} ${automated}`).rejects.toBeInstanceOf(SanctionError);
      }
    }
    await expect(applySanction(s.store, s.subjects, { ...base(s.subject, { source: 'ai' }), rule: undefined }, NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rowsOf(s)).toEqual([]);
  });

  it('an inherited source ai is read as an ordinary property and refused', async () => {
    const s = setup();
    const { source: _drop, ...rest } = base(s.subject);
    void _drop;
    const input = Object.create({ source: 'ai' }, Object.getOwnPropertyDescriptors(rest)) as SanctionInput;
    await expect(applySanction(s.store, s.subjects, input, NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rowsOf(s)).toEqual([]);
  });

  it('a getter that says moderator and then ai writes no ai row (source is read once)', async () => {
    const s = setup();
    let reads = 0;
    const input = base(s.subject);
    Object.defineProperty(input, 'source', { get: () => (reads++ === 0 ? 'moderator' : 'ai'), enumerable: true });
    await applySanction(s.store, s.subjects, input, NOW);
    expect(reads).toBe(1);
    expect(rowsOf(s).map((r) => r.source)).toEqual(['moderator']);
  });

  it('a getter that says ai and then moderator is refused on the first read', async () => {
    const s = setup();
    let reads = 0;
    const input = base(s.subject);
    Object.defineProperty(input, 'source', { get: () => (reads++ === 0 ? 'ai' : 'moderator'), enumerable: true });
    await expect(applySanction(s.store, s.subjects, input, NOW)).rejects.toBeInstanceOf(SanctionError);
    expect(rowsOf(s)).toEqual([]);
  });

  it('the other sources still work (control)', async () => {
    const s = setup();
    for (const source of ['moderator', 'auto_filter', 'coop', 'api'] as const) {
      await applySanction(s.store, s.subjects, base(s.subject, { source, automated: source === 'auto_filter' }), NOW);
    }
    expect(rowsOf(s).map((r) => r.source).sort()).toEqual(['api', 'auto_filter', 'coop', 'moderator']);
  });
});

describe('only the kit holds the token', () => {
  it('the token is not exported from the package index, and no export is a symbol that could stand in for it', () => {
    expect(Object.keys(index)).not.toContain('AI_SOURCE_TOKEN');
    expect(Object.values(index)).not.toContain(AI_SOURCE_TOKEN);
    expect(Object.values(index).some((v) => typeof v === 'symbol')).toBe(false);
  });

  it('with the token the internal writer writes a source ai row (the actor path)', () => {
    const s = setup();
    const written = writeSanction(s.store, s.subjects, { ...base(s.subject, { source: 'ai', automated: true }), sourceToken: AI_SOURCE_TOKEN }, NOW, false);
    expect(written.rows[0]).toMatchObject({ source: 'ai', automated: true });
    expect(rowsOf(s).map((r) => r.source)).toEqual(['ai']);
    expect(() => validateSanctionInput({ ...base(s.subject, { source: 'ai' }), sourceToken: AI_SOURCE_TOKEN })).not.toThrow();
  });

  it('the token does not make another source or another check pass', () => {
    const s = setup();
    // still validated: a ban with no duration check, a bad kind
    expect(() => writeSanction(s.store, s.subjects, { ...base(s.subject, { source: 'ai', kind: 'warning', durationMs: 5 }), sourceToken: AI_SOURCE_TOKEN }, NOW, false)).toThrow(SanctionError);
  });

  it('a look-alike token (another symbol, a string, the description) is refused', async () => {
    const s = setup();
    const fakes: unknown[] = [Symbol('chatwarden.ai.source'), Symbol.for('chatwarden.ai.source'), 'chatwarden.ai.source', AI_SOURCE_TOKEN.toString(), AI_SOURCE_TOKEN.description, true, 1, {}, null];
    for (const t of fakes) {
      const input = { ...base(s.subject, { source: 'ai' }), sourceToken: t } as unknown as SanctionInput;
      await expect(applySanction(s.store, s.subjects, input, NOW), String(t)).rejects.toBeInstanceOf(SanctionError);
    }
    expect(rowsOf(s)).toEqual([]);
  });

  it('a token on an ordinary source is harmless', async () => {
    const s = setup();
    await applySanction(s.store, s.subjects, { ...base(s.subject), sourceToken: AI_SOURCE_TOKEN }, NOW);
    expect(rowsOf(s).map((r) => r.source)).toEqual(['moderator']);
  });
});

// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createT, en } from '../src/i18n.js';
import { sanctionWhat } from '../src/labels.js';

// `sanctionWhat` is one helper in the shared labels, so the appeal card never imports the appeals list (a chunk of its own).

const t = createT(en);
const H = 3_600_000;
const give = (kind: 'warning' | 'chat' | 'area' | 'ban' | 'note', startsAt: number, endsAt: number | null) => ({ kind, startsAt, endsAt }) as never;

describe('sanctionWhat', () => {
  it('names the sanction and its length in words', () => {
    expect(sanctionWhat(t, 'en', give('chat', 0, 24 * H))).toBe('Chat restriction, 24 hours');
    expect(sanctionWhat(t, 'en', give('ban', 0, null))).toBe('Ban, permanent');
    expect(sanctionWhat(t, 'en', give('warning', 5, 5))).toBe('Warning');
    expect(sanctionWhat(t, 'en', give('area', 10, 10 + 6 * H))).toMatch(/6 hours/);
  });
  it('a warning and a note carry no length even when an end is present', () => {
    expect(sanctionWhat(t, 'en', give('warning', 0, 5 * H))).toBe('Warning');
    expect(sanctionWhat(t, 'en', give('note', 0, 5 * H))).not.toMatch(/hour/);
  });
});

describe('where it lives', () => {
  const src = (file: string): string => readFileSync(fileURLToPath(new URL(`../src/${file}`, import.meta.url)), 'utf8');
  it('the card imports nothing from the appeals list; the list does not define it', () => {
    expect(src('case/AppealCard.tsx')).not.toMatch(/appeals\/AppealList/);
    expect(src('appeals/AppealList.tsx')).not.toMatch(/export function sanctionWhat/);
    expect(src('labels.ts')).toMatch(/export function sanctionWhat/);
  });
});

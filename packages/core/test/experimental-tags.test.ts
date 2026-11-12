import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The 0.1.9 additions to the facade are `@experimental` (design section 9): each member's TSDoc says so, so an adopter's editor shows it.

const SOURCE = readFileSync(fileURLToPath(new URL('../src/chatwarden.ts', import.meta.url)), 'utf8');

/** The TSDoc block that sits directly above the first line of the interface that starts with `signature`. */
function docAbove(signature: string): string {
  const at = SOURCE.indexOf(`\n    ${signature}`);
  expect(at, `${signature} is declared`).toBeGreaterThan(-1);
  const end = SOURCE.lastIndexOf('*/', at);
  const start = SOURCE.lastIndexOf('/**', end);
  // the block must end on the line just above the declaration
  expect(SOURCE.slice(end + 2, at).trim(), `${signature} has a doc block`).toBe('');
  return SOURCE.slice(start, end + 2);
}

describe('@experimental on the 0.1.9 facade members', () => {
  const members: Array<[string, string]> = [
    ['names.requireRename', 'requireRename(input'],
    ['names.pendingRename', 'pendingRename(who'],
    ['names.renamed', 'renamed(who'],
    ['names.renamesEnabled', 'renamesEnabled()'],
    ['names.renamesOf', 'renamesOf(subject'],
    ['people.accountIds', 'accountIds(subject'],
    ['appeals.forPerson', 'forPerson(subject: SubjectId): AppealSummary[]'],
    ['blocked.names', 'names(q: { days: BlockedDays }): BlockedNameItem[]'],
  ];
  for (const [name, signature] of members) {
    it(`${name} is tagged @experimental`, () => {
      expect(docAbove(signature)).toContain('@experimental');
    });
  }

  it('control: an older, stable member (blocked.countsByTerm) is not tagged, so the check can tell tagged from untagged', () => {
    expect(docAbove('countsByTerm(q: { days: BlockedDays }): Record<string, number>;')).not.toContain('@experimental');
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The CHANGELOGs ship inside the tarballs and cannot be edited after publish, so what the 0.1.2 upgrade notes must say is pinned here:
// the same text in all ten, naming every Store method that is new.

const root = fileURLToPath(new URL('..', import.meta.url));
const dirs = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

const section = (dir: string): string => {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('## 0.1.2');
  const end = text.indexOf('\n## 0.1.1', at);
  return text.slice(at, end < 0 ? undefined : end);
};
const upgradeNotes = (dir: string): string => {
  const s = section(dir);
  return s.slice(s.indexOf('**Upgrade notes**'));
};

/** The methods the Store interface gained since 0.1.1, read from the source of the interface. */
const storeMethods = (): { required: string[]; optional: string[] } => {
  const src = readFileSync(join(root, 'packages', 'core', 'src', 'types.ts'), 'utf8');
  const body = src.slice(src.indexOf('export interface Store '));
  const iface = body.slice(0, body.indexOf('\n}\n'));
  const all = [...iface.matchAll(/^ {2}([a-zA-Z]+)(\??)\(/gm)].map((m) => ({ name: m[1] ?? '', optional: m[2] === '?' }));
  return { required: all.filter((m) => !m.optional).map((m) => m.name), optional: all.filter((m) => m.optional).map((m) => m.name) };
};

const NEW_REQUIRED = [
  'listSubjectSanctions',
  'listStrikes',
  'countStrikesByTerm',
  'listOpenReports',
  'listOpenReportsByPerson',
  'reporterTally',
  'changeToken',
  'claimCase',
  'releaseClaim',
  'loadClaims',
  'listReasons',
  'insertReason',
  'updateReason',
  'setReasonActive',
];
const NEW_OPTIONAL = ['addReportDetail', 'loadPolicyLayer', 'savePolicyLayer', 'loadReporterDecisions'];

describe('the 0.1.2 upgrade notes (all ten CHANGELOGs)', () => {
  it('finds the ten packages', () => {
    expect(dirs).toHaveLength(10);
  });

  it('every new Store method named below is really on the interface, required or optional as claimed', () => {
    const { required, optional } = storeMethods();
    for (const m of NEW_REQUIRED) expect(required, m).toContain(m);
    for (const m of NEW_OPTIONAL) expect(optional, m).toContain(m);
  });

  it.each(dirs)('%s: names each of the 14 required and the 4 optional Store methods the interface gained', (dir) => {
    const notes = upgradeNotes(dir);
    expect(notes).toMatch(/`Store`/);
    for (const m of [...NEW_REQUIRED, ...NEW_OPTIONAL]) expect(notes, m).toContain(`\`${m}\``);
    expect(notes).toMatch(/14 required methods/);
    expect(notes).toMatch(/four optional/);
  });

  it.each(dirs)('%s: tells custom Store authors to run the contract suite in test/contract', (dir) => {
    const notes = upgradeNotes(dir).replace(/\s+/g, ' ');
    expect(notes).toMatch(/own `Store`/);
    expect(notes).toMatch(/contract suite/);
    expect(notes).toContain('test/contract');
  });

  it.each(dirs)('%s: mentions the @chatwarden/http/admin subpath', (dir) => {
    const notes = upgradeNotes(dir).replace(/\s+/g, ' ');
    expect(notes).toContain('`@chatwarden/http/admin`');
    expect(notes).toMatch(/browser/);
  });

  it('the 0.1.2 section is the same text in all ten', () => {
    const first = section(dirs[0] as string);
    for (const dir of dirs) expect(section(dir), dir).toBe(first);
  });
});

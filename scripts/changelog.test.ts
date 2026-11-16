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

// 0.1.3 is a patch release for studios: the notes say, in plain words, what changed and what is experimental or deprecated. They ship in
// every tarball, so the same text is in all ten.
const section013 = (dir: string): string => {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('## 0.1.3');
  const end = text.indexOf('\n## 0.1.2', at);
  return at < 0 ? '' : text.slice(at, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

describe('the 0.1.3 notes (all ten CHANGELOGs)', () => {
  it.each(dirs)('%s: has a 0.1.3 section above 0.1.2, as patch changes', (dir) => {
    const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(text.indexOf('## 0.1.3')).toBeGreaterThan(-1);
    expect(text.indexOf('## 0.1.3')).toBeLessThan(text.indexOf('## 0.1.2'));
    expect(section013(dir)).toContain('### Patch Changes');
  });

  it.each(dirs)('%s: says the matcher no longer ships obscenity’s English list (issue #8), with the same verdicts', (dir) => {
    const s = section013(dir);
    expect(s).toContain('issue #8');
    expect(s).toMatch(/word list/i);
    expect(s).toMatch(/smaller/);
    expect(s).toMatch(/same verdicts/);
  });

  it.each(dirs)('%s: says SQLite migration 18 adds indexes and is applied automatically', (dir) => {
    const s = section013(dir);
    expect(s).toContain('migration 18');
    expect(s).toMatch(/indexes/);
    expect(s).toMatch(/automatically/);
  });

  it.each(dirs)('%s: says the hub loads its screens on demand, a fifth smaller, and that onController and refresh are experimental', (dir) => {
    const s = section013(dir);
    expect(s).toMatch(/load when they are first opened/);
    expect(s).toContain('about a fifth smaller');
    expect(s).not.toMatch(/-?22\s?%/);
    expect(s).toContain('onController');
    expect(s).toContain('refresh()');
    expect(s).toMatch(/Experimental/);
  });

  it.each(dirs)('%s: says players report in one step, onAddDetail is deprecated and not called, and extra is experimental', (dir) => {
    const s = section013(dir);
    expect(s).toMatch(/one step/);
    expect(s).toContain('`onAddDetail`');
    expect(s).toMatch(/deprecated/);
    expect(s).toMatch(/no longer called/);
    expect(s).toContain('`extra`');
  });

  it.each(dirs)('%s: mentions the site demo fixes', (dir) => {
    expect(section013(dir)).toMatch(/demo/);
  });

  // Published notes cannot be edited, so what an upgrading studio must know is pinned here (final review I1, I2, M3, M4).
  it.each(dirs)('%s: warns that a store opened by 0.1.3 cannot go back to 0.1.2, and says to back up first', (dir) => {
    const s = section013(dir);
    expect(s).toMatch(/back up/i);
    expect(s).toMatch(/0\.1\.2 (will not|cannot) open/);
    expect(s).not.toContain('There is nothing to migrate.');
    expect(s).not.toContain('needs nothing from you');
  });

  it.each(dirs)('%s: tells translators the new and changed words, for the player dialog and the hub', (dir) => {
    const s = section013(dir);
    for (const key of ['player.report.why', 'whyRequired', 'choose', 'chooseRequired', 'addNote', 'intro', 'note']) expect(s, key).toContain(`\`${key}\``);
    for (const key of ['hub.reporting.preview.*', 'hub.state.what.reportingSettings', 'hub.state.reloadHint']) expect(s, key).toContain(`\`${key}\``);
    expect(s).toMatch(/raw key/);
  });

  it.each(dirs)('%s: says hand-written HubController and LiveQueueStore doubles need refresh(), and the dialog class names changed', (dir) => {
    const s = section013(dir);
    expect(s).toContain('`HubController`');
    expect(s).toContain('`LiveQueueStore`');
    expect(s).toMatch(/class names/);
    expect(s).toMatch(/tokens/);
  });

  it('the 0.1.3 section is the same text in all ten', () => {
    const first = section013(dirs[0] as string);
    for (const dir of dirs) expect(section013(dir), dir).toBe(first);
  });

  it('uses no em dash and no real term (synthetic only)', () => {
    for (const dir of dirs) expect(section013(dir), dir).not.toMatch(/—/);
  });
});

// 0.1.5 (triage speed): published notes cannot be edited, so what an upgrading studio must know is pinned here (final review I1, I2).
const section015 = (dir: string): string => {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('## 0.1.5');
  const end = text.indexOf('\n## 0.1.4', at);
  return at < 0 ? '' : text.slice(at, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

// Packages with no 0.1.5 change say "No changes in this release." (as in 0.1.4); the notes live in the others, the same in each.
const with015 = dirs.filter((d) => !section015(d).includes('No changes in this release'));

describe('the 0.1.5 notes (every CHANGELOG that has them)', () => {
  it('core and store-sqlite carry the notes', () => {
    expect(with015).toEqual(expect.arrayContaining(['core', 'store-sqlite']));
  });

  it.each(with015)('%s: says migration 19 is one-way and to back up before upgrading', (dir) => {
    const s = section015(dir);
    expect(s).toContain('migration 19');
    expect(s).toMatch(/one-way/i);
    expect(s).toMatch(/back up/i);
    expect(s).toMatch(/0\.1\.4 (will not|cannot) open/);
  });

  it.each(with015)('%s: names the contract changes a custom store, client or webhook sender meets', (dir) => {
    const s = section015(dir);
    expect(s).toContain('listOpenReportsByPerson');
    expect(s).toContain('201');
    expect(s).toContain('`HubClient`');
    expect(s).toContain('dismissOpen');
    expect(s).toMatch(/webhook/i);
  });

  it('the 0.1.5 notes are the same text in every CHANGELOG that has them', () => {
    const first = section015(with015[0] as string);
    for (const dir of with015) expect(section015(dir), dir).toBe(first);
  });
});

// 0.1.10 (fast adoption): the notes ship in every tarball and cannot be edited after publish, so what an adopter needs to know is pinned here. The
// text is the same in all ten; it names the bin, the three subpaths and what did not change.
const section0110 = (dir: string): string => {
  const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
  const at = text.indexOf('## 0.1.10');
  const end = text.indexOf('\n## 0.1.9', at);
  return at < 0 ? '' : text.slice(at, end < 0 ? undefined : end).replace(/\s+/g, ' ');
};

describe('the 0.1.10 notes (all ten CHANGELOGs)', () => {
  it.each(dirs)('%s: has a 0.1.10 section above 0.1.9, as patch changes', (dir) => {
    const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    expect(text.indexOf('## 0.1.10')).toBeGreaterThan(-1);
    expect(text.indexOf('## 0.1.10')).toBeLessThan(text.indexOf('## 0.1.9'));
    expect(section0110(dir)).toContain('### Patch Changes');
  });

  it.each(dirs)('%s: starts with what the release adds, and names the bin and the three subpaths', (dir) => {
    const s = section0110(dir);
    expect(s).toContain('Adds a setup command, a Web fetch adapter and a test kit');
    for (const needle of ['`chatwarden init`', 'the `chatwarden` bin of `@chatwarden/http`', '`@chatwarden/http/fetch`', '`toFetch`', '`@chatwarden/store-memory/testing`', '`@chatwarden/http/cli`']) {
      expect(s, needle).toContain(needle);
    }
  });

  it.each(dirs)('%s: says what init takes and gives: flags, --json, --check, the four exit codes, and that it never overwrites', (dir) => {
    const s = section0110(dir);
    for (const needle of ['`--json`', '`--check`', '`--dry-run`', '`--yes`', 'Exit codes: 0', '1 a usage error', '2 applied but some files were skipped', '3 could not write or install', 'never edits a file that exists', 'uses the network only with `--install`', 'writes no secret']) {
      expect(s, needle).toContain(needle);
    }
  });

  it.each(dirs)('%s: lists the @experimental names and says what did not change', (dir) => {
    const s = section0110(dir);
    expect(s).toContain('`@experimental` until 0.2');
    for (const name of ['`toFetch`', '`Mounts`', '`FetchOptions`', '`FetchHandler`', '`runCli`', '`CliEnv`']) expect(s, name).toContain(name);
    expect(s).toContain('No migration');
    expect(s).toContain('No new package is published');
    expect(s).toContain('No peer floor changes');
  });

  it('the 0.1.10 notes are the same text in all ten', () => {
    const first = section0110(dirs[0] as string);
    expect(first.length).toBeGreaterThan(500);
    for (const dir of dirs) expect(section0110(dir), dir).toBe(first);
  });

  it('the flags the notes name exist, and the words are the code\'s (a flag the notes name that init does not have would be a lie in a tarball)', async () => {
    const { OPTIONS } = await import('../packages/http/src/cli/args.js');
    const flags = new Set<string>(OPTIONS.map((o: { name: string }) => `--${o.name}`));
    flags.add('--no-discord');
    const named = [...section0110('http').matchAll(/`(--[a-z-]+)`/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(8);
    for (const flag of named) expect(flags.has(flag), flag).toBe(true);
  });
});

describe('the 0.1.11 notes (all ten CHANGELOGs)', () => {
  const section0111 = (dir: string): string => {
    const text = readFileSync(join(root, 'packages', dir, 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    const at = text.indexOf('## 0.1.11');
    expect(at, `${dir} has a 0.1.11 section`).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n## 0.1.10', at);
    return text.slice(at, end < 0 ? undefined : end);
  };

  it.each(dirs)('%s: opens with "adds an opt-in loader for the shared community term list" and is a patch', (dir) => {
    const s = section0111(dir);
    expect(s).toContain('### Patch Changes');
    expect(s).toContain('- Adds an opt-in loader for the shared community term list.');
  });

  it.each(dirs)('%s: names the two subpaths, LiveTerms.syncPack, the staff routes, the Community list and the four core names', (dir) => {
    const s = section0111(dir);
    for (const needle of ['`@chatwarden/matcher/corpus`', '`@chatwarden/matcher/corpus/node`', '`LiveTerms.syncPack`', '`startCorpus`', 'Community list', '`term.share`', '`term.report`', '`community.apply`', '`release`', '`POST /terms/:id/report`']) {
      expect(s, needle).toContain(needle);
    }
  });

  it.each(dirs)('%s: says no package ships any terms, nothing is on by default, and the names are experimental until 0.2', (dir) => {
    const s = section0111(dir).replace(/\s+/g, ' ');
    expect(s).toMatch(/No package ships any terms/);
    expect(s).toMatch(/nothing is on by default/i);
    expect(s).toContain('`@experimental` until 0.2');
    for (const name of ['`createCorpusLoader`', '`createCommunityShare`', '`CorpusLoader`', '`fileCache`', '`installationKey`']) expect(s, name).toContain(name);
  });

  it.each(dirs)('%s: is true about who is affected: the lead does not say nothing changes, and the word engine, /me, /terms, HubClient and the widened unions are named', (dir) => {
    const s = section0111(dir).replace(/\s+/g, ' ');
    expect(s).not.toMatch(/imports nothing new changes nothing/);
    expect(s).toContain('a project that imports nothing new sees the same results');
    expect(s).toContain('the word engine in `@chatwarden/matcher` is rewritten');
    expect(s).toMatch(/The word engine is rewritten, and every adopter gets it/);
    expect(s).toMatch(/finds the same hits/);
    expect(s).toMatch(/differential test/);
    expect(s).toMatch(/much faster at large term counts/);
    expect(s).toContain('`features.community`');
    expect(s).toContain('`MeFeatures.community?`');
    expect(s).toContain('community: { hidden }');
    expect(s).toMatch(/hand-written `HubClient` must add the new methods/);
    // the eight methods are named inside the sentence that says they are required
    const sentence = s.slice(s.indexOf('A hand-written `HubClient`'), s.indexOf('A hand-written `HubClient`') + 600);
    for (const m of ['community', 'refreshCommunity', 'applyCommunity', 'getTerm', 'lookupTerm', 'shareTerm', 'shareStatus', 'reportTerm']) expect(sentence, m).toContain('`' + m + '`');
    expect(s).toContain('**Four new names in `@chatwarden/core`:**');
    expect(s).not.toMatch(/Three new names/);
    expect(s).not.toMatch(/A report is audited as `term.share`/);
    expect(s).toMatch(/a report of a community term as `term.report`/);
    expect(s).toMatch(/`AuditAction` and `AuditTargetType` are wider unions/);
    expect(s).toMatch(/needs the new cases/);
  });

  it.each(dirs)('%s: says which peer floors rose and why, and that nothing else moved, no migration and no new package', (dir) => {
    const s = section0111(dir).replace(/\s+/g, ' ');
    expect(s).toMatch(/`@chatwarden\/http` and `@chatwarden\/hub-react` now need `@chatwarden\/core` `\^0\.1\.11`/);
    expect(s).toMatch(/`@chatwarden\/hub-react` also needs `@chatwarden\/http` `\^0\.1\.11`/);
    expect(s).toMatch(/`@chatwarden\/matcher` keeps `\^0\.1\.0`/);
    expect(s).toContain('No migration');
    expect(s).toContain('No new package is published');
  });

  it('the 0.1.11 notes are the same text in all ten', () => {
    const first = section0111(dirs[0] as string);
    expect(first.length).toBeGreaterThan(1500);
    for (const dir of dirs) expect(section0111(dir), dir).toBe(first);
  });

  it('every name the notes call experimental is really exported by the corpus entries or the matcher root', async () => {
    const corpus = readFileSync(join(root, 'packages', 'matcher', 'src', 'corpus', 'index.ts'), 'utf8') + readFileSync(join(root, 'packages', 'matcher', 'src', 'corpus', 'node', 'index.ts'), 'utf8');
    for (const name of ['createCorpusLoader', 'createCommunityShare', 'CorpusLoader', 'fileCache', 'installationKey', 'startCorpus']) expect(corpus, name).toContain(name);
    expect(readFileSync(join(root, 'packages', 'matcher', 'src', 'liveTerms.ts'), 'utf8')).toContain('syncPack(');
  });
});

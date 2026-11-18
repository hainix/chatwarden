import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The privacy and legal-hold docs describe what the kit stores and does. They are not legal advice and never claim that a law is met. These checks keep that true as the
// docs change: the runbook and both templates say so, and no doc or README promises compliance or legality.

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts: string[]): string => readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const packageReadmes = readdirSync(join(root, 'packages'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(root, 'packages', d.name, 'README.md')))
  .map((d) => join('packages', d.name, 'README.md'));
const docs = ['README.md', 'docs/status.md', 'docs/privacy-requests.md', 'docs/plans/follow-ups.md', ...packageReadmes];

describe('the privacy runbook', () => {
  const runbook = read('docs', 'privacy-requests.md');

  it('says it is not legal advice at the top, and again in the reply template and the hold note', () => {
    expect(runbook.split('\n').slice(0, 6).join('\n')).toMatch(/not legal advice/i);
    const templates = runbook.slice(runbook.indexOf('## Templates'));
    const replyTemplate = templates.slice(templates.indexOf('### A reply to a requester'), templates.indexOf('### A hold note'));
    const holdTemplate = templates.slice(templates.indexOf('### A hold note'));
    expect(replyTemplate).toMatch(/Not legal advice/);
    expect(holdTemplate).toMatch(/Not legal advice/);
  });

  it('says the kit does not judge legality, contact anyone or verify a requester', () => {
    expect(runbook).toMatch(/does not judge legality/);
    expect(runbook).toMatch(/verify a requester/);
  });
});

describe('every doc and README', () => {
  it('lists the files it checks (the runbook and the package readmes exist)', () => {
    for (const d of docs) expect(existsSync(join(root, d)), d).toBe(true);
    expect(packageReadmes.length).toBeGreaterThan(3);
  });

  it.each(docs)('%s claims neither compliance nor legality', (doc) => {
    const text = read(doc);
    for (const phrase of ['compliant', 'GDPR-compliant', 'legally', 'guarantees compliance', 'ensures compliance']) {
      expect(text.toLowerCase().includes(phrase.toLowerCase()), `${doc} contains "${phrase}"`).toBe(false);
    }
  });

  it('the privacy sections of the readmes carry the not-legal-advice words', () => {
    expect(read('packages/core/README.md')).toMatch(/Privacy requests and legal hold/);
    expect(read('packages/core/README.md')).toMatch(/not legal advice/i);
    expect(read('packages/hub-react/README.md')).toMatch(/not legal advice/i);
    expect(read('docs/status.md')).toMatch(/not legal advice/i);
  });
});

describe('the privacy runbook on overturned appeals (0.2.1)', () => {
  const runbook = read('docs', 'privacy-requests.md').replace(/\s+/g, ' ');

  it('names kit_overturns and says what it holds, what the export shows and that an erase removes the rows', () => {
    expect(runbook).toContain('`kit_overturns`');
    expect(runbook).toMatch(/one row for each decision overturned on appeal/);
    expect(runbook).toMatch(/the group, the time, the source, the person's subject id, and the term id or filter key that made the decision, never a word, a line or a statement/);
    expect(runbook).toMatch(/export shows (the time of the overturn|when a decision was overturned) on the appeal/i);
    expect(runbook).toMatch(/erase removes the person's overturn rows/);
  });

  it('says the retention clock is the appeals one (retention.appealsMs), and that an overturn on a held group stays', () => {
    expect(runbook).toMatch(/`retention\.appealsMs`/);
    expect(runbook).toMatch(/held for legal reasons/);
  });
});

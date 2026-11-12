// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n.js';

// 0.1.5 (triage speed): the README says what the keys do, how bulk dismiss and the reporter line behave, what the hub does NOT
// tell the moderator, and which words translators have to add. Each claim is a test, so the README cannot drift from the code.

const pkg = join(process.cwd(), 'packages', 'hub-react');
const raw = readFileSync(join(pkg, 'README.md'), 'utf8');
const readme = raw.replace(/\s+/g, ' ');

/** The words added in 0.1.5. A plural pair is listed by its base name. */
const NEW_KEYS = [
  'hub.quick.dismiss',
  'hub.quick.dismiss.hint',
  'hub.quick.held',
  'hub.decided.reason.default',
  'hub.decide.reason.hint.dismissal',
  'hub.toast.undone',
  'hub.toast.waiting',
  'hub.key.up',
  'hub.key.down',
  'hub.window.failed',
  'hub.command.undo',
  'hub.shortcuts.group.move',
  'hub.shortcuts.group.act',
  'hub.shortcuts.group.general',
  'hub.shortcuts.primary',
  'hub.shortcuts.dismiss',
  'hub.shortcuts.warning',
  'hub.shortcuts.decide',
  'hub.shortcuts.or',
  'hub.shortcuts.undo',
  'hub.shortcuts.quickKeys.label',
  'hub.shortcuts.quickKeys.hint',
  'hub.shortcuts.quickKeys.on',
  'hub.shortcuts.quickKeys.off',
  'hub.shortcuts.quickKeys.only',
  'hub.bulk.open',
  'hub.bulk.person',
  'hub.bulk.reporter',
  'hub.bulk.reporter.habitual',
  'hub.bulk.confirm.counting',
  'hub.bulk.confirm.title.person',
  'hub.bulk.confirm.title.reporter',
  'hub.bulk.confirm.body',
  'hub.bulk.confirm.claimed',
  'hub.bulk.confirm.heldBy',
  'hub.bulk.confirm.takeOver',
  'hub.bulk.confirm.none',
  'hub.bulk.confirm.go',
  'hub.bulk.confirm.cancel',
  'hub.bulk.confirm.close',
  'hub.bulk.held',
  'hub.bulk.done',
  'hub.bulk.skipped.claimed',
  'hub.bulk.more',
  'hub.bulk.more.again',
  'hub.bulk.failed',
  'hub.bulk.failed.claimed',
  'hub.reporter.rate.line',
  'hub.reporter.rate.ranked',
  'hub.queue.row.rankedLow',
  'hub.audit.label.report.dismissCase',
  'hub.audit.label.report.dismissReporter',
];

const catalogue = en as Record<string, string>;
/** The keys a catalogue really holds for a base name: the key itself or its `.one` / `.other` pair. */
const holds = (base: string): string[] => Object.keys(catalogue).filter((k) => k === base || k === `${base}.one` || k === `${base}.other`);

describe('the words added in 0.1.5', () => {
  it('every listed key is in the English catalogue (a control: the list is not a wish)', () => {
    for (const base of NEW_KEYS) expect(holds(base), base).not.toEqual([]);
  });

  it('plural pairs are complete: a base with .one has .other too', () => {
    for (const base of NEW_KEYS) {
      const keys = holds(base);
      if (keys.includes(`${base}.one`)) expect(keys, base).toContain(`${base}.other`);
    }
  });

  it('the README names every one of them in its translation section', () => {
    const words = raw.slice(raw.indexOf('### Words and languages'), raw.indexOf('## Theming'));
    expect(words.length).toBeGreaterThan(200);
    for (const base of NEW_KEYS) expect(words, base).toContain('`' + base + '`');
  });

  it('the README says a missing key falls back to English, and that translators must add these', () => {
    expect(readme).toMatch(/Translators:? (must )?add/i);
    expect(readme).toMatch(/falls back to English/i);
  });

  it('keeps the old reason word, deprecated, not removed', () => {
    expect(catalogue['hub.simple.noAction.reason']).toBeTypeOf('string');
    expect(readme).toMatch(/`hub\.simple\.noAction\.reason`[^.]*(deprecated|no longer sent)/i);
  });
});

describe('the keyboard section', () => {
  const keyboard = raw.slice(raw.indexOf('**Keyboard.**'), raw.indexOf('**Toasts and Undo.**')).replace(/\s+/g, ' ');

  it('has a row for U, 1 2 3, the arrow keys and Ctrl or Cmd+Enter', () => {
    expect(keyboard).toMatch(/\| `U` \|/);
    expect(keyboard).toMatch(/\| `1` \|/);
    expect(keyboard).toMatch(/\| `2` \|/);
    expect(keyboard).toMatch(/\| `3` \|/);
    expect(keyboard).toMatch(/Down arrow/);
    expect(keyboard).toMatch(/Up arrow/);
    expect(keyboard).toMatch(/Ctrl\+Enter|Ctrl or Cmd\+Enter/);
  });

  it('explains Quick keys: the default in each mode, and where the switch is', () => {
    expect(keyboard).toMatch(/Quick keys/);
    expect(keyboard).toMatch(/on in Simple/i);
    expect(keyboard).toMatch(/off in Detailed/i);
    expect(keyboard).toMatch(/`\?` sheet|shortcut sheet/i);
    expect(keyboard).toMatch(/chatwarden\.hub\.quickKeys/);
  });

  it('M8: the act-key guard runs on performance.now(), so a frozen hub clock does not block it', () => {
    const k = keyboard.replace(/\s+/g, ' ');
    expect(k).toMatch(/performance\.now\(\)/);
    expect(k).toMatch(/frozen/i);
    expect(k).toMatch(/not (by|on) the hub's `now`|not the hub's `now`|never the hub's `now`/);
  });

  it('M8: keys pressed while a case is loading or a window is opening are dropped, with no message', () => {
    const k = keyboard.replace(/\s+/g, ' ');
    expect(k).toMatch(/while a case is loading/i);
    expect(k).toMatch(/window is opening/i);
    expect(k).toMatch(/silently (dropped|ignored)|dropped without|no message/i);
  });

  it('M8: U undoes the newest waiting decision first, then the one before it', () => {
    const k = keyboard.replace(/\s+/g, ' ');
    expect(k).toMatch(/newest (waiting )?decision first/i);
  });

  it('says held keys, a second tap and the 300 ms rule once', () => {
    const k = keyboard.replace(/\s+/g, ' ');
    expect(k).toMatch(/held key/i);
    expect(k).toMatch(/300 ms/);
  });
});

describe('the quick actions, bulk dismiss and the reporter line', () => {
  it('Simple: "No action needed" sends no reason, the kit stores the standard one, and it goes on to the next case', () => {
    expect(readme).not.toMatch(/the reason "No rule was broken"/);
    expect(readme).toMatch(/`NO_ACTION_DEFAULT_REASON`|standard reason/);
    expect(readme).toMatch(/goes on to the next case|then the next case/i);
  });

  it('Detailed: the "Nothing wrong here" button is described, with what it does not do', () => {
    expect(readme).toMatch(/"Nothing wrong here"/);
    expect(readme).toMatch(/Nobody is told and nobody is marked|nobody is told/i);
  });

  it('bulk dismiss: where it lives, the permissions, the Undo window, and that it never marks bad faith', () => {
    expect(readme).toMatch(/Close more reports at once/);
    expect(readme).toMatch(/`reports\.decide\.bulk`/);
    expect(readme).toMatch(/200/);
    expect(readme).toMatch(/never marks bad faith|never bad faith/i);
    expect(readme).toMatch(/\bmaya\b|another moderator/i);
  });

  it('the reporter line: staff only, ranked lower and never hidden, no leaderboard', () => {
    expect(readme).toMatch(/`history\.read`/);
    expect(readme).toMatch(/listed lower|ranked lower/i);
    expect(readme).toMatch(/none is hidden|never hid(es|den)|nothing is hidden/i);
  });

  it('held decisions stack: the newest shows with Undo, the rest are one line', () => {
    expect(readme).toMatch(/earlier decisions? waiting/i);
    expect(readme).toMatch(/`TOAST_HELD_MAX`/);
  });
});

describe('troubleshooting', () => {
  it('N4: a window or screen that failed to load may stay failed until the page is reloaded', () => {
    const trouble = raw.slice(raw.indexOf('### Troubleshooting'));
    expect(trouble.length).toBeGreaterThan(100);
    const t = trouble.replace(/\s+/g, ' ');
    expect(t).toMatch(/failed to load/i);
    expect(t).toMatch(/until the page (is )?reload/i);
    expect(t).toMatch(/Could not open this window/);
  });

  it('an older http answers 400 to a dismissal with no reason: the peer floor is named', () => {
    const t = raw.slice(raw.indexOf('### Troubleshooting')).replace(/\s+/g, ' ');
    expect(t).toMatch(/@chatwarden\/http` 0\.1\.5|`@chatwarden\/http` `?\^?0\.1\.5/);
  });
});

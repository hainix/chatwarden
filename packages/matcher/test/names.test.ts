import { describe, expect, it } from 'vitest';
import { buildMatcher, matchName, nameViews } from '../src/index.js';
import { SYNTHETIC_TERMS } from '../src/fixtures/syntheticPack.js';
import { packExceptionRows, packTermRows, term } from './fixtures/rows.js';

const pack = () => buildMatcher(packTermRows(), packExceptionRows());
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const terms = SYNTHETIC_TERMS.map((t) => t.term);

describe('nameViews', () => {
  it('keeps the name itself as the first view', () => {
    expect(nameViews('Plain Name')[0]).toBe('Plain Name');
  });

  it('reads underscores as spaces', () => {
    expect(nameViews('big_red_dragon')).toContain('big red dragon');
    expect(nameViews('big__red')).toContain('big red');
  });

  it('splits camelCase and an upper-case run before a capitalised word', () => {
    const views = nameViews('BigRedDragon');
    expect(views.some((v) => v.includes('Big Red Dragon'))).toBe(true);
    expect(nameViews('XXDragon').some((v) => v.includes('XX Dragon'))).toBe(true);
  });

  it('has a view with digit runs read as spaces, and one that keeps them (leetspeak)', () => {
    const views = nameViews('dragon_42');
    expect(views).toContain('dragon 42');
    expect(views.some((v) => v.trim() === 'dragon')).toBe(true);
  });

  it('gives one view for a name with nothing to segment', () => {
    expect(nameViews('dragon')).toEqual(['dragon']);
  });

  it('lists the digit-free view last and never repeats a view', () => {
    const views = nameViews('Big_Dragon7');
    expect(new Set(views).size).toBe(views.length);
    expect(views.at(-1)).not.toMatch(/\d/);
  });

  it('segments accented capitals and lowercase too', () => {
    expect(nameViews('élanÉclat')).toContain('élan Éclat');
  });

  it('copes with the empty name', () => {
    expect(nameViews('')).toEqual(['']);
  });
});

describe('matchName (synthetic pack)', () => {
  const m = pack();

  it('blocks every pack term on its own, as the chat matcher does', () => {
    for (const t of terms) expect(matchName(m, t), t).not.toBeNull();
  });

  it('blocks a term glued to underscores, digits or camelCase, the shapes usernames take', () => {
    for (const t of terms) {
      for (const name of [`${t}_`, `_${t}_`, `x_${t}`, `${t}123`, `${t}2`, `69${t}`, `Big${cap(t)}`, `${cap(t)}Slayer`, `XX${cap(t)}`]) {
        expect(matchName(m, name), `shape ${name.replace(t, '<t>').replace(cap(t), '<T>')} of ${t}`).not.toBeNull();
      }
    }
  });

  it('camelCase, underscores and digit runs are views', () => {
    expect(matchName(m, 'xZorbakx')).toBeNull(); // buried mid-word: the whole-word rule holds in every view
    expect(matchName(m, 'Zorbak_99')).toEqual({ termId: 'syn:zorbak' });
    expect(matchName(m, 'TheZorbak')).toEqual({ termId: 'syn:zorbak' });
    expect(matchName(m, 'zorbak99')).toEqual({ termId: 'syn:zorbak' });
    expect(matchName(m, 'xXZorbakXx')).toEqual({ termId: 'syn:zorbak' }); // the humps segment it: x X Zorbak Xx
  });

  it('still blocks in-word leetspeak once the name is segmented', () => {
    for (const line of SYNTHETIC_TERMS.flatMap((t) => t.positive)) {
      expect(matchName(m, `${line}_x`.replace(/ /g, '_')), line).not.toBeNull();
    }
  });

  it('blocks every positive chat line (a name check never loosens the chat check)', () => {
    for (const line of SYNTHETIC_TERMS.flatMap((t) => t.positive)) expect(matchName(m, line), line).not.toBeNull();
  });

  it('never blocks a negative line, as written or as a snake_case / camelCase name', () => {
    for (const line of SYNTHETIC_TERMS.flatMap((t) => t.negative)) {
      expect(matchName(m, line), line).toBeNull();
      expect(matchName(m, line.replace(/\s+/g, '_')), line).toBeNull();
      expect(matchName(m, line.split(/\s+/).map((w) => (w ? cap(w) : w)).join('')), line).toBeNull();
    }
  });

  it('passes ordinary handles, table and deck names', () => {
    for (const name of ['Battlefalcon', 'viper_blade', 'xXDragonXx', 'Mono-Red Aggro', 'EDH 7/10 no stax', 'Atraxa Superfriends', 'player123', 'Snerpington United']) {
      expect(matchName(m, name), name).toBeNull();
    }
  });

  it('an exception phrase still applies to a name written with spaces or underscores', () => {
    expect(matchName(m, 'tarvo lake')).toBeNull();
    expect(matchName(m, 'Tarvo_Lake')).toBeNull();
    expect(matchName(m, 'TarvoLake')).toBeNull();
    expect(matchName(m, 'Tarvo_Lakes')).not.toBeNull();
  });

  it('reports the term id of the row that matched', () => {
    const rows = [term('row-7', 'zorbak')];
    expect(matchName(buildMatcher(rows, []), 'TheZorbak_99')).toEqual({ termId: 'row-7' });
  });

  it('a name against a matcher with no active terms is never blocked', () => {
    expect(matchName(buildMatcher([term('a', 'zorbak', false)], []), 'Zorbak_99')).toBeNull();
  });

  it('works with any object shaped like a Matcher', () => {
    const seen: string[] = [];
    const fake = { match: (t: string) => { seen.push(t); return t === 'big red' ? { termId: 'f' } : null; } };
    expect(matchName(fake, 'big_red')).toEqual({ termId: 'f' });
    expect(seen[0]).toBe('big_red');
  });
});

describe('Matcher.matchName (built matchers)', () => {
  it('buildMatcher carries matchName with the same semantics as the matchName helper', () => {
    const m = pack();
    expect(typeof m.matchName).toBe('function');
    for (const name of ['Zorbak_99', 'TheZorbak', 'zorbak99', 'xXZorbakXx', 'x_zorbak', 'BigVlemmo', 'Alice', 'quill_42', '', 'xZorbakx']) {
      expect(m.matchName?.(name) ?? null, name).toEqual(matchName(m, name));
    }
  });

  it('catches the handle form that plain match misses', () => {
    const m = pack();
    expect(m.match('Zorbak_99')).toBeNull();
    expect(m.matchName?.('Zorbak_99')).toEqual({ termId: 'syn:zorbak' });
  });

  it('a matcher with no active terms has a matchName that never matches', () => {
    const m = buildMatcher([term('a', 'zorbak', false)], []);
    expect(m.matchName?.('Zorbak_99')).toBeNull();
  });

  it('honours exceptions like match does', () => {
    const m = pack();
    expect(m.matchName?.('Tarvo_Lake')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { storeContract } from '../../../test/contract/index.js';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryLinks, withMemoryNames, withMemorySignals } from '../src/index.js';

// The shared Store contract suite (test/contract), run against MemoryStore. SqliteStore runs the same suite.
const make = () => withMemoryLinks(withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));
storeContract('MemoryStore', make);

// The appeal, blocked-name and link contract areas skip a store without the methods; MemoryStore (with its wrappers) must never be skipped.
describe('MemoryStore is not skipped by the optional contract areas', () => {
  it('has the appeal, blocked-name and link methods', () => {
    const s = make();
    for (const m of ['insertAppeal', 'decideAppeal', 'closeOrphanAppeals', 'purgeAppeals', 'insertBlockedName', 'purgeBlockedNames', 'getLink', 'putLink', 'listLinks', 'purgeLinks'] as const) expect(typeof s[m], m).toBe('function');
  });
});

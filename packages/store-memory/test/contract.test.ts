import { describe, expect, it } from 'vitest';
import { storeContract } from '../../../test/contract/index.js';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryNames, withMemorySignals } from '../src/index.js';

// The shared Store contract suite (test/contract), run against MemoryStore. SqliteStore runs the same suite.
const make = () => withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore()))));
storeContract('MemoryStore', make);

// The appeal and blocked-name contract areas skip a store without the methods; MemoryStore (with its wrappers) must never be skipped.
describe('MemoryStore is not skipped by the optional contract areas', () => {
  it('has the appeal and blocked-name methods', () => {
    const s = make();
    for (const m of ['insertAppeal', 'decideAppeal', 'closeOrphanAppeals', 'purgeAppeals', 'insertBlockedName', 'purgeBlockedNames'] as const) expect(typeof s[m], m).toBe('function');
  });
});

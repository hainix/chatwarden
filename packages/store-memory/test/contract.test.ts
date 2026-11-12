import { storeContract } from '../../../test/contract/index.js';
import { MemoryStore, withMemoryAi, withMemorySignals } from '../src/index.js';

// The shared Store contract suite (test/contract), run against MemoryStore. SqliteStore runs the same suite.
storeContract('MemoryStore', () => withMemorySignals(withMemoryAi(new MemoryStore())));

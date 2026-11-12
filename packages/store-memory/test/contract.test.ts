import { storeContract } from '../../../test/contract/index.js';
import { MemoryStore, withMemoryAi, withMemoryAppeals, withMemoryNames, withMemorySignals } from '../src/index.js';

// The shared Store contract suite (test/contract), run against MemoryStore. SqliteStore runs the same suite.
storeContract('MemoryStore', () => withMemoryNames(withMemoryAppeals(withMemorySignals(withMemoryAi(new MemoryStore())))));

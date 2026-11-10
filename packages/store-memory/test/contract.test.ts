import { storeContract } from '../../../test/contract/index.js';
import { MemoryStore } from '../src/index.js';

// The shared Store contract suite (test/contract), run against MemoryStore. SqliteStore runs the same suite.
storeContract('MemoryStore', () => new MemoryStore());

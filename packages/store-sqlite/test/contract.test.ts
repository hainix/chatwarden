import { DatabaseSync } from 'node:sqlite';
import { storeContract } from '../../../test/contract/index.js';
import { openStore } from '../src/index.js';

// The shared Store contract suite (test/contract), run against SqliteStore: the reference implementation.
storeContract('SqliteStore', () => openStore({ db: new DatabaseSync(':memory:') }));

import { DatabaseSync } from 'node:sqlite';
import { storeContract } from '../../../test/contract/index.js';
import { openStore } from '../src/index.js';

// The shared Store contract suite (test/contract), run against SqliteStore: the reference implementation.
// `dump` reads every `kit_` table straight from the database, so a row the store API cannot see still shows.
const dbs = new WeakMap<object, DatabaseSync>();
const make = () => {
  const db = new DatabaseSync(':memory:');
  const store = openStore({ db });
  dbs.set(store, db);
  return store;
};
export const dumpSqlite = (store: object): string => {
  const db = dbs.get(store);
  if (db === undefined) throw new Error('not a store of this suite');
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'kit_%' ORDER BY name").all().map((r) => String(r.name));
  return names.map((n) => `${n}: ${JSON.stringify(db.prepare(`SELECT * FROM ${n}`).all())}`).join('\n');
};
storeContract('SqliteStore', make, dumpSqlite);

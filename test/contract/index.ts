// The shared Store contract suite. `storeContract(name, make)` registers one vitest suite per area of the Store interface;
// every Store (MemoryStore, SqliteStore, and any adapter later) runs the same one, so "the stores agree" is enforced and
// not just observed. SqliteStore is the reference: when the suites disagree, the other store is wrong.
// This directory is test-only and never published. It imports `vitest` and `@chatwarden/core` types and nothing else.
import type { Store } from '@chatwarden/core';
import { auditContract } from './audit.contract.js';
import { discordThreadsContract } from './discordThreads.contract.js';
import { mutesContract } from './mutes.contract.js';
import { noticesContract } from './notices.contract.js';
import { reportsContract } from './reports.contract.js';
import { retentionContract } from './retention.contract.js';
import { sanctionsContract } from './sanctions.contract.js';
import { strikesContract } from './strikes.contract.js';
import { subjectsContract } from './subjects.contract.js';
import { transactionsContract } from './transactions.contract.js';
import { viewsContract } from './views.contract.js';
import { webhookKeysContract } from './webhookKeys.contract.js';

export {
  auditContract,
  discordThreadsContract,
  mutesContract,
  noticesContract,
  reportsContract,
  retentionContract,
  sanctionsContract,
  strikesContract,
  subjectsContract,
  transactionsContract,
  viewsContract,
  webhookKeysContract,
};

/** The name of every area suite, in the order `storeContract` registers them. */
export const CONTRACT_AREAS = [
  'transactions',
  'subjects',
  'sanctions',
  'mutes',
  'strikes',
  'reports',
  'notices',
  'audit',
  'retention',
  'webhook keys',
  'discord threads',
  'staff views',
] as const;

/** Registers every area suite against the stores `make` builds (a fresh, empty store on each call). */
export function storeContract(name: string, make: () => Store): void {
  transactionsContract(name, make);
  subjectsContract(name, make);
  sanctionsContract(name, make);
  mutesContract(name, make);
  strikesContract(name, make);
  reportsContract(name, make);
  noticesContract(name, make);
  auditContract(name, make);
  retentionContract(name, make);
  webhookKeysContract(name, make);
  discordThreadsContract(name, make);
  viewsContract(name, make);
}

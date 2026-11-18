// The shared Store contract suite. `storeContract(name, make)` registers one vitest suite per area of the Store interface;
// every Store (MemoryStore, SqliteStore, and any adapter later) runs the same one, so "the stores agree" is enforced and
// not just observed. SqliteStore is the reference: when the suites disagree, the other store is wrong.
// This directory is test-only and never published. It imports `vitest` and `@chatwarden/core` types and nothing else.
import type { Store } from '@chatwarden/core';
import { aiContract } from './ai.contract.js';
import { aiActContract } from './ai-act.contract.js';
import { aiShadowContract } from './ai-shadow.contract.js';
import { appealsContract } from './appeals.contract.js';
import { auditContract } from './audit.contract.js';
import { deskContract } from './desk.contract.js';
import { discordThreadsContract } from './discordThreads.contract.js';
import { filtersContract } from './filters.contract.js';
import { legalContract } from './legal.contract.js';
import { linksContract } from './links.contract.js';
import { mutesContract } from './mutes.contract.js';
import { namesContract } from './names.contract.js';
import { noticesContract } from './notices.contract.js';
import { paceContract } from './pace.contract.js';
import { policyContract } from './policy.contract.js';
import { privacyContract } from './privacy.contract.js';
import { reportReasonsContract } from './reportReasons.contract.js';
import { reportsContract } from './reports.contract.js';
import { retentionContract } from './retention.contract.js';
import { sanctionsContract } from './sanctions.contract.js';
import { scopeContract } from './scope.contract.js';
import { signalsContract } from './signals.contract.js';
import { strikesContract } from './strikes.contract.js';
import { teamContract } from './team.contract.js';
import { subjectsContract } from './subjects.contract.js';
import { transactionsContract } from './transactions.contract.js';
import { viewsContract } from './views.contract.js';
import { webhookKeysContract } from './webhookKeys.contract.js';

export {
  aiActContract,
  aiContract,
  aiShadowContract,
  appealsContract,
  auditContract,
  deskContract,
  discordThreadsContract,
  filtersContract,
  legalContract,
  linksContract,
  mutesContract,
  namesContract,
  noticesContract,
  paceContract,
  policyContract,
  privacyContract,
  reportReasonsContract,
  reportsContract,
  retentionContract,
  sanctionsContract,
  scopeContract,
  signalsContract,
  strikesContract,
  subjectsContract,
  teamContract,
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
  'team',
  'policy',
  'report reasons',
  'ai',
  'ai act',
  'ai shadow',
  'signals',
  'appeals',
  'names',
  'links',
  'filters',
  'privacy',
  'legal',
  'desk',
  'scope',
  'pace',
] as const;

/**
 * Registers every area suite against the stores `make` builds (a fresh, empty store on each call). `dump` (optional) turns a whole store into one string; the
 * privacy suite uses it to prove no id of an erased person survives in any table.
 */
export function storeContract(name: string, make: () => Store, dump?: (s: Store) => string): void {
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
  teamContract(name, make);
  policyContract(name, make);
  reportReasonsContract(name, make);
  aiContract(name, make);
  aiActContract(name, make);
  aiShadowContract(name, make);
  signalsContract(name, make);
  appealsContract(name, make);
  namesContract(name, make);
  linksContract(name, make);
  filtersContract(name, make);
  privacyContract(name, make, dump);
  legalContract(name, make);
  deskContract(name, make);
  scopeContract(name, make);
  paceContract(name, make);
}

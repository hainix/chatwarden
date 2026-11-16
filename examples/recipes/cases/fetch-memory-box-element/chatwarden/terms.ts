// The live term list: which words the matcher blocks.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { LiveTerms } from '@chatwarden/matcher';
import { MemoryTermStore, syntheticTermPack } from '@chatwarden/matcher/fixtures';

// The ids of the synthetic pack all start with this. A store that holds nothing else is still on the test words.
const SYNTHETIC_PREFIX = 'syn:';

// TODO(terms): TEST WORDS ONLY. Replace this pack with your own term list before launch.
// LiveTerms keeps every edit in the store, so moderators change words in the hub's Words screen.
export async function loadMatcher(): Promise<LiveTerms> {
  const terms = new LiveTerms({ store: new MemoryTermStore(), pack: syntheticTermPack(), clock: { now: () => Date.now() } });
  await terms.load();
  const rows = terms.rows.terms;
  if (process.env.NODE_ENV === 'production' && rows.length > 0 && rows.every((row) => row.id.startsWith(SYNTHETIC_PREFIX))) {
    console.warn('chatwarden: the term list is still the synthetic test pack; add your own words before launch');
  }
  return terms;
}

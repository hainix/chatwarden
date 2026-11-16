// `terms.ts`: the live term list, seeded from the synthetic test pack (design 7.3). The kit ships no real word list (that is a product rule),
// so this is the honest default, and `chatwarden init --check` reports it until it is replaced.
import type { FileSpec } from '../types.js';
import { imp, impType, t } from './frag.js';
import type { Ctx } from './frag.js';
import { header } from './header.js';

export function termsFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  const sqlite = answers.store === 'sqlite';
  const imports =
    imp(ctx, 'LiveTerms', '@chatwarden/matcher') +
    impType(ctx, 'TermStore', '@chatwarden/matcher') +
    (sqlite ? imp(ctx, 'syntheticTermPack', '@chatwarden/matcher/fixtures') : imp(ctx, ['MemoryTermStore', 'syntheticTermPack'], '@chatwarden/matcher/fixtures'));
  // The memory store keeps no term list, so its words live in a store of their own and are lost on restart like everything else.
  const param = sqlite ? `store${t(ctx, ': TermStore')}` : '';
  const storeArg = sqlite ? 'store' : 'new MemoryTermStore()';
  const content = `${header(ctx, 'The live term list: which words the matcher blocks.')}${imports}
// The ids of the synthetic pack all start with this. A store that holds nothing else is still on the test words.
const SYNTHETIC_PREFIX = 'syn:';

// TODO(terms): TEST WORDS ONLY. Replace this pack with your own term list before launch.
// LiveTerms keeps every edit in the store, so moderators change words in the hub's Words screen.
export async function loadMatcher(${param})${t(ctx, ': Promise<LiveTerms>')} {
  const terms = new LiveTerms({ store: ${storeArg}, pack: syntheticTermPack(), clock: { now: () => Date.now() } });
  await terms.load();
  const rows = terms.rows.terms;
  if (process.env.NODE_ENV === 'production' && rows.length > 0 && rows.every((row) => row.id.startsWith(SYNTHETIC_PREFIX))) {
    console.warn('chatwarden: the term list is still the synthetic test pack; add your own words before launch');
  }
  return terms;
}
`;
  return [{ path: `${answers.dir}/terms${ctx.scriptExt}`, content, markers: ['TODO(terms)'] }];
}

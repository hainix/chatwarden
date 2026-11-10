// Every word the hub shows is a key in this catalog; components never hold English.
//
// Key naming: `hub.<area>.<thing>[.<detail>]`, lower camel case segments, for example `hub.reports.row.review`.
// Areas so far: nav, session, gate, route, state, error, overview, reports, sanction, source, category, person, time.
// A new screen adds its own area (`hub.report.*`, `hub.terms.*`).
// Plural forms add the CLDR category as the last segment: `hub.reports.count.one`, `hub.reports.count.other`. A caller asks
// for the base key with a numeric `count` (`t('hub.reports.count', { count: 3 })`); `.zero` is used for 0 when it exists.
// `{name}` marks a value to fill in. To translate, spread this catalog over yours so a missing key falls back to English:
// `createT({ ...en, ...de }, 'de')`.

export const en = {
  'hub.title': 'Moderation',
  'hub.skip': 'Skip to the main content',

  'hub.nav.label': 'Moderator hub sections',
  'hub.nav.overview': 'Overview',
  'hub.nav.reports': 'Reports',
  'hub.nav.blocked': 'Blocked',
  'hub.nav.terms': 'Terms',
  'hub.nav.gaps': 'Rule gaps',
  'hub.nav.audit': 'Audit',
  'hub.nav.guide': 'Guide',

  'hub.session.label': 'Signed in',
  'hub.session.role.moderator': 'Moderator',
  'hub.session.role.senior': 'Senior moderator',
  'hub.session.role.owner': 'Owner',

  'hub.gate.loading': 'Loading the hub',
  'hub.gate.unauthorized.title': 'Sign in to use the hub',
  'hub.gate.unauthorized.body': 'The server did not recognise you. Sign in to your staff account, then reload this page.',
  'hub.gate.forbidden.title': 'No access to the hub',
  'hub.gate.forbidden.body': 'You are signed in, but your account is not allowed to use the moderator hub. Ask an owner to give you a role.',
  'hub.gate.failed.title': 'The hub could not start',

  'hub.route.noAccess.title': 'Not available for your role',
  'hub.route.noAccess.body': 'Ask an owner if you need this screen.',
  'hub.route.notFound.title': 'That page does not exist',
  'hub.route.notFound.body': 'The link may be old or mistyped.',
  'hub.route.notFound.back': 'Back to the overview',
  'hub.route.soon.title': '{name} is not available yet',
  'hub.route.soon.body': 'This screen is still being built.',
  'hub.route.soon.name.report': 'Report',
  'hub.route.soon.name.person': 'Person',

  'hub.state.loading': 'Loading',
  'hub.state.retry': 'Try again',
  'hub.state.loadFailed': 'Could not load {what}.',
  'hub.state.what.reports': 'the reports',
  'hub.state.what.actions': 'recent actions',

  'hub.error.network': 'Could not reach the server. Check your connection and try again.',
  'hub.error.unauthorized': 'You are signed out. Sign in again to continue.',
  'hub.error.forbidden': 'Your role cannot do this.',
  'hub.error.notFound': 'That no longer exists.',
  'hub.error.rateLimited': 'Too many requests. Try again in a moment.',
  'hub.error.rateLimited.after.one': 'Too many requests. Try again in {count} second.',
  'hub.error.rateLimited.after.other': 'Too many requests. Try again in {count} seconds.',
  'hub.error.server': 'The server had a problem. Try again in a moment.',
  'hub.error.generic': 'Something went wrong.',

  'hub.overview.title': 'Overview',
  'hub.overview.stats.label': 'At a glance',
  'hub.overview.stat.people': 'People waiting',
  'hub.overview.stat.reports': 'Open reports',
  'hub.overview.stat.longest': 'Longest wait',
  'hub.overview.stat.longestNote': 'Oldest open report is against {who}',
  'hub.overview.stat.none': 'None',
  'hub.overview.stat.nobody': 'Nobody is waiting',
  'hub.overview.stat.partial.one': 'Counted from the newest {count} report. Older ones are not included.',
  'hub.overview.stat.partial.other': 'Counted from the newest {count} reports. Older ones are not included.',
  'hub.overview.review.title': 'Needs review',
  'hub.overview.review.all': 'All reports',
  'hub.overview.review.empty.title': 'All clear',
  'hub.overview.review.empty.body': 'No open reports. Nothing is waiting on you.',
  'hub.overview.recent.title': 'Recent actions',
  'hub.overview.recent.empty': 'No actions yet. They show here as moderators act.',

  'hub.reports.title': 'Reports',
  'hub.reports.status.label': 'Report status',
  'hub.reports.status.open': 'Open',
  'hub.reports.status.actioned': 'Actioned',
  'hub.reports.status.dismissed': 'Dismissed',
  'hub.reports.status.all': 'All',
  'hub.reports.list.label': 'Reported people',
  'hub.reports.empty.open': 'No open reports. Nothing is waiting on you.',
  'hub.reports.empty.actioned': 'No actioned reports yet.',
  'hub.reports.empty.dismissed': 'No dismissed reports yet.',
  'hub.reports.empty.all': 'No reports yet.',
  'hub.reports.row.unnamed': 'Unnamed player',
  'hub.reports.row.reports.one': '{count} report',
  'hub.reports.row.reports.other': '{count} reports',
  'hub.reports.row.rooms.one': '{count} room',
  'hub.reports.row.rooms.other': '{count} rooms',
  'hub.reports.row.reporters.one': '{count} reporter',
  'hub.reports.row.reporters.other': '{count} reporters',
  'hub.reports.row.waiting': 'Waiting {duration}',
  'hub.reports.row.latest': 'Latest report {time}',
  'hub.reports.row.alsoSeenAs': 'Also seen as {names}',
  'hub.reports.row.review': 'Review',
  'hub.reports.row.reviewLabel': 'Review the newest report against {who}',
  'hub.reports.row.history': 'History',
  'hub.reports.row.historyLabel': 'Open the history of {who}',
  'hub.reports.row.earlier': 'Earlier reports',
  'hub.reports.row.earlierLabel': 'Open report {id}',
  'hub.reports.row.moreEarlier.one': '{count} more earlier report',
  'hub.reports.row.moreEarlier.other': '{count} more earlier reports',
  'hub.reports.row.lessEarlier': 'Show fewer',
  'hub.reports.tag.open': 'Open',
  'hub.reports.tag.actioned': 'Actioned',
  'hub.reports.tag.dismissed': 'Dismissed',
  'hub.reports.shown.one': 'Showing {count} report.',
  'hub.reports.shown.other': 'Showing {count} reports.',
  'hub.reports.moreHint': 'Load more to add older reports to the groups.',
  'hub.reports.loadMore': 'Load more',
  'hub.reports.loadingMore': 'Loading more reports',
  'hub.reports.loadedMore.one': 'Loaded {count} more report.',
  'hub.reports.loadedMore.other': 'Loaded {count} more reports.',

  'hub.sanction.kind.chat': 'Chat restriction',
  'hub.sanction.kind.area': 'Area restriction',
  'hub.sanction.kind.ban': 'Ban',
  'hub.sanction.kind.warning': 'Warning',
  'hub.sanction.kind.note': 'Note',
  'hub.sanction.permanent': 'permanent',
  'hub.sanction.rule': 'Rule {rule}',
  'hub.sanction.ruleNone': 'No rule',
  'hub.sanction.ruleUncovered': 'No rule fits yet',
  'hub.sanction.by': 'by {actor}',
  'hub.sanction.automatic': 'automatic',
  'hub.sanction.status.active': 'Active',
  'hub.sanction.status.ended': 'Ended',
  'hub.sanction.status.revoked': 'Revoked',
  'hub.sanction.status.pending': 'Not enforced yet',

  'hub.source.moderator': 'Moderator',
  'hub.source.auto_filter': 'Automatic filter',
  'hub.source.coop': 'Co-op',
  'hub.source.api': 'API',
  'hub.source.ai': 'AI',

  'hub.category.harassment': 'Harassment',
  'hub.category.hate': 'Hate',
  'hub.category.cheating': 'Cheating',
  'hub.category.spam': 'Spam',
  'hub.category.disruption': 'Disruption',
  // Not `.other`: that is the plural form's name.
  'hub.category.misc': 'Other',

  'hub.person.prefix': 'Person',
} as const;

/** A catalog: keys to English (or translated) text. Any object of strings will do. */
export type HubCatalog = Readonly<Record<string, string>>;

type PluralForm = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';
type BaseKey<K extends string> = K extends `${infer B}.${PluralForm}` ? B : K;

/** Every key a component may ask for: the English catalog's keys with the plural suffix taken off. */
export type HubText = BaseKey<keyof typeof en>;

export type HubParams = Readonly<Record<string, string | number>>;

/** The `t` the hub takes: a key and optional values, always a string back. */
export type HubT = (key: HubText, params?: HubParams) => string;

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Builds the `t` function for a catalog and a locale.
 * - `{name}` is replaced by `params.name`; a name with no value stays as written; a value is never expanded again.
 * - Numbers are formatted for the locale (`1,234`).
 * - With a numeric `count`, the plural form for the locale is used (`key.one`, `key.other`, ...), `key.zero` for 0 if it
 *   exists, and `key.other` when the locale's form is missing.
 * - A key with no text comes back as the key itself, so a gap in a translation is visible instead of blank.
 */
export function createT(catalog: HubCatalog, locale = 'en'): HubT {
  let numbers: Intl.NumberFormat;
  let plurals: Intl.PluralRules;
  try {
    numbers = new Intl.NumberFormat(locale);
    plurals = new Intl.PluralRules(locale);
  } catch {
    numbers = new Intl.NumberFormat('en');
    plurals = new Intl.PluralRules('en');
  }
  const has = (key: string): boolean => Object.hasOwn(catalog, key);

  return (key, params) => {
    let template: string | undefined;
    const count = params?.count;
    if (isCount(count)) {
      const form = count === 0 && has(`${key}.zero`) ? 'zero' : plurals.select(count);
      for (const candidate of [`${key}.${form}`, `${key}.other`]) {
        if (has(candidate)) {
          template = catalog[candidate];
          break;
        }
      }
    }
    template ??= has(key) ? catalog[key] : undefined;
    if (template === undefined) return key;
    if (params === undefined) return template;
    return template.replace(/\{([a-zA-Z]+)\}/g, (whole, name: string) => {
      if (!Object.hasOwn(params, name)) return whole;
      const value = params[name];
      return typeof value === 'number' ? numbers.format(value) : String(value);
    });
  };
}

// Literal data for the chat filters. Nothing here is computed and nothing is read from a setting: a list is code, so an owner adds to it
// through `allow` and `deny` and never edits it. Every list says why an entry that looks like it belongs is left out.

/**
 * Top-level domains that make a bare `name.tld` a link without a scheme or `www.`: the ones players actually post, plus the free and
 * cheap ones that adverts and scams favour. LEFT OUT on purpose (each is a file extension or an ordinary word, so a sentence with a
 * missing space after the full stop or a file name would be read as a link): `zip mov sh py pl rs md ps cc so` (file extensions;
 * `cc` and `so` are on the weak list), and the English words `one now new day love life work fun win cool wtf lol game gold cash
 * live news today world space zone money name chat media design host social network digital agency studio`. A country code that is also an English word of two letters sits on the weak list.
 */
export const STRONG_TLDS: ReadonlySet<string> = new Set(
  (
    'com net org io gg tv xyz info biz app dev co ly gl ru cn uk de fr br es pt gov edu mil int ai ws tk ml ga cf gq fm nu la cx pw im ' +
    'eu nl ch se dk fi cz sk hu ro bg gr tr il ir ua kz jp kr tw hk sg id th vn ph au nz za ng ke eg mx ar cl pe ve ca ' +
    'top site online store shop club link click icu vip cyou cfd sbs bet casino games tech cloud website pro mobi asia ' +
    'ninja rocks wiki xxx adult porn tube'
  ).split(' '),
);

/**
 * Two-letter endings that are also English words (`this.is`, `check.in`, `ok.so`, `go.to`, `me.my`): a bare `name.tld` ending in one
 * is a link only when a path follows (`t.me/abc`). `cc` and `so` are here because they are file extensions as well.
 */
export const WEAK_TLDS: ReadonlySet<string> = new Set('me us in is it to at be so no my do hi as by am cc'.split(' '));

/**
 * A link to an invitation: the host, and the path prefix it needs (null: any path, or none). A path prefix matches whole path
 * segments (`/invite` matches `/invite` and `/invite/x`, not `/invitee`), except a prefix that ends in `+` which matches what follows.
 */
export const INVITE_PACK: ReadonlyArray<readonly [host: string, pathPrefix: string | null]> = [
  ['discord.gg', null],
  ['dsc.gg', null],
  ['discord.com', '/invite'],
  ['discordapp.com', '/invite'],
  ['t.me', '/+'],
  ['t.me', '/joinchat'],
  ['chat.whatsapp.com', null],
  ['signal.group', null],
];

/** The built-in URL shorteners. A subdomain of one counts (`www.bit.ly`). Left out: a general site that also has a short form. */
export const SHORTENER_PACK: readonly string[] = [
  'bit.ly',
  't.co',
  'tinyurl.com',
  'goo.gl',
  'is.gd',
  'cutt.ly',
  'rb.gy',
  'ow.ly',
  'buff.ly',
  'shorturl.at',
  'tiny.cc',
  'v.gd',
  'lnkd.in',
  'rebrand.ly',
  't.ly',
  'short.io',
];

/**
 * Hosts where anyone may publish a page under a sub-domain. Allowing the suffix itself would allow every user's page, so an `allow`
 * entry that is one of these is refused unless it is written exactly (`=name.github.io`). Left out: a host whose users cannot pick
 * their own sub-domain.
 */
export const SHARED_HOSTING_SUFFIXES: readonly string[] = [
  'github.io',
  'gitlab.io',
  'vercel.app',
  'netlify.app',
  'pages.dev',
  'workers.dev',
  'blogspot.com',
  'herokuapp.com',
  'web.app',
  'firebaseapp.com',
  'glitch.me',
  'onrender.com',
  'trycloudflare.com',
  'ngrok.io',
];

/** The words that start a "find me on" line (a lead word of the contact detector). Left out: `ig` and `dm`, which are everyday words. */
export const CONTACT_LEADS: ReadonlySet<string> = new Set(
  'insta instagram snap snapchat discord whatsapp telegram kik tiktok skype signal'.split(' '),
);

/** The street words of the address heuristic. */
export const STREET_WORDS: ReadonlySet<string> = new Set(
  'street st avenue ave road rd boulevard blvd lane ln drive dr court ct'.split(' '),
);

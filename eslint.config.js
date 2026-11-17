import js from '@eslint/js';
import { builtinModules } from 'node:module';
import tseslint from 'typescript-eslint';

// @chatwarden/core, @chatwarden/matcher, @chatwarden/store-memory, @chatwarden/hub-react, @chatwarden/player-react and @chatwarden/hub-element must stay portable (they run in a browser): their src
// may import nothing from a node: module or any Node builtin, not even node:crypto (see core's src/crypto.ts for the
// process.getBuiltinModule route). Applies to src only; tests may use node:crypto as the reference implementation.
const builtins = builtinModules.filter((name) => !name.startsWith('_') && !name.startsWith('node:') && !name.includes('/'));
const BROWSER_SAFE_MESSAGE = 'this package must run in a browser: src may import no Node builtin (core: use src/crypto.ts).';
const browserSafeImports = [
  'error',
  {
    paths: builtins.map((name) => ({ name, message: BROWSER_SAFE_MESSAGE })),
    patterns: [
      { group: ['node:*'], message: BROWSER_SAFE_MESSAGE },
      { group: builtins.map((name) => `${name}/*`), message: BROWSER_SAFE_MESSAGE },
    ],
  },
];
// no-restricted-imports does not see a dynamic import(); a selector does. (An esquery regex ends at the next "/", so a
// subpath slash is written \x2f.)
const browserSafeSyntax = [
  'error',
  { selector: 'ImportExpression[source.value=/^node:/]', message: BROWSER_SAFE_MESSAGE },
  { selector: `ImportExpression[source.value=/^(${builtins.join('|')})(\\x2f.*)?$/]`, message: BROWSER_SAFE_MESSAGE },
];

// The AI folder may import its OWN files and a short list of read-only modules of core/src, and nothing else (an allowlist, review R1a I2: a denylist of
// the writing modules left the barrel `index` and the kit `chatwarden`, which re-export every writer, wide open). A new import the AI module needs is
// added here in view. Everything is one selector per import form (a static import, a re-export, a dynamic import, an `import type(...)`, `import = require`),
// because no-restricted-imports does not see the dynamic ones; a dynamic import whose argument is not a plain string is refused outright.
const AI_ALLOWED_MODULES = ['types', 'profile', 'ladder', 'rules', 'reporting', 'documents', 'crypto', 'log', 'events', 'audit'];
const AI_MESSAGE =
  'the AI never writes: packages/core/src/ai may import only its own files and the read-only modules of core/src named in eslint.config.js (never the barrel, the kit, decide, sanctions, strikes, mutes, notices or the actor).';
// A specifier that is NOT an allowed one: a negative lookahead, so one regex per node form. (An esquery regex ends at the next "/", so a slash is \x2f.)
const aiNotAllowed = `/^(?!(?:\\.\\x2f[\\w-]+(?:\\.js)?|(?:\\.\\.\\x2f)+(?:${AI_ALLOWED_MODULES.join('|')})(?:\\.js)?)$)/`;
const aiImportSyntax = [
  `ImportDeclaration[source.value=${aiNotAllowed}]`,
  `ExportAllDeclaration[source.value=${aiNotAllowed}]`,
  `ExportNamedDeclaration[source.value=${aiNotAllowed}]`,
  `ImportExpression[source.value=${aiNotAllowed}]`,
  "ImportExpression:not([source.type='Literal'])",
  `TSImportType Literal[value=${aiNotAllowed}]`,
  `TSExternalModuleReference > Literal[value=${aiNotAllowed}]`,
  "CallExpression[callee.name='require']",
].map((selector) => ({ selector, message: AI_MESSAGE }));

// The Store's writers. The import ban above does not stop `this.store.insertSanctionGroup(...)` on the Store type the AI module is handed, so a second
// selector names the writers themselves. Only packages/core/src/aiActor (design 6.1) may call them for the AI. scripts/eslint-ban.test.ts pins every
// shape of the access: a static call, `this.store.x`, `store['x']`, an optional call, a destructuring and a method passed as a callback.
const AI_STORE_WRITERS = [
  'insertSanctionGroup',
  'revokeSanctionGroup',
  'closeReport',
  'insertDecision',
  'insertNotice',
  'withdrawNotice',
  'withdrawNoticeGroup',
  'insertStrike',
  'upsertMute',
  'deleteMute',
  'pruneMutes',
  'closeGap',
  'decideAppeal',
  'savePolicyLayer',
  'claimCase',
  'releaseClaim',
  'ackNotice',
  'insertAppeal',
  'closeAppealsForGroup',
  'closeOrphanAppeals',
  'insertReport',
  'addReportDetail',
  'purgeReports',
  'purgeSanctions',
  'purgeNotices',
  'purgeMutes',
  'purgeStrikes',
];
export const AI_SEAM_MESSAGE =
  "the AI never writes: packages/core/src/ai may not use the store's writers (sanctions, decisions, notices, strikes, mutes, closing a report); a sanction by the AI is written only in packages/core/src/aiActor.";
const aiWriterNames = `/^(${AI_STORE_WRITERS.join('|')})$/`;
// A writer reached without naming it: a variable key on a store-like value (`store[k]`, `this.store?.[k]`), Reflect, Object.* over the store, a spread of it.
// "Store-like" is a name ending in Store/store; the type (`AiStore`, which has no writer) is the real guard, this is the second one.
const aiStoreName = '/^\\w*[sS]tore$/';
const aiStoreLike = (path) => `[${path}.name=${aiStoreName}], [${path}.property.name=${aiStoreName}]`;
const aiDynamicSyntax = [
  `MemberExpression[computed=true]:matches(${aiStoreLike('object')}):not([property.type='Literal']):not([property.type='TemplateLiteral'][property.expressions.length=0])`,
  // A cast of the store (`store as unknown as Record<..>`, `<T>store`, `store!`, `store satisfies T`) is how it would be reached through a name the rules above do not see.
  `:matches(TSAsExpression, TSTypeAssertion, TSSatisfiesExpression, TSNonNullExpression):matches(${aiStoreLike('expression')})`,
  // A variable key on any cast value (the object of the access is a TSAsExpression, a type assertion or a non-null: `(x as Record<..>)[k]`).
  `MemberExpression[computed=true]:matches([object.type='TSAsExpression'], [object.type='TSTypeAssertion'], [object.type='TSSatisfiesExpression'], [object.type='TSNonNullExpression']):not([property.type='Literal']):not([property.type='TemplateLiteral'][property.expressions.length=0])`,
  // An alias of the store under a name that does not end in "store" (`const s = this.store; s[k]`, `s = store`): the name is what the rules above look for.
  `VariableDeclarator:not([id.name=${aiStoreName}]):matches(${aiStoreLike('init')})`,
  `AssignmentExpression:not([left.name=${aiStoreName}]):not([left.property.name=${aiStoreName}]):matches(${aiStoreLike('right')})`,
  `ObjectPattern > Property[computed=false][key.name=${aiStoreName}]:not([value.name=${aiStoreName}])`,
  "Identifier[name='Reflect']",
  `CallExpression[callee.object.name='Object'][callee.property.name=/^(values|entries|assign|getOwnPropertyDescriptors?|getOwnPropertyNames|fromEntries)$/]:matches(${aiStoreLike('arguments.0')}, ${aiStoreLike('arguments.1')})`,
  `SpreadElement:matches(${aiStoreLike('argument')})`,
].map((selector) => ({ selector, message: AI_SEAM_MESSAGE }));
const aiSeamSyntax = [
  ...aiDynamicSyntax,
  { selector: `MemberExpression[computed=false][property.name=${aiWriterNames}]`, message: AI_SEAM_MESSAGE },
  { selector: `MemberExpression[computed=true][property.value=${aiWriterNames}]`, message: AI_SEAM_MESSAGE },
  { selector: `MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked=${aiWriterNames}]`, message: AI_SEAM_MESSAGE },
  { selector: `ObjectPattern > Property[computed=false][key.name=${aiWriterNames}]`, message: AI_SEAM_MESSAGE },
  { selector: `ObjectPattern > Property[key.value=${aiWriterNames}]`, message: AI_SEAM_MESSAGE },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.superpowers/**', '**/*.tsbuildinfo', '.smoke/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['scripts/**/*.mjs', 'site/scripts/**/*.mjs', 'packages/hub-element/build/**/*.mjs', 'examples/*/web/*.mjs', 'services/*/tools/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly' },
    },
  },
  {
    // Plain browser scripts that ship as-is from the site's public/ folder.
    files: ['site/public/**/*.js'],
    languageOptions: { globals: { localStorage: 'readonly', document: 'readonly' } },
  },
  {
    // The corpus service's review page: one plain browser script, served by the Worker after Access has said yes.
    files: ['services/*/page/**/*.js'],
    languageOptions: { globals: { document: 'readonly', fetch: 'readonly' } },
  },
  {
    // The recipe goldens are what `chatwarden init` writes for an adopter's Node project: JavaScript there uses Node's and the Web's globals.
    files: ['examples/recipes/cases/**/*.{js,mjs}'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', Request: 'readonly', Response: 'readonly', Headers: 'readonly', TextDecoder: 'readonly' },
    },
  },
  {
    files: [
      'packages/core/src/**/*.ts',
      'packages/store-memory/src/**/*.ts',
      'packages/matcher/src/**/*.ts',
      'packages/hub-react/src/**/*.{ts,tsx}',
      'packages/player-react/src/**/*.{ts,tsx}',
      'packages/hub-element/src/**/*.{ts,tsx}',
    ],
    rules: { 'no-restricted-imports': browserSafeImports, 'no-restricted-syntax': browserSafeSyntax },
  },
  {
    // The one folder under a browser-safe package's src that may import `node:`: the server-only half of the shared term list (a disk cache,
    // the installation key, the starter). It is named exactly, so `corpus/` beside it, the rest of the matcher and every other package keep the
    // ban; scripts/eslint-ban.test.ts pins both sides, including look-alike folder names.
    files: ['packages/matcher/src/corpus/node/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    // The AI never writes a sanction, a strike, a mute or a notice: core/src/ai may import only an allowlist of read-only modules (see AI_ALLOWED_MODULES). A flat-config rule
    // replaces the one above for these files, so the browser-safe ban is repeated here and the AI's is added to it. scripts/eslint-ban.test.ts
    // proves it fires (type-only imports, re-exports and dynamic imports included).
    files: ['packages/core/src/ai/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: browserSafeImports[1].paths, patterns: browserSafeImports[1].patterns }],
      'no-restricted-syntax': [
        'error',
        ...browserSafeSyntax.slice(1),
        ...aiImportSyntax,
        ...aiSeamSyntax,
      ],
    },
  },
);

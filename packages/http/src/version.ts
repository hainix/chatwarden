// The one place this package's version is written down (scripts/sync-version.mjs keeps it equal to package.json). The CLI imports it from here, not from
// the package root, so the bin does not load @chatwarden/core at start-up; the root re-exports it.
export const VERSION = '0.2.2';

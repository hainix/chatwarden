// `@chatwarden/http/coop`: the Coop adapter (K5). Not exported from the package root: it uses `node:crypto`. Nothing here runs at import; `coop` is a function the
// adopter calls.
export type { CoopDecision, CoopOptions } from './options.js';

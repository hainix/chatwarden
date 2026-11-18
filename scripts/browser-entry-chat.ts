// Entry for the chat box's server side in scripts/browser-bundle.test.ts: everything `browser-entry.ts` has, plus `@chatwarden/http/chat`. It is
// bundled to prove the chat broadcaster and routes stay free of Node imports and run in a bare browser context; it is NOT what the size budget
// measures (a page does not ship the chat server by default). Never shipped, never run by Node directly.
export * from './browser-entry.js';
export * as httpChat from '@chatwarden/http/chat';
// The service API (`/v1`) is browser-safe too: bundled here to prove it has no Node import and runs in a bare context.
export * as httpService from '@chatwarden/http/service';

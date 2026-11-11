import { defineChatwardenHub } from './index.js';

// The self-registering entry: one script tag and `<chatwarden-hub>` works. Importing it a second time (or a second copy of the
// script) finds the tag taken and leaves it alone.
export * from './index.js';

defineChatwardenHub();

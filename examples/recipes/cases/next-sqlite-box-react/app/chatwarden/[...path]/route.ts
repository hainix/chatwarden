// The Next.js route handler: every request under the prefix goes to the Chatwarden handler.
// Written by `chatwarden init` (K4b). It is yours now: edit freely. Re-running never overwrites a file you changed.

import { handler } from '../../../chatwarden/handler';

// The kit keeps a database file and open chat streams, so this runs on Node and is never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const HEAD = handler;

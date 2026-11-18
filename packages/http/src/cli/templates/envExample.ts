// `.env.example`: the names of the environment variables the generated code reads, with what each is for. Placeholders only: no line has
// a value after the `=`, so there is nothing here to leak and nothing to mistake for a real key.
import { SECRET_COMMAND, envNames } from '../plan.js';
import type { FileSpec } from '../types.js';
import type { Ctx } from './frag.js';
import { headerHash } from './header.js';

const WHAT: Record<string, string[]> = {
  CHATWARDEN_SECRET: [
    'Keys the hashes of client keys and addresses: at least 32 characters, and keep it stable (changing it unlinks every stored hash).',
    `Make one with: ${SECRET_COMMAND}`,
  ],
  CHATWARDEN_ADMIN_TOKEN: [
    'Signs staff in to the hub and the staff routes: at least 24 characters. Without it every staff route answers 401.',
    'This is a starter for one or two moderators; replace it with your own sign-in before a team uses it.',
    'The sign-in cookie is Secure, so over plain http (local development only) a browser may drop it: set CHATWARDEN_INSECURE_STAFF_COOKIE=1 in your environment to send it without Secure.',
  ],
  CHATWARDEN_DB: ['Where the moderation database file lives. When empty it is ./chatwarden.db.'],
  DISCORD_WEBHOOK_URL: ['The forum channel webhook that new reports and outcomes are posted to. When empty the Discord feed is off.'],
  DISCORD_MENTION_ROLE_ID: ['A Discord role to ping on a severe report or sanction. Optional.'],
  CHATWARDEN_PUBLIC_URL: ['The public address of this server, for the links in Discord posts. When empty it is http://localhost:3000.'],
  CHATWARDEN_TRUST_PROXY: [
    'Set to 1 only behind your own reverse proxy: the first X-Forwarded-For entry is then taken as the player address.',
    'Left empty, the address comes from the connection and a client cannot choose it.',
  ],
};

export function envExampleFiles(ctx: Ctx): FileSpec[] {
  const { answers } = ctx;
  const blocks = envNames(answers).map(({ name }) => `${(WHAT[name] ?? []).map((line) => `# ${line}`).join('\n')}\n${name}=\n`);
  const content = `${headerHash('Environment variables for Chatwarden. Copy to .env, or set these in your host.')}${blocks.join('\n')}`;
  return [{ path: `${answers.dir}/.env.example`, content }];
}

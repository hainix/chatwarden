// `init --service` (design 3.5): the Docker recipe of the service API, as a self-contained folder: a Dockerfile, a compose file, the environment example, the profile file, a short README and
// a .dockerignore. A recipe, not an image: nothing is built or pushed here, and no secret is written (the three variables are read from the environment when it runs). The same templates write
// examples/service/ in the repository, and a test fails when the two differ.
import type { FileSpec, ProfileChoice, Store, Versions } from '../types.js';

/** What the service folder depends on: where the data lives, which standard, and the folder. */
export interface ServiceFileAnswers {
  store: Store;
  profile: ProfileChoice;
  dir: string;
}

const WRITTEN = 'Written by `chatwarden init --service`. It is yours now: edit freely. Re-running never overwrites a file you changed.';
const hash = (what: string): string => `# ${what}\n# ${WRITTEN}\n\n`;

const PACKAGES = ['core', 'http', 'store-sqlite', 'matcher', 'profanity', 'hub-element'] as const;

function dockerfile(answers: ServiceFileAnswers, versions: Versions): string {
  const sqlite = answers.store === 'sqlite';
  const install = PACKAGES.map((name) => `    @chatwarden/${name}@\${CHATWARDEN_VERSION}`).join(' \\\n');
  const storeLines = sqlite
    ? 'RUN mkdir -p /data && chown node:node /data\nENV CHATWARDEN_DB=/data/chatwarden.db CHATWARDEN_HOST=0.0.0.0 CHATWARDEN_PROFILE_FILE=/app/profile.json\n'
    : '# The memory store keeps everything in memory: players, sanctions, reports and notices are all lost on restart. For tests and demos.\nENV CHATWARDEN_DB=:memory: CHATWARDEN_HOST=0.0.0.0 CHATWARDEN_PROFILE_FILE=/app/profile.json\n';
  return `${hash('The Chatwarden service API as a container. A recipe, not an image: build it yourself. No secret goes in the image; the keys come from the environment when it runs.')}FROM node:22-slim
ARG CHATWARDEN_VERSION=${versions.chatwarden}
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund \\
${install}
COPY profile.json /app/profile.json
${storeLines}USER node
${sqlite ? 'VOLUME /data\n' : ''}EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8787/readyz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "node_modules/.bin/chatwarden", "serve"]
`;
}

function compose(answers: ServiceFileAnswers): string {
  const sqlite = answers.store === 'sqlite';
  return `${hash('Runs the service with Docker Compose. It binds 8787 to 127.0.0.1 only: put a TLS proxy or a private network in front before you expose it. A service key is a database password.')}services:
  chatwarden:
    build:
      context: .
    ports:
      - "127.0.0.1:8787:8787"
    environment:
      CHATWARDEN_SECRET: \${CHATWARDEN_SECRET:?set CHATWARDEN_SECRET in .env}
      CHATWARDEN_SERVICE_KEYS: \${CHATWARDEN_SERVICE_KEYS:?set CHATWARDEN_SERVICE_KEYS in .env}
      CHATWARDEN_ADMIN_TOKEN: \${CHATWARDEN_ADMIN_TOKEN:-}
${sqlite ? '    volumes:\n      - chatwarden-data:/data\n' : ''}    restart: unless-stopped
${sqlite ? '\nvolumes:\n  chatwarden-data:\n' : ''}`;
}

function envExample(): string {
  return `${hash('The three variables the service reads. Copy this file to .env (Docker Compose reads it) and fill them in. Never commit .env.')}# Keys the hashes of client keys and addresses: 32 or more characters. Keep it stable: changing it makes every returning player a new person.
# Make one with: openssl rand -base64 32
CHATWARDEN_SECRET=

# The service keys your game servers send as "Authorization: Bearer <key>": one to five, each 32 or more characters, comma separated. Use two while you rotate.
# Make one with: openssl rand -base64 32
CHATWARDEN_SERVICE_KEYS=

# The staff sign-in for the moderator hub: 24 or more characters, and not the same as a service key. Leave it empty to switch the staff side off.
# Make one with: openssl rand -base64 32
CHATWARDEN_ADMIN_TOKEN=
`;
}

function dockerignore(): string {
  return `${hash('What the image build leaves out.')}.env
.env.*
*.db
node_modules
Dockerfile
compose.yaml
README.txt
`;
}

function readme(answers: ServiceFileAnswers): string {
  return `The Chatwarden service
======================
1. Copy .env.example to .env and fill in the three variables (a value: openssl rand -base64 32).
2. Build and run it: docker compose up --build
3. Ask it something: curl -H "Authorization: Bearer YOUR_SERVICE_KEY" http://127.0.0.1:8787/v1
4. The moderator hub is at http://127.0.0.1:8787/mod, with CHATWARDEN_ADMIN_TOKEN as the sign-in. The sign-in cookie is Secure (Chrome and Firefox accept it on 127.0.0.1; for a browser that does not, add CHATWARDEN_INSECURE_STAFF_COOKIE=1 under environment in compose.yaml, for local use only).
5. profile.json is the standard it runs by; edit it and rebuild. Room contexts and reserved names go in it.
6. The word list is a placeholder: the service says so (synthetic_terms in the GET /v1 answer) until you give it a terms file.
7. ${answers.store === 'sqlite' ? 'Moderation data lives in the chatwarden-data volume.' : 'The memory store keeps nothing: everything is lost on restart.'}
8. Put a TLS proxy or a private network in front before you expose port 8787. A service key is a database password.
9. Rotate a key by adding the new one beside the old, deploying it to your game servers, then removing the old one.
10. The API is described by: chatwarden serve --print-openapi
11. The image is built here, from your own folder: nothing is pushed anywhere.
12. ${WRITTEN}
`;
}

function profileFile(answers: ServiceFileAnswers): string {
  return `${JSON.stringify({ preset: answers.profile, contexts: {}, names: { reserved: [] } }, null, 2)}\n`;
}

/** The six files of the service folder for these answers. Paths are under `answers.dir`. */
export function serviceFiles(answers: ServiceFileAnswers, versions: Versions): FileSpec[] {
  const at = (name: string): string => `${answers.dir}/${name}`;
  return [
    { path: at('.dockerignore'), content: dockerignore() },
    { path: at('.env.example'), content: envExample() },
    { path: at('Dockerfile'), content: dockerfile(answers, versions) },
    { path: at('README.txt'), content: readme(answers) },
    { path: at('compose.yaml'), content: compose(answers) },
    { path: at('profile.json'), content: profileFile(answers) },
  ];
}

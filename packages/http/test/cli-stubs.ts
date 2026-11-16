import { VERSION } from '../src/index.js';
import type { Answers, FileSpec, Project, Versions } from '../src/cli/types.js';

// Stand-ins for the shared templates (Task 3), so the plan, apply and report tests do not depend on them. They depend on the answers the
// way real templates do: a file appears with an answer, a file's text carries the answers that change it, and the order is not sorted.

export const VERSIONS: Versions = { chatwarden: VERSION };
export const PROJECT: Project = { manager: 'npm', react: false };

export function answersOf(over: Partial<Answers> = {}): Answers {
  return {
    framework: 'express',
    store: 'sqlite',
    chat: 'none',
    chatTransport: 'sse',
    hub: 'element',
    discord: false,
    profile: 'standard',
    base: '/chatwarden',
    dir: 'src/chatwarden',
    lang: 'ts',
    ...over,
  };
}

export function stubTemplates(answers: Answers, versions: Versions): FileSpec[] {
  const dir = answers.dir;
  const files: FileSpec[] = [
    { path: `${dir}/kit.ts`, content: `import { createChatwarden } from '@chatwarden/core';\nexport const BASE = '${answers.base}';\nexport const PROFILE = '${answers.profile}'; // ${versions.chatwarden}\nexport const STORE = '${answers.store}';\nexport const CHAT = '${answers.chat}';\n` },
    { path: `${dir}/auth.ts`, content: `import { timingSafeEqual } from './crypto.js';\n// TODO(auth): replace the starter sign-in.\nexport function authorize() {\n  return null;\n}\n// TODO(identity): your account id goes here.\nexport function identify() {\n  return {};\n}\n`, markers: ['TODO(auth)', 'TODO(identity)'] },
    { path: `${dir}/terms.ts`, content: `// TODO(terms): TEST WORDS ONLY.\nexport const WORDS = ['zorbak', 'vlemmo'];\n`, markers: ['TODO(terms)'] },
    { path: `${dir}/.env.example`, content: 'CHATWARDEN_SECRET=\nCHATWARDEN_ADMIN_TOKEN=\n' },
  ];
  if (answers.chat === 'box') files.unshift({ path: `${dir}/ChatPanel.tsx`, content: `export const PANEL = '${answers.chatTransport}';\n` });
  if (answers.framework === 'next') files.unshift({ path: 'app/chatwarden/[...path]/route.ts', content: `export const runtime = 'nodejs';\n` });
  return files;
}

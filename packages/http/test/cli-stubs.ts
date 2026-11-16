import ts from 'typescript';
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

const FRAMEWORKS = ['express', 'fastify', 'next', 'fetch', 'none'] as const;

/** Every combination the answers rules allow (design 5.1), for one language. */
export function legalAnswers(lang: 'ts' | 'js'): Answers[] {
  const out: Answers[] = [];
  for (const framework of FRAMEWORKS)
    for (const store of ['sqlite', 'memory'] as const)
      for (const chat of ['none', 'box'] as const)
        for (const chatTransport of ['sse', 'socketio'] as const)
          for (const hub of ['element', 'react', 'none'] as const)
            for (const discord of [false, true])
              for (const profile of ['relaxed', 'standard', 'strict'] as const) {
                if (framework === 'none' && (chat === 'box' || hub !== 'none' || chatTransport === 'socketio')) continue;
                if (framework === 'next' && hub === 'element') continue;
                if (chatTransport === 'socketio' && chat !== 'box') continue;
                out.push(answersOf({ framework, store, chat, chatTransport, hub, discord, profile, lang }));
              }
  return out;
}

export const TS_OPTIONS: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve };
export const JS_OPTIONS: ts.CompilerOptions = { ...TS_OPTIONS, allowJs: true };

/** The syntax diagnostics TypeScript reports for one file's text (a .js file is read as JavaScript, so a type annotation is one). */
export function syntaxProblems(file: FileSpec, options: ts.CompilerOptions): string[] {
  const out = ts.transpileModule(file.content, { fileName: file.path, reportDiagnostics: true, compilerOptions: options });
  return (out.diagnostics ?? []).map((d) => `${file.path}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
}

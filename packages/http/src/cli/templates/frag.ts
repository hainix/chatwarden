// The template engine: a template is a function of a `Ctx` that returns text built from template literals. Everything that exists only in
// TypeScript (an annotation, a type import, a cast, a generic, an interface) is written through `t` or `impType`, which vanish in the JavaScript
// rendering, so that rendering is mechanical: there is no pass that strips types afterwards.
import type { Answers, AppLayout, Lang, Versions } from '../types.js';

export interface Ctx {
  answers: Answers;
  lang: Lang;
  /** The suffix of a relative import: `.js` for TypeScript (NodeNext) and for ESM JavaScript, `.mjs` for JavaScript in a CommonJS package, `''` for none (Next.js). */
  ext: string;
  /** The extension of a module file: `.ts`, `.js` or `.mjs`. */
  scriptExt: string;
  /** The extension of a file with JSX: `.tsx` or `.jsx`. */
  jsxExt: string;
  versions: Versions;
  /** What the root listing says about the app directory (Next.js only reads it). */
  layout: AppLayout;
}

export interface CtxOptions {
  /** `"type"` of the project's package.json. JavaScript in a CommonJS project is written as `.mjs`. Default `module`. */
  moduleType?: 'module' | 'commonjs';
  /** `src` and `app` entries of the project root, for where a Next.js route goes. */
  layout?: AppLayout;
}

export function makeCtx(answers: Answers, versions: Versions, options: CtxOptions = {}): Ctx {
  // A Next.js project resolves imports with its bundler: no suffix on a relative import, and its JavaScript is .js whatever the package's type.
  const next = answers.framework === 'next';
  const layout = options.layout ?? {};
  if (answers.lang === 'ts') return { answers, lang: 'ts', ext: next ? '' : '.js', scriptExt: '.ts', jsxExt: '.tsx', versions, layout };
  const mjs = options.moduleType === 'commonjs' && !next;
  return { answers, lang: 'js', ext: next ? '' : mjs ? '.mjs' : '.js', scriptExt: mjs ? '.mjs' : '.js', jsxExt: '.jsx', versions, layout };
}

/** The TypeScript-only fragment for `ts`, nothing for `js`. */
export function t(ctx: Ctx, tsFragment: string): string {
  return ctx.lang === 'ts' ? tsFragment : '';
}

/** A relative specifier with the context's import suffix (`./kit` to `./kit.js`). A package specifier, or one that already has a suffix, is left alone. */
export function spec(ctx: Ctx, specifier: string): string {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return specifier;
  if (ctx.ext === '' || /\.[cm]?[jt]sx?$/.test(specifier)) return specifier;
  return `${specifier}${ctx.ext}`;
}

const list = (names: string | readonly string[]): string => (typeof names === 'string' ? names : names.join(', '));

/** A complete import line, with its newline: `import { a, b } from 'x';`. A relative `from` gets the context's suffix. */
export function imp(ctx: Ctx, names: string | readonly string[], from: string): string {
  return `import { ${list(names)} } from '${spec(ctx, from)}';\n`;
}

/** A complete namespace import line: `import * as hooks from './auth.js';`. */
export function impNs(ctx: Ctx, name: string, from: string): string {
  return `import * as ${name} from '${spec(ctx, from)}';\n`;
}

/** A complete type-only import line, or nothing in JavaScript. */
export function impType(ctx: Ctx, names: string | readonly string[], from: string): string {
  return t(ctx, `import type { ${list(names)} } from '${spec(ctx, from)}';\n`);
}

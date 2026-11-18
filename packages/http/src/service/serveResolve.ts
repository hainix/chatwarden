// Where `chatwarden serve` finds the kit's optional packages: the project it runs in (the current directory) first, then where this package itself lives. The packages are optional peers of
// `@chatwarden/http`, so with `npx -p @chatwarden/http chatwarden serve` or a strict pnpm layout they sit in the project, not next to this file. Node only.
import { createRequire, isBuiltin } from 'node:module';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(\/[A-Za-z0-9._-]+)*$/;

/** The path `name` resolves to from the project folder `cwd`, as Node would resolve it from a file there; undefined when it does not (or when `name` is not a package name). Never throws. */
export function resolvePathFromProject(name: string, cwd: string = process.cwd()): string | undefined {
  if (typeof name !== 'string' || name.length > 214 || !PACKAGE_NAME.test(name) || isBuiltin(name)) return undefined;
  try {
    const found = createRequire(join(cwd, 'noop.js')).resolve(name);
    return isAbsolute(found) ? found : undefined;
  } catch {
    return undefined;
  }
}

/** {@link resolvePathFromProject} as a file URL (what `import()` takes for an absolute location). */
export function resolveFromProject(name: string, cwd: string = process.cwd()): string | undefined {
  const found = resolvePathFromProject(name, cwd);
  return found === undefined ? undefined : pathToFileURL(found).href;
}

/** An importer that loads the project's copy of a package when it has one, else the one reachable from this package. A package in neither place is the `import()` rejection. */
export function projectImporter(cwd: string = process.cwd()): (name: string) => Promise<unknown> {
  return (name) => import(/* @vite-ignore */ resolveFromProject(name, cwd) ?? name) as Promise<unknown>;
}

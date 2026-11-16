// The launcher every tool shares. The tools' logic is TypeScript in ../src/tools; this file loads its compiled form from ../dist (build it with
// `npx tsc -b services/corpus` from the repository root), runs `main(argv, io)` and sets the exit code. Nothing else lives in the .mjs files, so
// there is one place that reads the process's arguments, environment and clock (src/tools/io.ts).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function run(name) {
  const file = fileURLToPath(new URL(`../dist/src/tools/${name}.js`, import.meta.url));
  if (!existsSync(file)) {
    process.stderr.write(`The tools are not built yet. From the repository root run:  npx tsc -b services/corpus\n`);
    process.exitCode = 1;
    return;
  }
  const tool = await import(pathToFileURL(file).href);
  const io = await import(pathToFileURL(fileURLToPath(new URL('../dist/src/tools/io.js', import.meta.url))).href);
  process.exitCode = await tool.main(process.argv.slice(2), io.nodeIo());
}

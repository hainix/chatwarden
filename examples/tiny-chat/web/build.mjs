// Builds the chat page into dist/web/: chat.js (the page and the ChatBox, bundled with React) and chat.css (the player stylesheet,
// the chat stylesheet and the page's own rules). Run by `npm start`; the tests call buildWeb() too.
import { build } from 'esbuild';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

export async function buildWeb(outDir = fileURLToPath(new URL('../dist/web/', import.meta.url))) {
  await mkdir(outDir, { recursive: true });
  // Written to a name of its own and renamed into place, so two builds at once (two test files share dist/web) never leave a half-written file.
  const tag = `.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  await build({
    entryPoints: [`${here}chat-page.tsx`],
    outfile: `${outDir}chat.js${tag}`,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'silent',
  });
  const sheets = [
    require.resolve('@chatwarden/player-react/styles.css'),
    require.resolve('@chatwarden/player-react/chat.css'),
    `${here}page.css`,
  ];
  const css = (await Promise.all(sheets.map((file) => readFile(file, 'utf8')))).join('\n');
  await rename(`${outDir}chat.js${tag}`, `${outDir}chat.js`);
  await writeFile(`${outDir}chat.css${tag}`, css);
  await rename(`${outDir}chat.css${tag}`, `${outDir}chat.css`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWeb();
  console.log('tiny-chat: built dist/web/chat.js and chat.css');
}

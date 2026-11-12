// Builds the chat page into dist/web/: chat.js (the page and the ChatBox, bundled with React) and chat.css (the player stylesheet,
// the chat stylesheet and the page's own rules). Run by `npm start`; the tests call buildWeb() too.
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const require = createRequire(import.meta.url);

export async function buildWeb(outDir = fileURLToPath(new URL('../dist/web/', import.meta.url))) {
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [`${here}chat-page.tsx`],
    outfile: `${outDir}chat.js`,
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
  await writeFile(`${outDir}chat.css`, css);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await buildWeb();
  console.log('tiny-chat: built dist/web/chat.js and chat.css');
}

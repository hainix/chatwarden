// Renders the OG image and the PNG icons from SVG, at build time (npm run build runs this first).
//   scripts/og.svg      -> public/og.png (1200x630)
//   public/favicon.svg  -> public/favicon-32.png (32x32) and public/apple-touch-icon.png (180x180)
// resvg-js does the rendering (no browser needed). It cannot read woff2, so the two self-hosted fonts are unpacked to
// TTF with wawoff2 into a temp folder for the render. The outputs are committed, so a plain `vite build` still ships
// them; running this again only rewrites a file whose bytes changed.
import { Resvg } from '@resvg/resvg-js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import wawoff2 from 'wawoff2';

const here = dirname(fileURLToPath(import.meta.url));
const site = join(here, '..');
const fontsDir = join(site, 'src', 'assets', 'fonts');

async function unpackFonts() {
  const dir = mkdtempSync(join(tmpdir(), 'cw-fonts-'));
  const files = [];
  for (const name of ['bungee-latin-400-normal', 'atkinson-hyperlegible-next-latin-wght-normal']) {
    const ttf = await wawoff2.decompress(readFileSync(join(fontsDir, `${name}.woff2`)));
    const out = join(dir, `${name}.ttf`);
    writeFileSync(out, ttf);
    files.push(out);
  }
  return { dir, files };
}

function render(svg, width, fonts) {
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { fontFiles: fonts, loadSystemFonts: false, defaultFontFamily: 'Atkinson Hyperlegible Next' },
  })
    .render()
    .asPng();
}

function write(path, png) {
  if (existsSync(path) && readFileSync(path).equals(png)) return;
  writeFileSync(path, png);
  console.log(`wrote ${path.slice(site.length + 1)} (${png.length} bytes)`);
}

const { dir, files } = await unpackFonts();
try {
  write(join(site, 'public', 'og.png'), render(readFileSync(join(here, 'og.svg'), 'utf8'), 1200, files));

  const glyph = readFileSync(join(site, 'public', 'favicon.svg'), 'utf8');
  // The glyph is 32x36, so it is centred in a 36x36 box to make the icons square.
  const inner = glyph.replace(/<\/?svg[^>]*>/g, '');
  const square = `<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="-2 0 36 36">${inner}</svg>`;
  write(join(site, 'public', 'favicon-32.png'), render(square, 32, files));

  // iOS masks the touch icon itself, so it gets a solid background with the glyph centred.
  const touch = `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 180 180"><rect width="180" height="180" fill="#0a0d1a"/><g transform="translate(30 22.5) scale(3.75)">${inner}</g></svg>`;
  write(join(site, 'public', 'apple-touch-icon.png'), render(touch, 180, files));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

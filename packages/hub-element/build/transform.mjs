// The two things the build does to hub-react on the way in (tests: test/build-transform.test.ts). Both fail loudly when hub-react
// changes shape, rather than quietly shipping a hub that ignores the page's theme or reads the wrong `document`.
import { resolve } from 'node:path';

export const hubCssPath = resolve(import.meta.dirname, '..', '..', 'hub-react', 'src', 'styles.css');
export const shadowDocumentPath = resolve(import.meta.dirname, '..', 'src', 'shadowDocument.ts');

// hub-react declares its --cw-* tokens on `:where(.cw-hub)`, the hub's own root. A custom property declared on an element beats the
// value it inherits, so inside a shadow root those declarations would hide every value the page sets on the element or above it
// (`body { --cw-accent: ... }`). So the defaults keep their values but not their names: `--cw-bg` becomes `--cwd-bg`, declared on
// `:host`, and every read `var(--cw-bg)` becomes `var(--cw-bg, var(--cwd-bg))`: the page's value if there is one anywhere up the
// chain, the default if not. The stylesheet never declares a public `--cw-*` name itself.
const TOKEN_BLOCK = ':where(.cw-hub) {';
const HOST_RULES = ':host {\n  display: block;\n}\n:host([hidden]) {\n  display: none;\n}\n';
const MIN_TOKENS = 20;
const privateName = (name) => `--cwd-${name.slice('--cw-'.length)}`;

/**
 * hub-react's stylesheet for a shadow root: the token defaults moved to `:host` under private names (the block that serves a browser
 * without light-dark() too), every token read made `var(--cw-x, var(--cwd-x))`, and the host made a block that `hidden` hides.
 * Every other rule is hub-react's, untouched.
 * @param {string} css
 * @returns {string}
 */
export function elementCss(css) {
  const start = css.indexOf(TOKEN_BLOCK);
  if (start < 0) throw new Error(`hub-element: hub-react's stylesheet has no token block (${TOKEN_BLOCK}): the tokens cannot be moved to :host`);
  const first = css.slice(start, css.indexOf('}', start));
  const names = new Set([...first.matchAll(/^\s*(--cw-[a-z0-9-]+):/gm)].map((m) => m[1]));
  if (names.size < MIN_TOKENS) throw new Error(`hub-element: hub-react's token block declares ${names.size} tokens (expected at least ${MIN_TOKENS}): its shape changed`);
  const onHost = css
    .replaceAll(TOKEN_BLOCK, ':host {')
    .replace(/:host \{([^}]*)\}/g, (_block, body) => `:host {${body.replace(/^(\s*)(--cw-[a-z0-9-]+):/gm, (_d, space, name) => `${space}${privateName(name)}:`)}}`);
  const read = onHost.replace(/var\((--cw-[a-z0-9-]+)\)/g, (use, name) => (names.has(name) ? `var(${name}, var(${privateName(name)}))` : use));
  return HOST_RULES + read;
}

const HUB_SOURCE = /[\\/]hub-react[\\/](?:src|dist[\\/]src)[\\/].*\.[cm]?[jt]sx?$/;
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
// The page itself: the identifier `document`, not a member (`window.document`, `el.document`) or part of a longer name.
const READS_THE_PAGE = /(?<![\w$.])document\b/;

/**
 * hub-react reads the page: `document.activeElement`, `getElementById`, page-wide key listeners. Inside a shadow root those lie. This
 * gives each hub-react source that reads `document` the element's own (see src/shadowDocument.ts), as an import named `document`
 * that shadows the global. Returns the new code, or null when the file is not hub-react's or never reads the page.
 * @param {string} code
 * @param {string} id the file's path
 * @returns {string | null}
 */
export function injectShadowDocument(code, id) {
  if (!HUB_SOURCE.test(id)) return null;
  if (code.includes('cwDocument as document')) return null;
  if (!READS_THE_PAGE.test(stripComments(code))) return null;
  return `import { cwDocument as document } from ${JSON.stringify(shadowDocumentPath.replaceAll('\\', '/'))};\n${code}`;
}

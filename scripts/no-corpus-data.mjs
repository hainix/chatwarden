// The guard of design 16: the repo holds no real term, no real list and no key. It is an ALLOWLIST, so it needs no real list to enforce it.
// - Every term, phrase and line of a corpus-shaped JSON file (a `chatwarden-corpus-` schema, or a release file by name) must be made of the
//   invented words (and their generated forms) and a short list of ordinary words. Anything else fails.
// - No tracked key file, `.dev.vars`, PKCS#8 header, or archive outside `test/fixtures/` (an archive there is read and held to the same list).
// Messages name the file and the place, never the word: a real one must not land in a CI log. The checks are exported and unit-tested in
// scripts/no-corpus-data.test.ts; the repo run is the first test there.
import { readFile } from 'node:fs/promises';
import { TextDecoder } from 'node:util';
import { join } from 'node:path';

/** The invented words of the test fixtures. */
export const INVENTED = ['zorbak', 'vlemmo', 'quissel', 'drakkuun', 'fenrisk', 'tarvo', 'snerp', 'glarn'];

/** Ordinary words that the synthetic lines may use around an invented one. Add a word here only when a fixture needs it. */
const ORDINARY = new Set(
  (
    'a an the and or but not no yes ok okay lol gg i you he she it we they me him her them my your his its our their is are was were be been am ' +
    'do does did have has had will would can could should that this these those there here what who why how when where just so too very to of in ' +
    'on at for with from by as if then than up down out over about into like play player game fight fair ignore rules say keeps going well nice ' +
    'good bad hey hi please thanks stop again more some all any one two get got go see look come back off away only still even also now never ' +
    'always really right wrong team match round win lose lost won lake hello world line lines word words name text note test says said say ' +
    'what which while because after before'
  ).split(' '),
);

// A generated form: an invented word, up to two letters after it, up to four digits (zorbak1, tarvox, quisselo).
const INVENTED_RE = new RegExp(`^(?:${INVENTED.join('|')})[a-z]{0,2}\\d{0,4}$`);

/** A word with its accents taken off and in lower case, for comparing. */
const fold = (w) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Whether `word` is an invented word of the fixtures or a generated form of one. */
export function isInventedWord(word) {
  return typeof word === 'string' && INVENTED_RE.test(fold(word));
}

const isOrdinary = (w) => w.length < 2 || ORDINARY.has(w);

/** The words of a text that are not allowed: any word with a letter outside the allowlist. `strict` allows invented words only (a term). */
export function badWords(text, strict) {
  const words = String(text).split(/[^\p{L}\p{M}\p{N}]+/u).filter((w) => w !== '');
  return words.filter((w) => !isInventedWord(w) && (strict || !isOrdinary(fold(w))));
}

const LINE_KEYS = new Set(['positive', 'negative', 'negativeCorpus', 'knownLosses']);
const TEXT_KEYS = new Set(['phrase', 'text', 'note']);
const MAX_DEPTH = 40;
const MAX_PROBLEMS_PER_FILE = 20;

/** Walks a parsed JSON value and collects the places (a path, never a word) that hold a word that is not allowed. */
function walk(value, key, path, out, depth) {
  if (out.length >= MAX_PROBLEMS_PER_FILE) return;
  if (depth > MAX_DEPTH) {
    out.push(`${path}: nested too deep to read`);
    return;
  }
  if (typeof value === 'string') {
    if (key === 'term' && badWords(value, true).length > 0) out.push(`${path}: a term that is not an invented word`);
    else if ((TEXT_KEYS.has(key) || LINE_KEYS.has(key)) && badWords(value, false).length > 0) out.push(`${path}: a word that is not on the allowlist`);
    return;
  }
  if (Array.isArray(value)) {
    // A list under a line key holds lines (strings) or objects; any other list holds objects (whose own keys decide) or plain values.
    value.forEach((v, i) => walk(v, LINE_KEYS.has(key) ? key : undefined, `${path}[${i}]`, out, depth + 1));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) walk(v, k, `${path}.${k}`, out, depth + 1);
  }
}

/** The release files by name: read for words even when they carry no `schema` key. */
const RELEASE_NAME = /(^|\/)(terms|exceptions|negative\.[a-z]{2,3}|cases\.[a-z]{2,3})\.json$/;

/** Problems in one JSON file (empty array = good, or not a corpus file). `name` is the path shown in a message. */
export function jsonProblems(name, text) {
  let json;
  const byName = RELEASE_NAME.test(name);
  try {
    json = JSON.parse(text);
  } catch {
    // A file that is a corpus file by name and cannot be read cannot be shown clean. Any other JSON that does not parse is not ours to judge.
    return byName ? [`${name}: a corpus file that cannot be read`] : [];
  }
  const schema = json !== null && typeof json === 'object' && !Array.isArray(json) ? json.schema : undefined;
  const corpus = byName || (typeof schema === 'string' && schema.startsWith('chatwarden-corpus-'));
  if (!corpus) return [];
  const where = [];
  walk(json, undefined, '$', where, 0);
  return where.map((w) => `${name}: ${w}`);
}

const KEY_FILE = /\.(pem|key)$/i;
const DEV_VARS = /(^|\/)\.dev\.vars$/;
const ARCHIVE = /\.(zip|7z|tar|tgz)$|\.tar\.gz$/i;
const FIXTURES = /(^|\/)test\/fixtures\//;
const ZIP = /\.zip$/i;
/** Any PEM private key header (PKCS#8, encrypted, RSA, EC, OPENSSH and so on). The tarball check in check-pack.mjs uses this same pattern. */
export const PRIVATE_KEY_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|eot|pdf|gz|zip|7z|tar|tgz|wasm|mp4|mov)$/i;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;

/**
 * The problems with a set of tracked files (empty array = good).
 * @param {{ root: string, files: string[], unzip?: (bytes: Uint8Array) => Promise<Map<string, Uint8Array>> }} input `files` are paths under `root`
 *   with forward slashes; `unzip` opens a fixture archive (the kit's reader, in the test).
 * @returns {Promise<string[]>}
 */
export async function checkFiles({ root, files, unzip }) {
  const problems = [];
  const dec = new TextDecoder();
  for (const file of files) {
    if (KEY_FILE.test(file)) problems.push(`${file}: a key file is tracked`);
    else if (DEV_VARS.test(file)) problems.push(`${file}: a secrets file is tracked`);
    else if (ARCHIVE.test(file)) {
      if (!FIXTURES.test(file)) {
        problems.push(`${file}: an archive is tracked outside test/fixtures/`);
        continue;
      }
      if (!ZIP.test(file) || unzip === undefined) {
        problems.push(`${file}: an archive in test/fixtures/ that cannot be inspected`);
        continue;
      }
      try {
        const entries = await unzip(new Uint8Array(await readFile(join(root, file))));
        for (const [entry, bytes] of entries) {
          if (ARCHIVE.test(entry)) problems.push(`${file}: holds an archive (${entry}), which is not inspected`);
          else if (/\.json$/i.test(entry)) problems.push(...jsonProblems(`${file}!${entry}`, dec.decode(bytes)));
        }
      } catch {
        problems.push(`${file}: an archive in test/fixtures/ that cannot be read`);
      }
      continue;
    }
    if (BINARY.test(file)) continue;
    let bytes;
    try {
      bytes = await readFile(join(root, file));
    } catch {
      continue;
    }
    if (bytes.length > MAX_SCAN_BYTES) continue;
    const text = bytes.toString('utf8');
    if (PRIVATE_KEY_HEADER.test(text)) problems.push(`${file}: holds a private key header`);
    if (/\.json$/i.test(file)) problems.push(...jsonProblems(file, text));
  }
  return problems;
}

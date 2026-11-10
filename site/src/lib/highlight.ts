// A tiny local syntax highlighter for the few snippets on the page. No dependency, no CDN. It returns tokens (never
// HTML), so the caller renders them as text and nothing here can inject markup. The tokens always join back to the input.

export type TokenKind = 'plain' | 'keyword' | 'string' | 'comment' | 'number' | 'fn' | 'flag';
export interface Token {
  kind: TokenKind;
  text: string;
}
export type Lang = 'ts' | 'sh' | 'text';

const KEYWORDS = new Set([
  'import',
  'from',
  'export',
  'const',
  'let',
  'var',
  'await',
  'async',
  'new',
  'if',
  'else',
  'return',
  'type',
  'interface',
  'function',
  'true',
  'false',
  'null',
  'undefined',
  'in',
  'as',
]);

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /\d+(?:\.\d+)?/y;

function push(out: Token[], kind: TokenKind, text: string): void {
  if (text === '') return;
  const last = out[out.length - 1];
  if (last && last.kind === kind && kind === 'plain') last.text += text;
  else out.push({ kind, text });
}

/** The end index (exclusive) of a quoted string that starts at `i`; an unterminated string runs to the end of the line. */
function stringEnd(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') j += 2;
    else if (c === quote) return j + 1;
    else if (c === '\n' && quote !== '`') return j;
    else j++;
  }
  return src.length;
}

function highlightTs(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      push(out, 'comment', src.slice(i, stop));
      i = stop;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      push(out, 'comment', src.slice(i, stop));
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      const stop = stringEnd(src, i);
      push(out, 'string', src.slice(i, stop));
      i = stop;
    } else if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i;
      const word = (IDENT.exec(src) as RegExpExecArray)[0];
      const next = src[i + word.length];
      const prev = i > 0 ? src[i - 1] : '';
      if (KEYWORDS.has(word) && prev !== '.') push(out, 'keyword', word);
      else if (next === '(' ) push(out, 'fn', word);
      else push(out, 'plain', word);
      i += word.length;
    } else if (/\d/.test(c) && !/[\w$]/.test(i > 0 ? (src[i - 1] as string) : '')) {
      NUMBER.lastIndex = i;
      const num = (NUMBER.exec(src) as RegExpExecArray)[0];
      push(out, 'number', num);
      i += num.length;
    } else {
      push(out, 'plain', c);
      i++;
    }
  }
  return out;
}

function highlightSh(src: string): Token[] {
  const out: Token[] = [];
  const lines = src.split('\n');
  lines.forEach((line, n) => {
    const parts = line.split(/(\s+)/);
    let commandSeen = false;
    let inComment = false;
    let comment = '';
    for (const part of parts) {
      if (inComment) {
        comment += part;
      } else if (part.startsWith('#')) {
        inComment = true;
        comment = part;
      } else if (/^\s*$/.test(part)) {
        push(out, 'plain', part);
      } else if (!commandSeen) {
        commandSeen = true;
        push(out, 'fn', part);
      } else if (/^--?[A-Za-z]/.test(part)) {
        push(out, 'flag', part);
      } else {
        push(out, 'plain', part);
      }
    }
    if (inComment) push(out, 'comment', comment);
    if (n < lines.length - 1) push(out, 'plain', '\n');
  });
  return out;
}

export function highlight(src: string, lang: Lang): Token[] {
  if (src === '') return [];
  if (lang === 'ts') return highlightTs(src);
  if (lang === 'sh') return highlightSh(src);
  return [{ kind: 'plain', text: src }];
}

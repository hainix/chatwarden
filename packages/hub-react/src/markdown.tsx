import type { ReactNode } from 'react';
import { Scroll } from './ui.js';

// A small, safe Markdown renderer for the generated policy documents. It is an allow-list: headings, paragraphs, lists,
// emphasis, code, tables and links. Everything else (raw HTML, images, quotes, entities) is shown as the text it is. The output
// is built from React elements only: no string is ever turned into HTML, so nothing in the text can become markup. A link is
// drawn only when its address is https: or relative; any other link keeps its words and loses its address.

/** The characters a backslash may escape (the kit escapes exactly these, and a few more are safe to accept). */
const ESCAPABLE = new Set('\\`*_{}[]()<>#+-.!|~&:"\'=/%$@^,;?');
const NESTING_LIMIT = 6;

function hasControlOrSpace(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** Whether an address may become a link: `https:` (with a host), or a relative address on this site. */
export function isSafeHref(href: string): boolean {
  // A control character or space inside an address is how `java\tscript:` slips past a scheme check: refuse them all.
  const s = href.trim();
  if (s === '' || hasControlOrSpace(s) || /\s/u.test(s)) return false;
  // A browser reads `\` as `/`, so `/\evil.example` is `//evil.example`, a different site: refuse a backslash anywhere, and a
  // slash that is followed by another slash or by anything that could be read as one.
  if (s.includes('\\') || /^\/[\s/]/u.test(s)) return false;
  // `&#x61;` and friends would be decoded by nothing here, but an address that carries an entity is not one we wrote: refuse.
  if (/&#?\w+;/.test(s)) return false;
  const scheme = /^([^/?#]*):/.exec(s);
  if (scheme === null) return true;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

/** The index of the first unescaped `token` at or after `from`, or -1. */
function closing(text: string, from: number, token: string): number {
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text.startsWith(token, i)) return i;
  }
  return -1;
}

/**
 * A finder of closing tokens that reads a text about once however many openers have no closer: past the last occurrence of a token
 * nothing can close, so an opener there answers at once instead of scanning the rest again.
 */
function finderOf(text: string): (token: string, from: number) => number {
  const last = new Map<string, number>();
  return (token, from) => {
    if (!last.has(token)) last.set(token, text.lastIndexOf(token));
    if (from > (last.get(token) as number)) return -1;
    return token === '`' ? text.indexOf(token, from) : closing(text, from, token);
  };
}

/** An address is short: how far past its opener a closing parenthesis is looked for. */
const ADDRESS_SPAN = 2_000;

/** The `)` that closes an address opened just before `from`, counting nested pairs (`javascript:alert(1)`), or -1. */
function closingParen(text: string, from: number): number {
  let depth = 0;
  for (let i = from; i < text.length && i < from + ADDRESS_SPAN; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      if (depth === 0) return i;
      depth -= 1;
    }
  }
  return -1;
}

const isWord = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}]/u.test(c);

/** The inline marks of one line of text, as elements. `depth` stops emphasis from nesting without end. */
function inline(text: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const find = finderOf(text);
  let plain = '';
  let key = 0;
  const flush = (): void => {
    if (plain !== '') out.push(plain);
    plain = '';
  };
  const push = (node: ReactNode): void => {
    flush();
    out.push(node);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === '\\' && i + 1 < text.length && ESCAPABLE.has(text[i + 1] as string)) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = find('`', i + 1);
      if (end > i + 1) {
        push(<code key={key++}>{text.slice(i + 1, end)}</code>);
        i = end + 1;
        continue;
      }
    }
    if (depth < NESTING_LIMIT) {
      if (c === '*' && text[i + 1] === '*') {
        const end = find('**', i + 2);
        if (end > i + 2) {
          push(<strong key={key++}>{inline(text.slice(i + 2, end), depth + 1)}</strong>);
          i = end + 2;
          continue;
        }
      }
      if (c === '*' || (c === '_' && !isWord(text[i - 1]))) {
        const end = find(c, i + 1);
        const ok = end > i + 1 && !/\s/.test(text[i + 1] as string) && !/\s/.test(text[end - 1] as string) && (c === '*' || !isWord(text[end + 1]));
        if (ok) {
          push(<em key={key++}>{inline(text.slice(i + 1, end), depth + 1)}</em>);
          i = end + 1;
          continue;
        }
      }
      const image = c === '!' && text[i + 1] === '[';
      if (c === '[' || image) {
        const open = image ? i + 1 : i;
        const close = find(']', open + 1);
        if (close > open && text[close + 1] === '(') {
          const end = closingParen(text, close + 2);
          if (end > close) {
            const label = text.slice(open + 1, close);
            const href = text.slice(close + 2, end);
            if (image) {
              // An image is not drawn: its words stay, its address does not.
              plain += label;
            } else if (isSafeHref(href)) {
              push(
                <a key={key++} className="cw-link" href={href.trim()} rel="noopener noreferrer" target="_blank">
                  {inline(label, depth + 1)}
                </a>,
              );
            } else {
              for (const n of inline(label, depth + 1)) push(n);
            }
            i = end + 1;
            continue;
          }
        }
      }
    }
    plain += c;
    i += 1;
  }
  flush();
  return out;
}

type Block =
  | { k: 'h'; level: number; text: string }
  | { k: 'p'; text: string }
  | { k: 'list'; ordered: boolean; items: string[] }
  | { k: 'code'; text: string }
  | { k: 'table'; head: string[]; rows: string[][] };

/** How much of a line is looked at to tell what kind of block it opens; the rest of the line is carried along as plain text. */
const LINE_CAP = 2_000;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,9}[.)]\s+(.*)$/;
const SEPARATOR = /^\s*(?:\|\s*)?:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE = /^\s*```/;

/** The cells of one table line, split on pipes that are not escaped. */
function cells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
    } else if (s[i] === '|') {
      out.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  out.push(cur.trim());
  return out;
}

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = (): void => {
    if (para.length > 0) blocks.push({ k: 'p', text: para.join(' ') });
    para = [];
  };
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n] as string;
    // Block syntax is read from the first LINE_CAP characters only: what lies past them is text, never a marker.
    const head = line.length > LINE_CAP ? line.slice(0, LINE_CAP) : line;
    const tail = line.slice(head.length);
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (head.includes('`') && FENCE.test(head)) {
      flush();
      const body: string[] = [];
      n += 1;
      while (n < lines.length && !((lines[n] as string).includes('`') && FENCE.test((lines[n] as string).slice(0, LINE_CAP)))) {
        body.push(lines[n] as string);
        n += 1;
      }
      blocks.push({ k: 'code', text: body.join('\n') });
      continue;
    }
    const heading = head.includes('#') ? HEADING.exec(head) : null;
    if (heading !== null) {
      flush();
      blocks.push({ k: 'h', level: (heading[1] as string).length, text: `${heading[2] as string}${tail}`.trim() });
      continue;
    }
    const next = lines[n + 1];
    if (head.trimStart().startsWith('|') && next !== undefined && next.slice(0, LINE_CAP).includes('-') && SEPARATOR.test(next.slice(0, LINE_CAP))) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      n += 2;
      while (n < lines.length && (lines[n] as string).trim().startsWith('|')) {
        const row = cells(lines[n] as string);
        rows.push(Array.from({ length: head.length }, (_, c) => row[c] ?? ''));
        n += 1;
      }
      n -= 1;
      blocks.push({ k: 'table', head, rows });
      continue;
    }
    const bullet = BULLET.exec(head);
    const numbered = bullet === null ? NUMBERED.exec(head) : null;
    const item = bullet ?? numbered;
    if (item !== null) {
      flush();
      const ordered = numbered !== null;
      const last = blocks[blocks.length - 1];
      let list: Extract<Block, { k: 'list' }>;
      if (last !== undefined && last.k === 'list' && last.ordered === ordered) list = last;
      else {
        list = { k: 'list', ordered, items: [] };
        blocks.push(list);
      }
      list.items.push(`${item[1] as string}${tail}`);
      continue;
    }
    // An indented line right after a list item continues that item.
    const prev = blocks[blocks.length - 1];
    if (para.length === 0 && /^\s+\S/.test(head) && prev !== undefined && prev.k === 'list' && lines[n - 1]?.trim() !== '') {
      prev.items[prev.items.length - 1] += ` ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

export interface MarkdownProps {
  source: string;
  /** The accessible name of the nth table (1-based): a scroll box that can be reached by keyboard needs one. */
  tableLabel: (n: number) => string;
  /** The level of a `#` heading. Default 3: below the screen title (2) and a panel title. */
  headingBase?: number;
}

/** Markdown as safe elements. See the notes at the top of this file. */
export function Markdown({ source, tableLabel, headingBase = 3 }: MarkdownProps) {
  const blocks = parse(source);
  let tables = 0;
  return (
    <div className="cw-doc">
      {blocks.map((b, i): ReactNode => {
        switch (b.k) {
          case 'h': {
            const Tag = `h${Math.min(6, headingBase + b.level - 1)}` as 'h3';
            return <Tag key={i}>{inline(b.text)}</Tag>;
          }
          case 'p':
            return <p key={i}>{inline(b.text)}</p>;
          case 'list': {
            const List = b.ordered ? 'ol' : 'ul';
            return (
              <List key={i}>
                {b.items.map((item, n) => (
                  <li key={n}>{inline(item)}</li>
                ))}
              </List>
            );
          }
          case 'code':
            return (
              <pre key={i}>
                <code>{b.text}</code>
              </pre>
            );
          case 'table': {
            tables += 1;
            return (
              <Scroll key={i} label={tableLabel(tables)}>
                <table className="cw-table">
                  <thead>
                    <tr>
                      {b.head.map((h, c) => (
                        <th key={c} scope="col">
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((cell, c) => (
                          <td key={c}>{inline(cell)}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            );
          }
        }
      })}
    </div>
  );
}

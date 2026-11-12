import { useId, useState } from 'react';
import type { CSSProperties } from 'react';
import { highlight, type Lang } from '../lib/highlight';
import { CopyButton } from './CopyButton';

/**
 * A copyable, highlighted code block. The <pre> is focusable so keyboard users can scroll long lines.
 * `collapsedLines` shows only the first lines with a "Show the full file" button; the whole file is in the page either way
 * (copy, search and screen readers get all of it), the stylesheet only clips what is drawn.
 */
export function CodeBlock({
  code,
  lang,
  title,
  copyLabel,
  collapsedLines,
}: {
  code: string;
  lang: Lang;
  title: string;
  copyLabel: string;
  collapsedLines?: number;
}) {
  const tokens = highlight(code, lang);
  const [open, setOpen] = useState(false);
  const preId = useId();
  const collapsible = collapsedLines !== undefined && code.split('\n').length > collapsedLines;
  const collapsed = collapsible && !open;
  return (
    <figure className="code">
      <figcaption className="code-bar">
        <span className="code-title">{title}</span>
        <CopyButton text={code} label={copyLabel} />
      </figcaption>
      <pre
        id={preId}
        tabIndex={0}
        role="region"
        aria-label={`${title}: code`}
        data-collapsed={collapsed ? 'true' : undefined}
        style={collapsed ? ({ ['--lines' as string]: collapsedLines } as CSSProperties) : undefined}
      >
        <code>
          {tokens.map((t, i) =>
            t.kind === 'plain' ? t.text : (
              <span key={i} className={`tok-${t.kind}`}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
      {collapsible && (
        <button type="button" className="code-more" aria-expanded={open} aria-controls={preId} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show fewer lines' : 'Show the full file'}
        </button>
      )}
    </figure>
  );
}

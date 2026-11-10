import { highlight, type Lang } from '../lib/highlight';
import { CopyButton } from './CopyButton';

/** A copyable, highlighted code block. The <pre> is focusable so keyboard users can scroll long lines. */
export function CodeBlock({
  code,
  lang,
  title,
  copyLabel,
}: {
  code: string;
  lang: Lang;
  title: string;
  copyLabel: string;
}) {
  const tokens = highlight(code, lang);
  return (
    <figure className="code">
      <figcaption className="code-bar">
        <span className="code-title">{title}</span>
        <CopyButton text={code} label={copyLabel} />
      </figcaption>
      <pre tabIndex={0} aria-label={`${title}: code`}>
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
    </figure>
  );
}

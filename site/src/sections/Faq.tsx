import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { ChevronIcon } from '../components/Icons';
import { FAQ } from '../content';
import type { FaqItem } from '../content';

/** The answer, with each linked name (Coop, HMA) turned into its link where it appears in the sentence. */
function Answer({ item }: { item: FaqItem }) {
  const links = item.links ?? [];
  if (links.length === 0) return <>{item.a}</>;
  // Walk the sentence once, cutting it at each linked name in the order the names appear.
  const out: ReactNode[] = [];
  let rest = item.a;
  for (let n = 0; rest !== ''; n += 1) {
    const hit = links
      .map((l) => ({ l, at: rest.indexOf(l.label) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)[0];
    if (hit === undefined) {
      out.push(<Fragment key={n}>{rest}</Fragment>);
      break;
    }
    if (hit.at > 0) out.push(<Fragment key={`t${n}`}>{rest.slice(0, hit.at)}</Fragment>);
    out.push(
      <a key={`a${n}`} href={hit.l.href} target="_blank" rel="noopener noreferrer">
        {hit.l.label}
      </a>,
    );
    rest = rest.slice(hit.at + hit.l.label.length);
  }
  return <>{out}</>;
}

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="section section-alt">
      <div className="wrap faq-wrap">
        <div className="section-head">
          <h2 id="faq-title">Questions</h2>
        </div>
        <div className="faq">
          {FAQ.map((f) => (
            <details key={f.id} className="faq-item">
              <summary>
                <h3>{f.q}</h3>
                <ChevronIcon className="chev" />
              </summary>
              <p>
                <Answer item={f} />
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

import { ChevronIcon } from '../components/Icons';
import { FAQ } from '../content';

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
                {f.a}
                {f.links && (
                  <>
                    {' '}
                    {f.links.map((l, i) => (
                      <span key={l.href}>
                        {i > 0 && ' and '}
                        <a href={l.href} target="_blank" rel="noopener noreferrer">
                          {l.label}
                        </a>
                      </span>
                    ))}
                    .
                  </>
                )}
              </p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

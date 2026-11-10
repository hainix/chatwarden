import { CodeBlock } from '../components/CodeBlock';
import { STEPS } from '../content';

export function Steps() {
  return (
    <section id="add-it" aria-labelledby="add-it-title" className="section section-alt">
      <div className="wrap">
        <div className="section-head">
          <h2 id="add-it-title">Add it in 3 steps</h2>
          <p className="section-lead">Real code from the READMEs. Copy it, then point identify at your own connections.</p>
        </div>
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.id} className="step">
              <div className="step-text">
                <span className="step-num" aria-hidden="true">
                  {i + 1}
                </span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
              <CodeBlock code={s.code} lang={s.lang} title={s.file} copyLabel={s.copyLabel} />
            </li>
          ))}
        </ol>
        <p className="steps-more">
          Want routes for moderators and players? Add <code>@chatwarden/http</code> and mount the Express adapter. The{' '}
          <a href="https://github.com/hainix/chatwarden/tree/main/packages/http" target="_blank" rel="noopener noreferrer">
            http README
          </a>{' '}
          has the setup.
        </p>
      </div>
    </section>
  );
}

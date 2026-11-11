import { CodeBlock } from '../components/CodeBlock';
import { HUB_STEP, PLAYER_REACT_URL, STEPS } from '../content';

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
        <div className="hub-step" data-hub-step>
          <h3>{HUB_STEP.title}</h3>
          <p>
            {HUB_STEP.body} Your players get their notices and a report dialog from{' '}
            <a href={PLAYER_REACT_URL} target="_blank" rel="noopener noreferrer">
              @chatwarden/player-react
            </a>
            .
          </p>
          <CodeBlock code={HUB_STEP.install.code} lang={HUB_STEP.install.lang} title={HUB_STEP.install.file} copyLabel={HUB_STEP.install.copyLabel} />
          <div className="hub-step-code">
            <CodeBlock code={HUB_STEP.dropIn.code} lang={HUB_STEP.dropIn.lang} title={HUB_STEP.dropIn.file} copyLabel={HUB_STEP.dropIn.copyLabel} />
            <div className="hub-alt">
              <p>Or, with no React and no build step, one script tag and one element:</p>
              <CodeBlock code={HUB_STEP.element.code} lang={HUB_STEP.element.lang} title={HUB_STEP.element.file} copyLabel={HUB_STEP.element.copyLabel} />
            </div>
          </div>
        </div>
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

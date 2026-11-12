import { CodeBlock } from '../components/CodeBlock';
import { ExternalIcon } from '../components/Icons';
import { Tabs } from '../components/Tabs';
import { ADD_IT, HUB_STEP, PLAYER_STEP, STEPS } from '../content';

export function Steps() {
  const hubTabs = HUB_STEP.tabs.map((t) => ({
    id: t.id,
    label: t.label,
    panel: (
      <>
        {t.snippets.map((s) => (
          <CodeBlock key={s.file} code={s.code} lang={s.lang} title={s.file} copyLabel={s.copyLabel} />
        ))}
      </>
    ),
  }));
  return (
    <section id="add-it" aria-labelledby="add-it-title" className="section section-alt">
      <div className="wrap">
        <div className="section-head">
          <h2 id="add-it-title">{ADD_IT.title}</h2>
          <p className="section-lead">{ADD_IT.lead}</p>
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
              <CodeBlock code={s.code} lang={s.lang} title={s.file} copyLabel={s.copyLabel} collapsedLines={s.collapsedLines} />
            </li>
          ))}
          <li className="step" data-hub-step>
            <div className="step-text">
              <span className="step-num" aria-hidden="true">
                {STEPS.length + 1}
              </span>
              <h3>{HUB_STEP.title}</h3>
              <p>{HUB_STEP.body}</p>
            </div>
            <Tabs label="Ways to put the hub on a page" items={hubTabs} />
          </li>
          <li className="step step-optional">
            <div className="step-text">
              <span className="step-num" aria-hidden="true">
                {STEPS.length + 2}
              </span>
              <h3>{PLAYER_STEP.title}</h3>
              <span className="pill pill-opt">Optional</span>
              <p>{PLAYER_STEP.body}</p>
              <a className="card-link" href={PLAYER_STEP.link.href} target="_blank" rel="noopener noreferrer">
                {PLAYER_STEP.link.label} <ExternalIcon />
              </a>
            </div>
          </li>
        </ol>
        <p className="steps-more">{ADD_IT.closing}</p>
      </div>
    </section>
  );
}

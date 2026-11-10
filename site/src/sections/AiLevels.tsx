import { LockIcon } from '../components/Icons';
import { CEILINGS, LEVELS } from '../content';

export function AiLevels() {
  return (
    <section id="levels" aria-labelledby="levels-title" className="section">
      <div className="wrap">
        <div className="section-head">
          <h2 id="levels-title">AI moderation levels</h2>
          <p className="section-lead">
            Every level is opt-in, and each one includes the levels below it. Only level 0 exists today. The rest are
            coming soon.
          </p>
        </div>
        <div className="levels-layout">
          <ol className="levels">
            {LEVELS.map((l) => (
              <li key={l.level} className="level" data-level={l.level} data-status={l.status}>
                <span className="level-num" aria-hidden="true">
                  {l.level}
                </span>
                <div className="level-body">
                  <h3>
                    <span className="sr-only">Level {l.level}: </span>
                    {l.name}
                  </h3>
                  <p>{l.body}</p>
                </div>
                <span className={`pill ${l.status === 'available' ? 'pill-live' : 'pill-soon'}`}>
                  {l.status === 'available' ? 'Available' : 'Coming soon'}
                </span>
              </li>
            ))}
          </ol>
          <aside className="ceilings" aria-labelledby="ceilings-title">
            <h3 id="ceilings-title">
              <LockIcon /> Hard limits, written into the code
            </h3>
            <p>These hold at every level. They are not settings.</p>
            <ul>
              {CEILINGS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </aside>
        </div>
      </div>
    </section>
  );
}

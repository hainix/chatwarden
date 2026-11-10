import { LockIcon } from '../components/Icons';
import { useSeen } from '../lib/useSeen';
import { CEILINGS, CEILINGS_INTRO, CEILINGS_TITLE, LEVELS } from '../content';

/** A HUD readout of what exists today. Only level 0 is built, and it says so; the pips run a one-off scan when it scrolls into view. */
function LevelMeter() {
  const { ref, phase } = useSeen<HTMLDivElement>();
  const shipped = LEVELS.filter((l) => l.level > 0 && l.status === 'available').length;
  return (
    <div ref={ref} className="level-meter" data-testid="level-meter" data-phase={phase}>
      <span className="pips" aria-hidden="true">
        {LEVELS.filter((l) => l.level > 0).map((l) => (
          <span key={l.level} className={`pip ${l.status === 'available' ? 'is-live' : ''}`} />
        ))}
      </span>
      <p>
        <strong>AI levels shipped: {shipped} of {LEVELS.length - 1}.</strong> Level 0 is live; levels 1 to {LEVELS.length - 1} are
        coming.
      </p>
    </div>
  );
}

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
        <LevelMeter />
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
              <LockIcon /> {CEILINGS_TITLE}
            </h3>
            <p>{CEILINGS_INTRO}</p>
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

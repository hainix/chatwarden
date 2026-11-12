import { CodeBlock } from '../components/CodeBlock';
import { CODE_STEPS } from './codeSteps';

/** The few real kit lines behind a step, copied from the READMEs, and where this demo differs from a game. Open from the tour card or the toolbar. */
export function CodeDrawer({ step, onPick }: { step: number; onPick: (i: number) => void }) {
  const s = CODE_STEPS[Math.min(Math.max(step, 0), CODE_STEPS.length - 1)];
  if (s === undefined) return null;
  const n = CODE_STEPS.indexOf(s);
  return (
    <section id="demo-code" className="drawer" aria-label={`Kit code for step ${n + 1}`}>
      <div className="drawer-head">
        <div>
          <h3>
            Step {n + 1}: {s.title}
          </h3>
          <p>{s.blurb}</p>
          {s.demoNote !== undefined && <p className="drawer-note">{s.demoNote}</p>}
        </div>
        <div className="drawer-steps" role="group" aria-label="Pick a step">
          {CODE_STEPS.map((c, i) => (
            <button key={c.title} type="button" aria-pressed={i === n} aria-label={`Code for step ${i + 1}: ${c.title}`} onClick={() => onPick(i)}>
              {i + 1}
            </button>
          ))}
        </div>
      </div>
      <CodeBlock code={s.code} lang={s.lang} title={s.file} copyLabel={`Copy the step ${n + 1} code`} />
      <p className="drawer-source">
        Copied from <code>{s.source}</code> in the repo.
      </p>
    </section>
  );
}

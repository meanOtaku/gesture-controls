import { AnimatedNumber, AnimatedText } from "../../../components/app/AnimatedNumber";
import { describeInput, percent, type Inspection } from "../inspection";

/**
 * The inputs the trees lean on most: how much each one's splits cut the trees' uncertainty, as a share of all of them
 * (mean decrease in impurity). The model reads all of them; these are the ones that matter most.
 */
export function InspectInputs({ inspection }: { inspection: Inspection }) {
  if (inspection.kind === "cnn") return <CnnInputs inspection={inspection} />;
  const biggest = Math.max(1e-9, ...inspection.importance.map((entry) => entry.importance));
  return (
    <section aria-label="Inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">What it leans on</h3>
      <p className="field-hint">
        The model reads <AnimatedText>{inspection.inputCount.toLocaleString("en-US")}</AnimatedText> inputs, {inspection.sources?.includes("watchOrientation") ? "from the pulse sensor and the motion sensors" : "all from the pulse sensor"}, and {<AnimatedNumber value={inspection.trees} />} trees vote on each moment. These are the {<AnimatedNumber value={inspection.importance.length} />} inputs whose splits do the most to tell a gesture&apos;s start from the rest, as a share of everything the trees learn.
      </p>
      <div className="max-w-full overflow-auto">
        <table className="w-full text-sm" aria-label="Most important inputs">
          <thead><tr className="text-left"><th className="pr-3">Input</th><th className="pr-3">What it is</th><th className="pr-3">Share</th></tr></thead>
          <tbody>
            {inspection.importance.map((entry) => (
              <tr key={entry.name} className="align-top border-t border-input/40">
                <th scope="row" className="pr-3 text-left font-mono text-xs font-normal">{entry.name}</th>
                <td className="pr-3">{describeInput(entry.name)}</td>
                <td className="pr-3">
                  <span className="inline-flex items-center gap-2">
                    <span aria-hidden="true" className="inline-block h-2 rounded-sm" style={{ width: `${Math.max(2, (entry.importance / biggest) * 80)}px`, background: "#ff6f91" }} />
                    {<AnimatedNumber value={(entry.importance * 100)} digits={1} />}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** What a CNN reads. It keeps no share per input as trees do, so none is shown: it learns from each channel's shape in time. */
function CnnInputs({ inspection }: { inspection: Inspection }) {
  return (
    <section aria-label="Inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">What it reads</h3>
      <p className="field-hint">
        The model reads <AnimatedText>{inspection.inputCount.toLocaleString("en-US")}</AnimatedText> inputs: the last second of 9 channels at 50 ticks a second. A CNN learns from the shape of those channels over time, so unlike trees it has no share per input to list.
      </p>
      <div className="max-w-full overflow-auto">
        <table className="w-full text-sm" aria-label="Channels the model reads">
          <thead><tr className="text-left"><th className="pr-3">Sensor</th><th className="pr-3">Channels</th><th className="pr-3">Inputs</th></tr></thead>
          <tbody>
            <tr className="border-t border-input/40"><th scope="row" className="pr-3 text-left font-normal">Accelerometer</th><td className="pr-3">x, y, z</td><td className="pr-3">150</td></tr>
            <tr className="border-t border-input/40"><th scope="row" className="pr-3 text-left font-normal">Gyroscope</th><td className="pr-3">x, y, z</td><td className="pr-3">150</td></tr>
            <tr className="border-t border-input/40"><th scope="row" className="pr-3 text-left font-normal">Pulse sensor</th><td className="pr-3">green, red, infrared</td><td className="pr-3">150</td></tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** What a bundle's manifest says about its settings and how it was tested, for a model without a saved inspection. */
export function DeclaredFacts({ manifest }: { manifest: Record<string, unknown> }) {
  const thresholds = (manifest.thresholds ?? {}) as Record<string, unknown>;
  const provenance = (manifest.provenance ?? {}) as Record<string, unknown>;
  const number = (value: unknown) => (typeof value === "number" ? value : null);
  const listed = (value: unknown) => (Array.isArray(value) ? value.length : null);
  const recall = number(provenance.evaluationGestureRecall);
  const facts: [string, string | null][] = [
    ["Fires at", number(thresholds.activation)?.toFixed(2) ?? null],
    ["Ends below", number(thresholds.release)?.toFixed(2) ?? null],
    ["Decides after", number(thresholds.decisionDelayMs) === null ? null : `${number(thresholds.decisionDelayMs)} ms`],
    ["Waits between detections", number(thresholds.cooldownMs) === null ? null : `${number(thresholds.cooldownMs)} ms`],
    ["Held-out gesture recall", recall === null ? null : percent(recall)],
    ["Held-out false activations", number(provenance.evaluationFalseActivationsPerHour) === null ? null : `${number(provenance.evaluationFalseActivationsPerHour)?.toFixed(1)} / hour`],
    ["Held-out ROC AUC", number(provenance.evaluationRocAuc)?.toFixed(3) ?? null],
    ["Training recordings", listed(provenance.trainRecordings)?.toString() ?? null],
    ["Held-out recordings", listed(provenance.evaluationRecordings)?.toString() ?? null],
  ];
  const known = facts.filter((fact): fact is [string, string] => fact[1] !== null);
  if (known.length === 0) return null;
  return (
    <section aria-label="Declared settings and results" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Settings and test results</h3>
      <p className="field-hint">As its manifest states them. The app has not checked the test results itself.</p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        {known.map(([name, value]) => <div key={name}><dt className="text-muted-foreground">{name}</dt><dd className="text-numeric">{value}</dd></div>)}
      </dl>
    </section>
  );
}

/** What a model without a saved inspection declares it reads. */
export function DeclaredInputs({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <section aria-label="Declared inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Inputs ({<AnimatedNumber value={names.length} />})</h3>
      <p className="field-hint">What its manifest says it reads, for example {describeInput(names[0])}.</p>
    </section>
  );
}

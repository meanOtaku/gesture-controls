import { describeInput, type Inspection } from "../inspection";

/**
 * The inputs the trees lean on most: how much each one's splits cut the trees' uncertainty, as a share of all of them
 * (mean decrease in impurity). The model reads all of them; these are the ones that matter most.
 */
export function InspectInputs({ inspection }: { inspection: Inspection }) {
  const biggest = Math.max(1e-9, ...inspection.importance.map((entry) => entry.importance));
  return (
    <section aria-label="Inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">What it leans on</h3>
      <p className="field-hint">
        The model reads {inspection.inputCount.toLocaleString("en-US")} inputs, {inspection.sources?.includes("watchOrientation") ? "from the pulse sensor and the motion sensors" : "all from the pulse sensor"}, and {inspection.trees} trees vote on each moment. These are the {inspection.importance.length} inputs whose splits do the most to tell a gesture&apos;s start from the rest, as a share of everything the trees learn.
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
                    {(entry.importance * 100).toFixed(1)}%
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

/** What a model without a saved inspection declares it reads. */
export function DeclaredInputs({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <section aria-label="Declared inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Inputs ({names.length})</h3>
      <p className="field-hint">What its manifest says it reads, for example {describeInput(names[0])}.</p>
    </section>
  );
}

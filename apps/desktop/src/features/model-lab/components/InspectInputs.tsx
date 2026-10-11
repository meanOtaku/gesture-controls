import { useMemo, useState } from "react";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { describeColumn, describeInput, STREAM_TITLES } from "../featureInfo";
import type { Inspection } from "../inspection";

/**
 * Every input of the model: what it is, what value it takes, what the model scales it by, how much it matters (how far the
 * held-out ROC AUC falls when it is shuffled between windows) and, for a linear model, its weight.
 */
export function InspectInputs({ inspection, spikeLabel, editing = false, switchedOff, onToggleInput }: { inspection: Inspection; spikeLabel?: string; /** Adds a column to switch an input off. */ editing?: boolean; switchedOff?: Set<string>; onToggleInput?: (name: string) => void }) {
  const [byImportance, setByImportance] = useState(true);
  const importance = useMemo(() => new Map(inspection.importance.map((entry) => [entry.name, entry])), [inspection]);
  const linear = inspection.network.kind === "linear";
  const columns = inspection.inputKind === "columns";
  const steps = inspection.gridSteps ?? 1;
  const rows = useMemo(() => {
    const list = inspection.inputs.map((input, index) => ({
      input,
      info: columns ? { ...describeInput(input.name, spikeLabel), text: describeColumn(input.name, steps) } : describeInput(input.name, spikeLabel),
      importance: importance.get(input.name),
      weight: linear ? (columns ? inspection.network.output.weights.slice(index * steps, (index + 1) * steps).reduce((sum, row) => sum + (row[0] ?? 0), 0) : inspection.network.output.weights[index]?.[0]) : undefined,
    }));
    return byImportance ? [...list].sort((a, b) => (b.importance?.aucDrop ?? 0) - (a.importance?.aucDrop ?? 0)) : list;
  }, [inspection, importance, linear, spikeLabel, byImportance, columns, steps]);
  const biggest = Math.max(0.0001, ...inspection.importance.map((entry) => Math.abs(entry.aucDrop)));
  const channels = inspection.inputKind === "channels" || inspection.inputKind === "columns";

  return (
    <section aria-label="Inputs" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-base font-semibold">Inputs ({inspection.inputs.length})</h3>
        <Button type="button" variant="outline" size="sm" onClick={() => setByImportance((value) => !value)}>
          {byImportance ? "Show in the model's own order" : "Sort by importance"}
        </Button>
      </div>
      <p className="field-hint">
        Importance is how far the ROC AUC on the held-out windows falls when this {channels ? "channel" : "input"} is shuffled between windows, so the model cannot use it. Near zero means the model does without it (or another input says the same thing).
        {channels ? " The model scales each channel by the average and spread shown, after taking the window's own average away if that was chosen." : " The model scales each input by the average and spread shown before it uses it."}
      </p>
      <div className="max-w-full overflow-auto">
        <table className="w-full text-sm" aria-label="Inputs of the model">
          <thead>
            <tr className="text-left">
              <th className="pr-3">Input</th>
              <th className="pr-3">What it takes as its value</th>
              {columns && <th className="pr-3">Neurons</th>}
              <th className="pr-3">Scaled by (average, spread)</th>
              <th className="pr-3">Importance</th>
              {linear && <th className="pr-3">{columns ? "Weight (all its readings)" : "Weight"}</th>}
              {editing && <th className="pr-3">Switch off</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ input, info, importance: entry, weight }) => (
              <tr key={input.name} className="align-top border-t border-input/40">
                <th scope="row" className="pr-3 text-left font-medium">{STREAM_TITLES[info.stream]} · {info.group} · {info.short}</th>
                <td className="pr-3 text-muted-foreground">{info.text}</td>
                {columns && <td className="pr-3">{input.neurons ?? steps}</td>}
                <td className="pr-3 whitespace-nowrap">{input.mean.toPrecision(4)}, {input.std.toPrecision(3)}</td>
                <td className="pr-3 whitespace-nowrap">
                  {entry ? (
                    <span className="inline-flex items-center gap-2" title={`AUC falls by ${entry.aucDrop.toFixed(3)} (± ${entry.aucDropStd.toFixed(3)}) when shuffled`}>
                      <span aria-hidden="true" className="inline-block h-2 rounded-sm" style={{ width: `${Math.max(2, (Math.abs(entry.aucDrop) / biggest) * 90)}px`, background: entry.aucDrop >= 0 ? "#ff6f91" : "#999" }} />
                      {entry.aucDrop.toFixed(3)}
                    </span>
                  ) : "–"}
                </td>
                {linear && <td className="pr-3 whitespace-nowrap">{weight === undefined ? "–" : weight.toFixed(3)}</td>}
                {editing && (
                  <td className="pr-3">
                    <Checkbox checked={switchedOff?.has(input.name) ?? false} onCheckedChange={() => onToggleInput?.(input.name)} aria-label={`Switch off ${STREAM_TITLES[info.stream]} ${info.group} ${info.short}`} />
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** For a model that was imported or trained before inspections: the inputs it declares, in words. */
export function DeclaredInputs({ names, spikeLabel }: { names: string[]; spikeLabel?: string }) {
  return (
    <section aria-label="Inputs" className="flex flex-col gap-2">
      <h3 className="text-base font-semibold">Inputs ({names.length})</h3>
      <ul className="flex flex-col gap-1 text-sm" aria-label="Inputs of the model">
        {names.map((name) => {
          const info = describeInput(name, spikeLabel);
          return <li key={name}><strong>{STREAM_TITLES[info.stream]} · {info.group} · {info.short}</strong> <span className="text-muted-foreground">{info.text}</span></li>;
        })}
      </ul>
    </section>
  );
}

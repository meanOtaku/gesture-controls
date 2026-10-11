import { useMemo, useState } from "react";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { describeInput, inputLabel } from "../featureInfo";
import { CATEGORY_TEXT, divergingColor, foldGrid, normaliseRows, percent, type Inspection, type InspectionWindow } from "../inspection";
import { Heatmap } from "./Heatmap";

const seconds = (ns: number) => `${(ns / 1e9).toFixed(1)} s`;

function Bar({ value, limit }: { value: number; limit: number }) {
  const span = limit > 0 ? (Math.abs(value) / limit) * 60 : 0;
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      <span className="relative inline-block h-3 w-32 rounded-sm bg-muted/40">
        <span className="absolute top-0 h-3 rounded-sm" style={{ background: divergingColor(value, limit), left: value >= 0 ? "50%" : `${50 - span / 0.64}%`, width: `${span / 0.64}%`, border: "1px solid rgba(0,0,0,0.25)" }} />
        <span className="absolute left-1/2 top-0 h-3 w-px bg-foreground/40" />
      </span>
    </span>
  );
}

/** What the model did with real windows from recordings it never trained on: each input's value, each layer's output, and what moved the answer. */
export function InspectWindows({ inspection, spikeLabel }: { inspection: Inspection; spikeLabel?: string }) {
  const [chosen, setChosen] = useState(0);
  const [bySize, setBySize] = useState(true);
  const windows = inspection.windows;
  const window: InspectionWindow | undefined = windows[Math.min(chosen, windows.length - 1)];
  const convolutional = inspection.inputKind === "channels";
  const columns = inspection.inputKind === "columns";
  const readings = inspection.gridSteps ?? 1;
  const names = inspection.inputs.map((input) => input.name);
  const rows = useMemo(() => {
    if (!window || convolutional) return [];
    const list = names.map((name, index) => {
      const input = inspection.inputs[index];
      // A raw column has a reading at each step: show their average, against the column's average.
      const value = columns ? window.values.slice(index * readings, (index + 1) * readings).reduce((sum, v) => sum + v, 0) / readings : window.values[index];
      return { name, info: describeInput(name, spikeLabel), value, z: (value - input.mean) / input.std, move: window.contributions?.[index] ?? 0 };
    });
    return bySize ? [...list].sort((a, b) => Math.abs(b.move) - Math.abs(a.move)) : list;
  }, [window, convolutional, columns, readings, names, inspection.inputs, bySize, spikeLabel]);

  if (!window) return <section aria-label="Windows"><h3 className="text-base font-semibold">Try a window</h3><p className="hint">No windows were saved with this model.</p></section>;
  const threshold = inspection.evaluation.threshold;
  const steps = inspection.gridSteps ?? 0;
  const limitMove = Math.max(0.0001, ...rows.map((row) => Math.abs(row.move)));
  const limitZ = Math.max(1, ...rows.map((row) => Math.abs(row.z)));

  return (
    <section aria-label="Windows" className="flex flex-col gap-3">
      <h3 className="text-base font-semibold">Try a window</h3>
      <p className="field-hint">Real windows from the recordings the model was tested on, picked to show what it gets right and wrong. Choose one to see what each input took as its value and how each layer answered.</p>
      <ul className="flex flex-wrap gap-2" aria-label="Windows to look at">
        {windows.map((entry, index) => {
          const sameKind = windows.filter((other) => other.category === entry.category);
          const number = sameKind.length > 1 ? ` ${sameKind.indexOf(entry) + 1}` : "";
          return (
          <li key={index}>
            <Button type="button" size="sm" variant={index === chosen ? "default" : "outline"} aria-pressed={index === chosen} onClick={() => setChosen(index)}>
              {CATEGORY_TEXT[entry.category].title}{number} · {percent(entry.probability)}
            </Button>
          </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2" role="status" aria-label="The window chosen">
        <Badge variant={window.probability >= threshold ? "default" : "secondary"}>Score {percent(window.probability)} {window.probability >= threshold ? "≥" : "<"} cut-off {percent(threshold)}</Badge>
        <span className="text-sm">{CATEGORY_TEXT[window.category].says} It came from recording {window.recording.slice(0, 8)}, {seconds(window.startNs)} in, labelled “{window.label}”.</span>
      </div>

      {convolutional ? (
        <div className="flex flex-col gap-4">
          <Heatmap title="The window" matrix={normaliseRows(foldGrid(window.values, steps))} rowLabels={names.map(inputLabel)} scale="sequential" cell={12} caption="The window as the model reads it: each channel on its own scale, low to high" />
          {(window.activations as number[][][]).slice(0, inspection.network.conv.length).map((maps, index) => (
            <Heatmap key={index} title={`Convolution layer ${index + 1} output`} matrix={maps} rowLabels={maps.map((_, f) => `filter ${f + 1}`)} scale="sequential" cell={12} caption={`Convolution layer ${index + 1}: how strongly each filter fired at each step`} />
          ))}
          {window.occlusion && (
            <Heatmap
              title="What mattered"
              matrix={window.occlusion.drop}
              rowLabels={names.map(inputLabel)}
              colLabels={window.occlusion.drop[0].map((_, b) => `${b * window.occlusion!.blockSteps + 1}–${(b + 1) * window.occlusion!.blockSteps}`)}
              cell={16}
              caption="How much the score falls when a stretch of one channel is replaced by its own average: red parts held the answer up"
            />
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setBySize((value) => !value)}>{bySize ? "Show this window's inputs in the model's own order" : "Sort this window's inputs by how much they moved the answer"}</Button>
          </div>
          <div className="max-w-full overflow-auto">
            <table className="w-full text-sm" aria-label="Inputs for this window">
              <thead>
                <tr className="text-left">
                  <th className="pr-3">Input</th>
                  <th className="pr-3">{columns && readings > 1 ? "Its value (average of its readings)" : "Its value"}</th>
                  <th className="pr-3">Compared with the training average</th>
                  <th className="pr-3">Moved the answer by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.name} className="border-t border-input/40">
                    <th scope="row" className="pr-3 text-left font-medium">{row.info.group} {row.info.short}</th>
                    <td className="pr-3 whitespace-nowrap">{row.value.toPrecision(4)}</td>
                    <td className="pr-3 whitespace-nowrap"><Bar value={row.z} limit={limitZ} /> {row.z >= 0 ? "+" : ""}{row.z.toFixed(1)} spreads</td>
                    <td className="pr-3 whitespace-nowrap"><Bar value={row.move} limit={limitMove} /> {row.move >= 0 ? "+" : ""}{(row.move * 100).toFixed(1)} points</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="field-hint">“Moved the answer by” is how many percentage points the score falls when this input takes its average value instead (red: it was pushing toward the gesture).</p>
          {(window.activations as number[][]).map((layer, index) => (
            <Heatmap
              key={index}
              title={`Layer ${index + 1} neurons`}
              matrix={[layer]}
              colLabels={layer.map((_, k) => `${k + 1}`)}
              scale={inspection.network.dense[index]?.activation === "tanh" ? "diverging" : "sequential"}
              cell={16}
              caption={`Layer ${index + 1}: what each of its ${layer.length} neurons produced for this window`}
            />
          ))}
        </div>
      )}
    </section>
  );
}

import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import { ALL_COLUMNS, CNN_STEPS, DATASET_COLUMNS, RAW_STEPS, type TrainMethod } from "../training";
import { STREAM_TITLES, type InputStream } from "../featureInfo";

const NATIVE_SELECT = "recipe-select";

/** What one column is, in words, for hover and for the summary. */
const MEANING: Record<string, string> = {
  ppg_green: "the green light of the pulse sensor", ppg_red: "the red light of the pulse sensor", ppg_ir: "the infrared light of the pulse sensor",
  accel_x: "acceleration on the x axis", accel_y: "acceleration on the y axis", accel_z: "acceleration on the z axis",
  gyro_x: "turning speed about the x axis", gyro_y: "turning speed about the y axis", gyro_z: "turning speed about the z axis",
  quat_w: "the w number of the watch's orientation", quat_x: "the x number of the watch's orientation", quat_y: "the y number of the watch's orientation", quat_z: "the z number of the watch's orientation",
};

/**
 * The dataset's own columns as the network's inputs: tick the columns to feed it, and say how many steps of each it
 * reads. Each column at each step is one input neuron, so the count is columns times steps. With one step the network sees
 * the latest reading of each column, like a single row of the dataset.
 */
export function ColumnsDesigner({
  method, columns, onColumns, steps, onSteps, disabled,
}: {
  method: TrainMethod;
  columns: string[];
  onColumns: (next: string[]) => void;
  steps: number;
  onSteps: (steps: number) => void;
  disabled?: boolean;
}) {
  const convolutional = method === "cnn1d";
  const options: readonly number[] = convolutional ? CNN_STEPS : RAW_STEPS;
  const chosen = new Set(columns);
  const toggle = (name: string) => {
    const next = new Set(chosen);
    if (next.has(name)) {
      if (next.size > 1) next.delete(name); // never none
    } else next.add(name);
    onColumns(ALL_COLUMNS.filter((column) => next.has(column)));
  };
  const neurons = columns.length * steps;
  const byStream = new Map<InputStream, typeof DATASET_COLUMNS[number][]>();
  for (const column of DATASET_COLUMNS) byStream.set(column.stream, [...(byStream.get(column.stream) ?? []), column]);

  return (
    <fieldset className="flex flex-col gap-3" aria-label="Columns the network reads">
      <legend className="label">The columns the network reads</legend>
      <p className="field-hint">
        Each column of your recordings is one input. Tick the columns to feed the network; each one, at each step, is a neuron of the input layer.
      </p>
      <div className="max-w-full overflow-auto">
        <table className="border-collapse text-sm" aria-label="Dataset columns">
          <thead>
            <tr>
              {[...byStream.entries()].map(([stream, items]) => (
                <th key={stream} colSpan={items.length} scope="colgroup" className="border border-input px-2 py-1 text-left text-xs font-semibold text-muted-foreground">{STREAM_TITLES[stream]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {DATASET_COLUMNS.map((column) => (
                <td key={column.name} className="border border-input px-2 py-1" style={{ background: chosen.has(column.name) ? "rgba(255,210,63,0.45)" : undefined }} title={`Feed ${MEANING[column.name]} to the network`}>
                  <div className="flex items-center gap-1">
                    <Checkbox checked={chosen.has(column.name)} disabled={disabled} onCheckedChange={() => toggle(column.name)} aria-label={`Column ${column.name}`} />
                    <code className="whitespace-nowrap">{column.name}</code>
                  </div>
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="field">
        <div className="field-head"><Label htmlFor="columns-steps">{convolutional ? "Steps per column" : "Readings per column"}</Label></div>
        <select id="columns-steps" className={NATIVE_SELECT} value={steps} disabled={disabled} onChange={(event) => onSteps(Number(event.target.value))}>
          {options.map((count) => <option key={count} value={count}>{count === 1 ? "1 (the latest reading)" : `${count}`}</option>)}
        </select>
        <p className="field-hint">
          {convolutional
            ? "This many values, spread evenly across the window, are taken from each column, and the convolution layers slide along them."
            : steps === 1
              ? "One value from the window: the latest reading of each column, like one row of the dataset. The network has no memory of the moments before."
              : `${steps} readings spread evenly across the window, fed side by side: the network sees how each column moved over the window.`}
        </p>
      </div>
      <p className="text-sm" role="status" aria-label="Input layer size">
        {convolutional ? <>{columns.length} channel{columns.length === 1 ? "" : "s"} × {steps} steps: the convolution slides over them, so the first layer counts {columns.length} input channel{columns.length === 1 ? "" : "s"}.</> : (
          <><strong>{columns.length}</strong> column{columns.length === 1 ? "" : "s"} × <strong>{steps}</strong> reading{steps === 1 ? "" : "s"} = <strong>{neurons} input neuron{neurons === 1 ? "" : "s"}</strong>.</>
        )}
      </p>
    </fieldset>
  );
}

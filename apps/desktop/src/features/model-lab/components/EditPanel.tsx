import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { canFineTune, defaultFineTune, describeEdit, type Edit, type FineTune, type Selection } from "../edits";
import { Checkbox } from "../../../components/ui/checkbox";
import { describeInput } from "../featureInfo";
import { neuronOf, type Inspection } from "../inspection";

const MAX = 1e4;

/** The weight a selection points at, as the inspection recorded it. */
function currentValue(inspection: Inspection, selection: Selection): number | null {
  const { network } = inspection;
  if (selection.kind === "dense") {
    const layers = [...network.dense.map((layer) => layer.weights), network.output.weights];
    return layers[selection.layer]?.[selection.row]?.[selection.column] ?? null;
  }
  return network.conv[selection.layer]?.weights[selection.filter]?.[selection.channel]?.[selection.tap] ?? null;
}

/**
 * Change a trained model by hand: choose a weight (press a cell of a weights picture), say what it should be, and collect the
 * changes. Saving makes a new model from them: the original is never touched, and the new one is scored on the same
 * held-out windows before it can be used.
 */
export function EditPanel({
  inspection, selection, edits, onAdd, onRemove, onClearAll, onSave, saving, message, fineTune, onFineTune,
}: {
  inspection: Inspection;
  selection: Selection | null;
  edits: Edit[];
  onAdd: (edit: Edit) => void;
  onRemove: (index: number) => void;
  onClearAll: () => void;
  onSave: () => void;
  saving: boolean;
  message: string | null;
  /** Fine-tuning after the changes: null while off. */
  fineTune: FineTune | null;
  onFineTune: (next: FineTune | null) => void;
}) {
  const current = selection ? currentValue(inspection, selection) : null;
  const [text, setText] = useState("");
  useEffect(() => setText(current === null ? "" : String(current)), [selection, current]);
  const value = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(value) && Math.abs(value) <= MAX;
  const names = inspection.inputs.map((input) => input.name);
  const convolutional = inspection.network.kind === "conv";
  const denseLayers = inspection.network.dense.length + 1;
  const lastLayer = selection?.kind === "dense" && selection.layer === denseLayers - 1;

  let where = "";
  if (selection?.kind === "dense") {
    const steps = inspection.gridSteps ?? 1;
    const reading = inspection.inputKind === "columns" ? neuronOf(selection.row, steps) : null;
    const column = reading ? describeInput(names[reading.column] ?? "") : null;
    const from = selection.layer === 0 && reading && column
      ? `${column.group} ${column.short}${steps > 1 ? `, reading ${reading.step + 1}` : ""}`
      : selection.layer === 0 && !convolutional ? describeInput(names[selection.row] ?? "").short + ` of ${describeInput(names[selection.row] ?? "").group}` : `neuron ${selection.row + 1}`;
    where = `Dense layer ${selection.layer + 1}${lastLayer ? " (the output layer)" : ""}: from ${from} to neuron ${selection.column + 1}`;
  } else if (selection) {
    const channel = describeInput(names[selection.channel] ?? "");
    where = `Convolution layer ${selection.layer + 1}, filter ${selection.filter + 1}, ${channel.group} ${channel.short}, step ${selection.tap + 1}`;
  }

  return (
    <section aria-label="Edit this model" className="flex flex-col gap-3 rounded-lg border-2 border-foreground/70 p-3">
      <h3 className="text-base font-semibold">Edit this model</h3>
      <p className="field-hint">
        Press a cell of a weights picture to choose that weight, or tick an input in the table to switch it off. Saving makes a <strong>new model</strong> from your changes: the original stays exactly as it is, and the new one is scored on the same held-out windows, so you can see what the changes did before it can be used.
      </p>

      {selection ? (
        <div className="flex flex-col gap-2" role="group" aria-label="The chosen weight">
          <p className="text-sm"><strong>{where}</strong>. Now {current === null ? "unknown" : current}.</p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">New value
              <Input type="number" step="any" className="w-28" aria-label="New value" value={text} onChange={(event) => setText(event.target.value)} />
            </label>
            {selection.kind === "dense" ? (
              <>
                <Button type="button" size="sm" disabled={!valid} onClick={() => onAdd({ kind: "setWeight", layer: selection.layer, row: selection.row, column: selection.column, value })}>Set the weight</Button>
                <Button type="button" size="sm" variant="outline" disabled={!valid} onClick={() => onAdd({ kind: "setBias", layer: selection.layer, neuron: selection.column, value })}>Set the bias of neuron {selection.column + 1}</Button>
                {!lastLayer && <Button type="button" size="sm" variant="outline" onClick={() => onAdd({ kind: "silenceNeuron", layer: selection.layer, neuron: selection.column })}>Silence neuron {selection.column + 1}</Button>}
              </>
            ) : (
              <>
                <Button type="button" size="sm" disabled={!valid} onClick={() => onAdd({ kind: "setFilterWeight", layer: selection.layer, filter: selection.filter, channel: selection.channel, tap: selection.tap, value })}>Set this step</Button>
                <Button type="button" size="sm" variant="outline" onClick={() => onAdd({ kind: "silenceNeuron", layer: selection.layer, neuron: selection.filter, conv: true })}>Silence filter {selection.filter + 1}</Button>
              </>
            )}
          </div>
          {!valid && text.trim() !== "" && <p className="field-error" role="alert">That is not a number the model can take (up to {MAX} either way).</p>}
        </div>
      ) : (
        <p className="hint">No weight chosen yet.</p>
      )}

      <div className="flex flex-col gap-1">
        <h4 className="text-sm font-semibold">Changes waiting ({edits.length})</h4>
        {edits.length === 0 ? <p className="hint">None yet.</p> : (
          <ul className="flex flex-col gap-1 text-sm" aria-label="Changes waiting">
            {edits.map((edit, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2">
                <span>{describeEdit(edit, inspection)}</span>
                <Button type="button" variant="ghost" size="sm" aria-label={`Undo change ${index + 1}`} onClick={() => onRemove(index)}>Undo</Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <FineTuneControls inspection={inspection} fineTune={fineTune} onChange={onFineTune} />

      {message && <Alert role="status"><AlertDescription>{message}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={(edits.length === 0 && fineTune === null) || saving} onClick={onSave}>{saving ? "Starting…" : edits.length === 0 && fineTune !== null ? "Fine-tune as a new model" : "Save as a new model"}</Button>
        <Button type="button" variant="outline" disabled={(edits.length === 0 && fineTune === null) || saving} onClick={onClearAll}>Discard all changes</Button>
      </div>
    </section>
  );
}

/** Carry on training the edited model for a few rounds, with chosen layers frozen and the weights set by hand held where they were put. */
function FineTuneControls({ inspection, fineTune, onChange }: { inspection: Inspection; fineTune: FineTune | null; onChange: (next: FineTune | null) => void }) {
  const possible = canFineTune(inspection.backend);
  const convLayers = inspection.network.conv.length;
  const denseLayers = inspection.network.dense.length + 1;
  const toggleFrozen = (key: "freezeConv" | "freezeDense", index: number) => {
    if (!fineTune) return;
    const now = fineTune[key];
    onChange({ ...fineTune, [key]: now.includes(index) ? now.filter((i) => i !== index) : [...now, index].sort() });
  };
  const everyLayerFrozen = fineTune !== null && fineTune.freezeConv.length === convLayers && fineTune.freezeDense.length === denseLayers;
  return (
    <div className="flex flex-col gap-2" role="group" aria-label="Fine-tune">
      <div className="flex items-start gap-2 text-sm">
        <Checkbox checked={fineTune !== null} disabled={!possible} onCheckedChange={() => onChange(fineTune === null ? defaultFor(inspection.backend) : null)} aria-label="Fine-tune after these changes" />
        <span>
          <strong>Fine-tune after these changes</strong>{" "}
          <small className="text-muted-foreground">
            {possible
              ? "Carry on training the model for a few rounds from the weights it has, on the same training recordings. Weights you set by hand stay where you put them, and frozen layers do not move. Without changes, this just trains the model a little more."
              : "Needs one of the PyTorch methods: the scikit-learn ones cannot carry on training from changed weights."}
          </small>
        </span>
      </div>
      {fineTune && (
        <div className="ml-7 flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-sm">Rounds
              <Input type="number" className="w-24" aria-label="Fine-tuning rounds" min={1} max={500} value={fineTune.epochs} onChange={(event) => onChange({ ...fineTune, epochs: Math.min(500, Math.max(1, Math.round(Number(event.target.value) || 1))) })} />
            </label>
            <label className="flex items-center gap-2 text-sm">Learning rate
              <Input type="number" className="w-28" step="0.0005" aria-label="Fine-tuning learning rate" min={0.00001} max={0.1} value={fineTune.learningRate} onChange={(event) => onChange({ ...fineTune, learningRate: Math.min(0.1, Math.max(0.00001, Number(event.target.value) || 0.001)) })} />
            </label>
          </div>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <legend className="label">Freeze (these layers do not change)</legend>
            {Array.from({ length: convLayers }, (_, i) => (
              <span key={`c${i}`} className="inline-flex items-center gap-1"><Checkbox checked={fineTune.freezeConv.includes(i)} onCheckedChange={() => toggleFrozen("freezeConv", i)} aria-label={`Freeze convolution layer ${i + 1}`} />Convolution layer {i + 1}</span>
            ))}
            {Array.from({ length: denseLayers }, (_, i) => (
              <span key={`d${i}`} className="inline-flex items-center gap-1"><Checkbox checked={fineTune.freezeDense.includes(i)} onCheckedChange={() => toggleFrozen("freezeDense", i)} aria-label={`Freeze dense layer ${i + 1}`} />{i === denseLayers - 1 ? "Output layer" : `Dense layer ${i + 1}`}</span>
            ))}
          </fieldset>
          {everyLayerFrozen && <p className="field-error" role="alert">Every layer is frozen, so there is nothing to train.</p>}
        </div>
      )}
    </div>
  );
}

const defaultFor = (backend: string): FineTune => defaultFineTune(backend);

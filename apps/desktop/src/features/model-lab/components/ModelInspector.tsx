import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { addEdit, type Edit, type FineTune, type Selection } from "../edits";
import type { LabelModel } from "../labelModels";
import type { ModelInspectionView } from "../inspection";
import { SPIKE_METHODS } from "../training";
import { EditPanel } from "./EditPanel";
import { DeclaredInputs, InspectInputs } from "./InspectInputs";
import { InspectEvaluation } from "./InspectEvaluation";
import { InspectResearch } from "./InspectResearch";
import { InspectWeights } from "./InspectWeights";
import { InspectWindows } from "./InspectWindows";
import { TrainingCurve } from "./TrainingCurve";

const METHOD_NAMES: Record<string, string> = {
  logreg: "Logistic regression",
  mlp: "Small neural network (scikit-learn)",
  "torch-mlp": "Small neural network (PyTorch)",
  cnn1d: "1D convolutional network (PyTorch)",
};

/** What was changed to make this model, and how the changes moved its score on the same held-out windows. */
function EditedFrom({ inspection }: { inspection: NonNullable<ModelInspectionView["inspection"]> }) {
  const edit = inspection.edit;
  if (!edit) return null;
  const rate = (metrics: Record<string, unknown> | null | undefined, key: string) => (metrics && typeof metrics[key] === "number" ? (metrics[key] as number).toFixed(3) : "–");
  return (
    <section aria-label="Edited from another model" className="flex flex-col gap-2 rounded-lg border border-input p-3">
      <h3 className="text-base font-semibold">Edited from {edit.fromModel ?? "another model"}</h3>
      <ul className="flex flex-col gap-1 text-sm" aria-label="What was changed">
        {edit.said.map((line) => <li key={line}>{line}</li>)}
      </ul>
      <table className="text-sm" aria-label="Before and after the changes">
        <caption className="caption-top text-left text-xs text-muted-foreground">On the same held-out windows, each at its own cut-off</caption>
        <thead><tr className="text-left"><th /><th className="px-2">ROC AUC</th><th className="px-2">F1</th><th className="px-2">Recall</th><th className="px-2">Precision</th><th className="px-2">False alarms</th></tr></thead>
        <tbody>
          {([["Before", edit.before], ["After", edit.after]] as const).map(([name, metrics]) => (
            <tr key={name}><th scope="row" className="pr-2 text-left">{name}</th><td className="px-2">{rate(metrics, "rocAuc")}</td><td className="px-2">{rate(metrics, "f1")}</td><td className="px-2">{rate(metrics, "recall")}</td><td className="px-2">{rate(metrics, "precision")}</td><td className="px-2">{rate(metrics, "falseActivationRate")}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Looks inside one model: its inputs, weights, what it does with real windows, and how it learned. */
export function ModelInspector({ id, onClose, models = [] }: { id: string; onClose: () => void; /** The registered models, to offer another of the same label to compare with. */ models?: LabelModel[] }) {
  const [view, setView] = useState<ModelInspectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareId, setCompareId] = useState("");
  const [compare, setCompare] = useState<ModelInspectionView | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Edit[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [saving, setSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<string | null>(null);
  const [fineTune, setFineTune] = useState<FineTune | null>(null);

  useEffect(() => {
    let stale = false;
    setView(null);
    setError(null);
    void (async () => {
      try {
        const next = await invoke<ModelInspectionView>("inspect_label_model", { id });
        if (!stale) setView(next);
      } catch (err) {
        if (!stale) setError(String(err));
      }
    })();
    return () => { stale = true; };
  }, [id]);

  useEffect(() => {
    setCompareId("");
    setEditing(false);
    setEdits([]);
    setSelection(null);
    setEditMessage(null);
    setFineTune(null);
  }, [id]);
  useEffect(() => {
    let stale = false;
    setCompare(null);
    setCompareError(null);
    if (compareId === "") return;
    void (async () => {
      try {
        const next = await invoke<ModelInspectionView>("inspect_label_model", { id: compareId });
        if (!stale) setCompare(next);
      } catch (err) {
        if (!stale) setCompareError(String(err));
      }
    })();
    return () => { stale = true; };
  }, [compareId]);

  const saveEdits = async () => {
    setSaving(true);
    setEditMessage(null);
    try {
      await invoke("start_label_edit", { id, edits, ...(fineTune ? { fineTune } : {}) });
      setEditMessage(`Started. The ${fineTune ? "fine-tuned" : "edited"} model is being scored and will appear as a new draft under Label models when it is done; the progress is under Train a model.`);
      setEdits([]);
      setFineTune(null);
      setSelection(null);
    } catch (err) {
      setEditMessage(String(err));
    } finally {
      setSaving(false);
    }
  };
  const switchedOff = new Set(edits.flatMap((edit) => (edit.kind === "disableInput" ? [edit.input] : [])));
  const toggleInput = (name: string) => setEdits((previous) => (switchedOff.has(name) ? previous.filter((edit) => !(edit.kind === "disableInput" && edit.input === name)) : addEdit(previous, { kind: "disableInput", input: name })));

  const emphasis = new Map(edits.flatMap((edit) => (edit.kind === "scaleInput" ? [[edit.input, edit.factor] as [string, number]] : [])));
  const emphasise = (name: string, factor: number) => setEdits((previous) => (factor === 1 ? previous.filter((edit) => !(edit.kind === "scaleInput" && edit.input === name)) : addEdit(previous, { kind: "scaleInput", input: name, factor })));

  const inspection = view?.inspection ?? null;
  const sameLabel = view ? models.filter((model) => model.label === view.label && model.id !== view.id) : [];
  const manifestInput = (view?.manifest?.input ?? {}) as { features?: unknown };
  const spikeMethod = inspection?.spikeMethod ?? ((view?.manifest?.preprocessing as { method?: string } | undefined)?.method ?? null);
  const spikeLabel = spikeMethod ? SPIKE_METHODS.find((option) => option.value === spikeMethod)?.label ?? spikeMethod : undefined;
  const backend = inspection?.backend ?? (view?.manifest?.provenance as { backend?: string } | undefined)?.backend ?? "";
  const auc = inspection?.evaluation.metrics.rocAuc;

  return (
    <Card id="lab-inspect" role="region" aria-label={`Inspect ${id}`} className="min-w-0">
      <CardHeader>
        <SectionHeader
          title={view ? `Inspect: ${view.label}` : "Inspect a model"}
          description={view ? `${view.id} · ${view.origin === "trained" ? "trained in this app" : "imported"}` : "Loading…"}
          status={
            <div className="flex items-center gap-2">
              {inspection && view?.origin === "trained" && (
                <Button type="button" variant={editing ? "default" : "outline"} aria-pressed={editing} onClick={() => setEditing((value) => !value)}>
                  {editing ? "Stop editing" : "Edit this model"}
                </Button>
              )}
              <Button type="button" variant="outline" onClick={onClose}>Close</Button>
            </div>
          }
          help={{
            label: "About inspecting a model",
            content: "Everything here is what the model really does. The weights are read from the model, and every number computed from them was checked against the model itself. The windows and the importance come from the recordings the model was tested on, never the ones it trained on.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        {!view && !error && <p className="hint" role="status">Loading the model…</p>}
        {view && !inspection && (
          <>
            <Alert role="note"><AlertDescription>
              {view.origin === "imported"
                ? "This model was imported, so the app has only what it declares: its inputs and settings. The weights and how it did on test windows are not available."
                : "This model was trained before inspections were saved, or its inspection could not be made, so only what it declares is shown. Train it again to see its weights."}
            </AlertDescription></Alert>
            <DeclaredInputs names={asStrings(manifestInput.features)} spikeLabel={spikeLabel} />
          </>
        )}
        {inspection && (
          <>
            <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Model summary">
              <Badge variant="outline">{METHOD_NAMES[backend] ?? backend}</Badge>
              <Badge variant="outline">{inspection.inputKind === "columns" ? `${inspection.inputs.length} columns × ${inspection.gridSteps ?? 1} reading${(inspection.gridSteps ?? 1) === 1 ? "" : "s"} = ${inspection.inputs.length * (inspection.gridSteps ?? 1)} input neurons` : `${inspection.inputs.length} ${inspection.inputKind === "channels" ? "channels" : "inputs"}`}</Badge>
              {inspection.parameters !== null && <Badge variant="outline">{inspection.parameters.toLocaleString("en-US")} parameters</Badge>}
              {typeof auc === "number" && <Badge variant="outline">Held-out ROC AUC {auc.toFixed(2)}</Badge>}
              {inspection.spikeMethod && <Badge variant="outline">Spikes: {spikeLabel}</Badge>}
              {inspection.centreWindows && <Badge variant="outline">Window average taken away</Badge>}
            </div>
            {sameLabel.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-sm">
                  Compare with
                  <select className="recipe-select" aria-label="Compare with another model" value={compareId} onChange={(event) => setCompareId(event.target.value)}>
                    <option value="">No other model</option>
                    {sameLabel.map((model) => <option key={model.id} value={model.id}>{model.id} ({model.state})</option>)}
                  </select>
                </label>
                {compareError && <span className="field-error" role="alert">{compareError}</span>}
                {compare && !compare.inspection && <span className="hint" role="status">{compare.id} has no saved inspection, so there is nothing to compare.</span>}
              </div>
            )}
            <InspectEvaluation inspection={inspection} other={compare?.inspection ?? null} otherName={compare?.id} />
            {inspection.edit && <EditedFrom inspection={inspection} />}
            <InspectResearch inspection={inspection} />
            <InspectInputs inspection={inspection} spikeLabel={spikeLabel} editing={editing} switchedOff={switchedOff} onToggleInput={toggleInput} emphasis={emphasis} onEmphasis={emphasise} />
            <InspectWeights inspection={inspection} editing={editing} selection={selection} onSelect={setSelection} />
            {editing && (
              <EditPanel
                inspection={inspection} selection={selection} edits={edits} saving={saving} message={editMessage}
                onAdd={(edit) => setEdits((previous) => addEdit(previous, edit))}
                onRemove={(index) => setEdits((previous) => previous.filter((_, i) => i !== index))}
                onClearAll={() => { setEdits([]); setSelection(null); setFineTune(null); }}
                fineTune={fineTune} onFineTune={setFineTune}
                onSave={() => void saveEdits()}
              />
            )}
            <InspectWindows inspection={inspection} spikeLabel={spikeLabel} />
            {inspection.curve.length > 0 && (
              <section aria-label="How it learned" className="flex flex-col gap-2">
                <h3 className="text-base font-semibold">How it learned</h3>
                <TrainingCurve points={inspection.curve} />
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { ModelInspectionView } from "../inspection";
import { SPIKE_METHODS } from "../training";
import { DeclaredInputs, InspectInputs } from "./InspectInputs";
import { InspectWeights } from "./InspectWeights";
import { InspectWindows } from "./InspectWindows";
import { TrainingCurve } from "./TrainingCurve";

const METHOD_NAMES: Record<string, string> = {
  logreg: "Logistic regression",
  mlp: "Small neural network (scikit-learn)",
  "torch-mlp": "Small neural network (PyTorch)",
  cnn1d: "1D convolutional network (PyTorch)",
};

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Looks inside one model: its inputs, weights, what it does with real windows, and how it learned. */
export function ModelInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const [view, setView] = useState<ModelInspectionView | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const inspection = view?.inspection ?? null;
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
          status={<Button type="button" variant="outline" onClick={onClose}>Close</Button>}
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
              <Badge variant="outline">{inspection.inputs.length} {inspection.inputKind === "channels" ? "channels" : "inputs"}</Badge>
              {inspection.parameters !== null && <Badge variant="outline">{inspection.parameters.toLocaleString("en-US")} parameters</Badge>}
              {typeof auc === "number" && <Badge variant="outline">Held-out ROC AUC {auc.toFixed(2)}</Badge>}
              {inspection.spikeMethod && <Badge variant="outline">Spikes: {spikeLabel}</Badge>}
              {inspection.centreWindows && <Badge variant="outline">Window average taken away</Badge>}
            </div>
            <InspectInputs inspection={inspection} spikeLabel={spikeLabel} />
            <InspectWeights inspection={inspection} />
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

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import type { LabelModel } from "../labelModels";
import { currentInspection, type ModelInspectionView } from "../inspection";
import { PULSE_MODEL } from "../training";
import { DeclaredInputs, InspectInputs } from "./InspectInputs";
import { InspectEvaluation } from "./InspectEvaluation";
import { InspectResearch } from "./InspectResearch";

const asStrings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Looks inside one model: what it reads, what it leans on, and how well it works on recordings it never trained on. */
export function ModelInspector({ id, onClose, models = [] }: { id: string; onClose: () => void; /** The registered models, to offer another of the same label to compare with. */ models?: LabelModel[] }) {
  const [view, setView] = useState<ModelInspectionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compareId, setCompareId] = useState("");
  const [compare, setCompare] = useState<ModelInspectionView | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setView(null);
    setError(null);
    setCompareId("");
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

  const inspection = currentInspection(view?.inspection);
  const other = currentInspection(compare?.inspection);
  const sameLabel = view ? models.filter((model) => model.label === view.label && model.id !== view.id) : [];
  const manifestInput = (view?.manifest?.input ?? {}) as { features?: unknown };
  const monitorOnly = models.find((model) => model.id === id)?.monitorOnly ?? false;
  const auc = inspection?.evaluation.metrics.rocAuc;
  // Models trained before motion read the pulse alone.
  const readsMotion = inspection?.sources?.includes("watchOrientation") ?? false;

  return (
    <Card id="lab-inspect" role="region" aria-label={`Inspect ${id}`} className="min-w-0">
      <CardHeader>
        <SectionHeader
          title={view ? `Inspect: ${view.label}` : "Inspect a model"}
          description={view ? `${view.id} · ${view.origin === "trained" ? "trained in this app" : "imported"}` : "Loading…"}
          status={<Button type="button" variant="outline" onClick={onClose}>Close</Button>}
          help={{
            label: "About inspecting a model",
            content: "Everything here comes from the recordings the model was tested on, never the ones it trained on: every score is one the model gave a moment it had not seen.",
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
                ? "This model was imported, so the app has only what it declares: its inputs and settings. How it did on test recordings is not available."
                : "This model's inspection could not be made, so only what it declares is shown."}
            </AlertDescription></Alert>
            <DeclaredInputs names={asStrings(manifestInput.features)} />
          </>
        )}
        {inspection && (
          <>
            <div className="flex flex-wrap items-center gap-2" role="status" aria-label="Model summary">
              <Badge variant="outline">{readsMotion ? PULSE_MODEL.name : "PPG pinch-start model"}</Badge>
              <Badge variant="outline">{inspection.inputCount.toLocaleString("en-US")} {readsMotion ? "pulse and motion" : "pulse"} inputs · {inspection.trees} trees{readsMotion ? " · fires on the peak" : ""}</Badge>
              <Badge variant="outline">Trained on {inspection.examples.trainStarts} starts among {inspection.examples.train.toLocaleString("en-US")} moments</Badge>
              {typeof auc === "number" && <Badge variant="outline">Held-out ROC AUC {auc.toFixed(2)}</Badge>}
              {monitorOnly && <Badge variant="secondary">Monitor only</Badge>}
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
                {compare && !other && <span className="hint" role="status">{compare.id} has no saved inspection, so there is nothing to compare.</span>}
              </div>
            )}
            <InspectEvaluation inspection={inspection} other={other} otherName={compare?.id} />
            <InspectResearch inspection={inspection} />
            <InspectInputs inspection={inspection} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

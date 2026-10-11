import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import { Label } from "../../../components/ui/label";
import { describePlan, type FineTunePlan } from "../fineTunePlans";
import { datasetLabels, inImportOrder, recordingNumber, type DatasetSummary } from "../types";

/** What a model was trained from (see `ModelTrainingInfo` in label_training.rs). */
export interface ModelTrainingInfo {
  label: string;
  backend: string;
  negatives: string[];
  excludes: string[];
  datasetIds: string[];
  trainOnly: string[];
  designId: string | null;
}

export const EXTRA_WEIGHTS = [1, 2, 3, 5, 10] as const;

/** Why a recording cannot be added to a model's fine-tune, or null: its labels must all have a role the model was trained with. */
export function extraBlocker(dataset: DatasetSummary, info: ModelTrainingInfo): string | null {
  const known = new Set([info.label, ...info.negatives, ...info.excludes]);
  const unknown = datasetLabels(dataset).filter((label) => !known.has(label));
  return unknown.length === 0 ? null : `It has ${unknown.map((l) => `“${l}”`).join(", ")}, which this model was not trained with a role for.`;
}

/**
 * Carry on training one model with a saved plan, optionally on extra recordings (such as ones where it misfired, recorded
 * with the camera marking the truth). The extra recordings only train: the model is still tested on the recordings it was
 * always tested on, so the score before and after can be compared. The result is a new draft; the original is untouched.
 */
export function FineTuneModel({
  modelId, datasets = [], initialExtras = [], refreshKey = "", onClose, onOpenNetworkLab, children,
}: {
  modelId: string;
  datasets?: DatasetSummary[];
  /** Recordings ticked from the start (for example one just made as corrections). */
  initialExtras?: string[];
  /** Changes when more recordings arrive, so the list reloads. */
  refreshKey?: string;
  onClose: () => void;
  onOpenNetworkLab?: () => void;
  /** Shown between the plan and the recordings: where the correction session is. */
  children?: (info: ModelTrainingInfo | null, addExtra: (id: string) => void) => React.ReactNode;
}) {
  const uid = useId();
  const [plans, setPlans] = useState<FineTunePlan[]>([]);
  const [planId, setPlanId] = useState("");
  const [info, setInfo] = useState<ModelTrainingInfo | null>(null);
  const [extras, setExtras] = useState<string[]>(initialExtras);
  const [weight, setWeight] = useState<number>(3);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void invoke<FineTunePlan[]>("list_fine_tune_plans")
      .then((list) => {
        const all = Array.isArray(list) ? list : [];
        setPlans(all);
        setPlanId((current) => current || all[0]?.id || "");
      })
      .catch((err) => setError(String(err)));
  }, []);
  useEffect(() => {
    void invoke<ModelTrainingInfo>("get_model_training_info", { id: modelId })
      .then((found) => setInfo(found ?? null))
      .catch(() => setInfo(null)); // an imported model has none; the panel then offers no extra recordings
  }, [modelId, refreshKey]);

  const plan = plans.find((p) => p.id === planId) ?? null;
  const taken = new Set([...(info?.datasetIds ?? []), ...(info?.trainOnly ?? [])]);
  const offered = inImportOrder(datasets.filter((d) => info !== null && !taken.has(d.id)));
  const chosen = extras.filter((id) => offered.some((d) => d.id === id));
  const toggle = (id: string) => setExtras((current) => (current.includes(id) ? current.filter((e) => e !== id) : [...current, id]));
  const addExtra = (id: string) => setExtras((current) => (current.includes(id) ? current : [...current, id]));

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await invoke<string>("start_label_fine_tune", { id: modelId, planId, extraDatasetIds: chosen, extraWeight: chosen.length > 0 || (info?.trainOnly.length ?? 0) > 0 ? weight : null });
      onClose(); // progress and the result show under Train a model
    } catch (err) {
      setError(String(err));
    } finally {
      setStarting(false);
    }
  };

  return (
    <section aria-label={`Fine-tune ${modelId}`} className="flex flex-col gap-3 rounded-lg border border-input p-3">
      <div className="field">
        <div className="field-head"><Label htmlFor={`${uid}-plan`}>Fine-tune plan</Label></div>
        <select id={`${uid}-plan`} className="recipe-select" value={planId} disabled={starting} onChange={(event) => setPlanId(event.target.value)}>
          {plans.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
        {plan && <p className="field-hint">{plan.description ? `${plan.description} ` : ""}{describePlan(plan)}</p>}
        <p className="field-hint">
          Carries on training {modelId} and saves the result as a new draft, scored on the same held-out windows, with the score before and after. Make plans in the{" "}
          {onOpenNetworkLab ? <Button type="button" variant="link" className="h-auto p-0" onClick={onOpenNetworkLab}>Network lab</Button> : "Network lab"}.
        </p>
      </div>

      {children?.(info, addExtra)}

      {info !== null && (
        <fieldset className="flex flex-col gap-2" disabled={starting}>
          <legend className="label">Extra recordings to learn from</legend>
          {info.trainOnly.length > 0 && <p className="field-hint">{info.trainOnly.length} extra recording{info.trainOnly.length === 1 ? " was" : "s were"} already added to this model and {info.trainOnly.length === 1 ? "is" : "are"} used again.</p>}
          {offered.length === 0 ? (
            <p className="field-hint">No other recordings in Model Lab. Record some where the model gets it wrong (with camera marking on), add them to the training data, and they appear here.</p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Extra recordings">
              {offered.map((dataset) => {
                const blocker = extraBlocker(dataset, info);
                return (
                  <li key={dataset.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Checkbox checked={chosen.includes(dataset.id)} disabled={blocker !== null} onCheckedChange={() => toggle(dataset.id)} aria-label={`Also learn from ${dataset.originalFilename}`} />
                    <span>{dataset.sequence ? <strong className="mr-2 font-mono">{recordingNumber(dataset)}</strong> : null}{dataset.originalFilename}</span>
                    <small className="text-muted-foreground">{datasetLabels(dataset).join(", ")}</small>
                    {blocker && <small className="text-muted-foreground">{blocker}</small>}
                  </li>
                );
              })}
            </ul>
          )}
          {(chosen.length > 0 || info.trainOnly.length > 0) && (
            <div className="field">
              <div className="field-head"><Label htmlFor={`${uid}-weight`}>How much the extra recordings count</Label></div>
              <select id={`${uid}-weight`} className="recipe-select" value={weight} onChange={(event) => setWeight(Number(event.target.value))}>
                {EXTRA_WEIGHTS.map((value) => <option key={value} value={value}>{value === 1 ? "The same as the rest (1×)" : `${value}× as much as the rest`}</option>)}
              </select>
              <p className="field-hint">What the model gets wrong on these recordings is penalised this many times harder. They only train: the model is still tested on the recordings it was always tested on, so the before and after scores can be compared. A few recordings counted heavily can make a model memorise them; check the held-out score afterwards.</p>
            </div>
          )}
        </fieldset>
      )}

      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={starting || plan === null} onClick={() => void start()}>{starting ? "Starting…" : "Start fine-tuning"}</Button>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </section>
  );
}

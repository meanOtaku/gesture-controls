import { invoke } from "@tauri-apps/api/core";
import { useEffect, useId, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Label } from "../../../components/ui/label";
import { describePlan, type FineTunePlan } from "../fineTunePlans";

/** Carry on training one model with a saved plan. The result is a new draft; the original is untouched. */
export function FineTuneModel({ modelId, onClose, onOpenNetworkLab }: { modelId: string; onClose: () => void; onOpenNetworkLab?: () => void }) {
  const uid = useId();
  const [plans, setPlans] = useState<FineTunePlan[]>([]);
  const [planId, setPlanId] = useState("");
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

  const plan = plans.find((p) => p.id === planId) ?? null;
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await invoke<string>("start_label_fine_tune", { id: modelId, planId });
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
          Carries on training {modelId} on the recordings it was trained on and saves the result as a new draft, scored on the same held-out windows, with the score before and after. Make plans in the{" "}
          {onOpenNetworkLab ? <Button type="button" variant="link" className="h-auto p-0" onClick={onOpenNetworkLab}>Network lab</Button> : "Network lab"}.
        </p>
      </div>
      {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={starting || plan === null} onClick={() => void start()}>{starting ? "Starting…" : "Start fine-tuning"}</Button>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
      </div>
    </section>
  );
}

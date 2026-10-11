import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { Label } from "../../../components/ui/label";
import { FREEZE_OPTIONS, describePlan, duplicatePlan, newPlan, type FineTunePlan, type FreezeMode } from "../fineTunePlans";

/**
 * Fine-tune plans: how a trained model is carried on training (rounds, step size, what stays as it is). A plan says nothing
 * about which model; it is chosen when a model is fine-tuned from Model Lab.
 */
export function FineTunePlans({ desktopAvailable }: { desktopAvailable: boolean }) {
  const uid = useId();
  const [plans, setPlans] = useState<FineTunePlan[]>([]);
  const [draft, setDraft] = useState<FineTunePlan | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const load = useCallback(async (next?: FineTunePlan[]) => {
    try {
      const list = next ?? (await invoke<FineTunePlan[]>("list_fine_tune_plans"));
      setPlans(Array.isArray(list) ? list : []);
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useEffect(() => {
    if (desktopAvailable) void load();
  }, [desktopAvailable, load]);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      await load(await invoke<FineTunePlan[]>("save_fine_tune_plan", { plan: draft }));
      setDraft(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    try {
      await load(await invoke<FineTunePlan[]>("delete_fine_tune_plan", { id }));
      setConfirmDelete(null);
      if (draft?.id === id) setDraft(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const locked = draft?.builtIn === true;
  const set = (patch: Partial<FineTunePlan>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  return (
    <Card id="lab-plans" role="region" aria-label="Fine-tune plans" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Fine-tune plans"
          description="How a trained model is carried on training: how long, how fast, what stays as it is."
          status={<Button type="button" disabled={!desktopAvailable || draft !== null} onClick={() => { setDraft(newPlan()); setError(null); }}>New plan</Button>}
          help={{ label: "About fine-tune plans", content: "A plan is a named set of fine-tuning settings: the number of rounds, the step size (blank means a third of the step the model was trained at) and whether every layer but the output layer is kept as it is. Pick one under Model Lab > Label models > Fine-tune. Only the two PyTorch methods can be fine-tuned. The result is a new model with the score before and after; the original is untouched." }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && draft === null && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
        <ul className="flex flex-col gap-3" aria-label="Plans">
          {plans.map((plan) => (
            <li key={plan.id} className="flex flex-col gap-1 rounded-lg border border-input p-3">
              <div className="flex flex-wrap items-center gap-2">
                <strong>{plan.name}</strong>
                {plan.builtIn && <Badge variant="secondary">Built in</Badge>}
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="outline" aria-label={`${plan.builtIn ? "View" : "Edit"} plan ${plan.name}`} onClick={() => { setDraft(plan); setError(null); }}>{plan.builtIn ? "View" : "Edit"}</Button>
                  <Button type="button" size="sm" variant="outline" aria-label={`Duplicate plan ${plan.name}`} disabled={draft !== null} onClick={() => { setDraft(duplicatePlan(plan)); setError(null); }}>Duplicate</Button>
                  {!plan.builtIn && (confirmDelete === plan.id ? (
                    <>
                      <Button type="button" size="sm" variant="destructive" aria-label={`Delete plan ${plan.name} for good`} onClick={() => void remove(plan.id)}>Delete for good</Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>Keep</Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="ghost" aria-label={`Delete plan ${plan.name}`} onClick={() => setConfirmDelete(plan.id)}>Delete</Button>
                  ))}
                </div>
              </div>
              {plan.description && <p className="text-sm">{plan.description}</p>}
              <p className="text-xs text-muted-foreground">{describePlan(plan)}</p>
            </li>
          ))}
          {plans.length === 0 && <li className="hint">No plans yet.</li>}
        </ul>
        {draft && (
          <section aria-label={locked ? `Plan: ${draft.name}` : "Edit the plan"} className="flex flex-col gap-4 rounded-lg border-2 border-foreground/70 p-3">
            <h3 className="text-base font-semibold">{locked ? draft.name : draft.id === "" ? "New plan" : `Edit: ${draft.name}`}</h3>
            {locked && <Alert role="note"><AlertDescription>This plan comes with the app and cannot be changed. Use Duplicate on it to make a copy you can change.</AlertDescription></Alert>}
            <fieldset className="flex flex-col gap-4" disabled={locked || saving}>
              <div className="field">
                <div className="field-head"><Label htmlFor={`${uid}-name`} required>Plan name</Label></div>
                <Input id={`${uid}-name`} value={draft.name} maxLength={40} onChange={(event) => set({ name: event.target.value })} />
              </div>
              <div className="field">
                <div className="field-head"><Label htmlFor={`${uid}-desc`}>Plan description</Label></div>
                <Input id={`${uid}-desc`} value={draft.description} maxLength={300} onChange={(event) => set({ description: event.target.value })} />
              </div>
              <div className="field">
                <div className="field-head"><Label htmlFor={`${uid}-epochs`}>Rounds</Label></div>
                <Input id={`${uid}-epochs`} type="number" className="w-28" min={1} max={500} value={draft.epochs} onChange={(event) => set({ epochs: Math.min(500, Math.max(1, Math.round(Number(event.target.value) || 1))) })} />
              </div>
              <div className="field">
                <div className="field-head"><Label htmlFor={`${uid}-rate`}>Learning rate (blank: a third of the training rate)</Label></div>
                <Input id={`${uid}-rate`} type="number" className="w-32" step="0.0005" min={0.00001} max={0.1} value={draft.learningRate ?? ""} onChange={(event) => set({ learningRate: event.target.value === "" ? null : Math.min(0.1, Math.max(0.00001, Number(event.target.value) || 0.001)) })} />
              </div>
              <div className="field">
                <div className="field-head"><Label htmlFor={`${uid}-freeze`}>Keep as it is</Label></div>
                <select id={`${uid}-freeze`} className="recipe-select" value={draft.freeze} onChange={(event) => set({ freeze: event.target.value as FreezeMode })}>
                  {FREEZE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </div>
            </fieldset>
            {error && <Alert variant="destructive" role="alert"><AlertDescription>{error}</AlertDescription></Alert>}
            <div className="flex flex-wrap gap-2">
              {!locked && <Button type="button" disabled={saving || draft.name.trim() === ""} onClick={() => void save()}>{saving ? "Saving…" : "Save plan"}</Button>}
              <Button type="button" variant="outline" onClick={() => { setDraft(null); setError(null); }}>{locked ? "Close" : "Cancel"}</Button>
            </div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { appNavigation } from "../../../shared/navigation/appNavigation";
import { listRecordingBundles, onRecordingsChanged } from "../../../shared/tauri/recordingBundle";
import type { DatasetSummary } from "../../model-lab/types";
import { workflowSteps, type WorkflowStep } from "../workflow";

/**
 * Making a model, step by step: record, label, clean, train, and the final test, with where each stands and the way to
 * the next. Read from what the app already has; nothing here changes it.
 */
export function ModelWorkflowCard() {
  const [steps, setSteps] = useState<WorkflowStep[] | null>(null);
  const [firstUnreviewed, setFirstUnreviewed] = useState<string | null>(null);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const load = async () => {
      const [bundles, datasets, models, tests] = await Promise.all([
        listRecordingBundles().then((result) => (result.status === "ok" && Array.isArray(result.value) ? result.value.length : 0)).catch(() => 0),
        invoke<DatasetSummary[]>("list_model_datasets").catch(() => []),
        invoke<unknown[]>("list_label_models").catch(() => []),
        invoke<unknown[]>("list_sealed_tests").catch(() => []),
      ]);
      const list = Array.isArray(datasets) ? datasets : [];
      setFirstUnreviewed(list.find((dataset) => !dataset.review)?.id ?? null);
      setSteps(workflowSteps({ recorderRecordings: bundles, datasets: list, models: Array.isArray(models) ? models.length : 0, finalTests: Array.isArray(tests) ? tests.length : 0 }));
    };
    void load();
    return onRecordingsChanged(() => void load());
  }, []);
  if (!steps) return null;
  const next = steps.findIndex((step) => !step.complete);
  const go = (step: WorkflowStep) => {
    if (step.key === "label" && firstUnreviewed) appNavigation.openInLabelling({ datasetId: firstUnreviewed, atMs: 0 });
    else appNavigation.open(step.tab);
  };
  return (
    <Card role="region" aria-label="Making a model">
      <CardHeader>
        <SectionHeader
          title="Making a model"
          description="Record, label, clean, train, then test on a day the model has never seen."
          status={<Badge variant="secondary">{steps.filter((step) => step.complete).length} / {steps.length}</Badge>}
        />
      </CardHeader>
      <CardContent>
        <ol className="setup-steps">
          {steps.map((step, index) => (
            <li key={step.key} data-complete={step.complete} aria-current={index === next ? "step" : undefined}>
              <span className="step-number">{step.complete ? "✓" : String(index + 1)}</span>
              <div><strong>{step.title}{index === next ? " (next)" : ""}</strong><p>{step.status}</p></div>
              <Button type="button" variant={index === next ? "default" : "outline"} onClick={() => go(step)}>{step.key === "label" && firstUnreviewed ? "Label the next →" : step.action}</Button>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

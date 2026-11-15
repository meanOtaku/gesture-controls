import { AnimatedNumber } from "../../../components/app/AnimatedNumber";
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
 * Making a model: record, label, clean, train, and the final test. Says only the next step, where it stands and the way
 * to it, with how many are done. Read from what the app already has; nothing here changes it.
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
  const step = next === -1 ? null : steps[next];
  return (
    <Card role="region" aria-label="Making a model">
      <CardHeader>
        <SectionHeader
          title="Making a model"
          description="Record, label, clean, train, then test on a day the model has never seen."
          status={<Badge variant="secondary">{<AnimatedNumber value={steps.filter((done) => done.complete).length} />} / {<AnimatedNumber value={steps.length} />}</Badge>}
        />
      </CardHeader>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
        {step ? (
          <>
            <span className="text-sm"><strong>Next: {step.title}.</strong> {step.status}</span>
            <Button type="button" onClick={() => go(step)}>{step.key === "label" && firstUnreviewed ? "Label the next →" : step.action}</Button>
          </>
        ) : (
          <span className="text-sm">Every step is done.</span>
        )}
      </CardContent>
    </Card>
  );
}

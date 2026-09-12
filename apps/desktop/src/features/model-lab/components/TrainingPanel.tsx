import { ChevronDownIcon } from "lucide-react";
import { HelpTooltip } from "../../../components/app/HelpTooltip";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../../components/ui/collapsible";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { DEV_RUNNER_NOTICE, TRAINING_BACKEND_COPY, type TrainingBackend, type TrainingStatus } from "../types";

type TrainingPanelProps = {
  trainingBackend: TrainingBackend;
  onBackendChange: (backend: TrainingBackend) => void;
  status: TrainingStatus;
  logs: string[];
  trainingError: string | null;
  selectedCount: number;
  onStart: () => void;
  onCancel: () => void;
};

/** Backend choice, start/cancel controls, and live status/log for the local training runner. */
export function TrainingPanel({
  trainingBackend,
  onBackendChange,
  status,
  logs,
  trainingError,
  selectedCount,
  onStart,
  onCancel,
}: TrainingPanelProps) {
  const isRunning = status.phase === "running";

  return (
    <Card id="lab-training" role="region" aria-label="Training" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Training"
          description="Choose a deployable model for desktop control, or a baseline to evaluate your recordings. Select imported sessions before starting."
          help={{
            label: "About the training backends",
            content: "TFLite produces a deployable bundle that can be bound to intents and activated on this desktop. scikit-learn is a quick baseline for offline evaluation only and can never be activated.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Collapsible>
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" className="justify-between px-0 hover:bg-transparent" />}
          >
            <span>Training requirements and advanced settings</span>
            <ChevronDownIcon aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="hint" role="status">{DEV_RUNNER_NOTICE}</p>
            <p className="hint">
              Defaults: 500&nbsp;ms windows, 150&nbsp;ms stride, 250&nbsp;ms max gap before splitting a session,
              3-sample minimum per window, <code>pinch_hold</code> excluded (change with{" "}
              <code>--hold-handling exclude|negative|class</code>), 25% of sessions held out, 200-tree RandomForest.
              You can also run the trainer manually from a terminal:
            </p>
            <div className="vector-row">
              <code>pinch-classifier-train --input session1.csv session2.csv --output-dir artifacts/</code>
            </div>
          </CollapsibleContent>
        </Collapsible>
        <RadioGroup
          className="vectors model-lab-backend-select"
          aria-label="Training backend"
          name="training-backend"
          value={trainingBackend}
          onValueChange={(value) => onBackendChange(value as TrainingBackend)}
        >
          {(["tflite", "sklearn"] as const).map((backend) => (
            <label className="model-lab-dataset-select" key={backend}>
              <RadioGroupItem value={backend} disabled={isRunning} />
              <span className="label">
                {TRAINING_BACKEND_COPY[backend].label}
                <br />
                <small className="hint">{TRAINING_BACKEND_COPY[backend].hint}</small>
              </span>
            </label>
          ))}
        </RadioGroup>
        <div className="recording-actions flex flex-wrap items-center gap-2">
          <Button type="button" onClick={onStart} disabled={selectedCount === 0 || isRunning}>
            {isRunning ? "Training…" : "Start training"}
          </Button>
          <Button type="button" variant="outline" onClick={onCancel} disabled={!isRunning}>
            Cancel
          </Button>
          <HelpTooltip label="About training and cancellation">
            Training runs the local development runner in the background. Cancelling stops the process; already
            written artifacts for that run are discarded.
          </HelpTooltip>
        </div>
        {status.phase === "running" && (
          <p className="hint">
            Running job {status.jobId} on {status.datasetIds.length} dataset{status.datasetIds.length === 1 ? "" : "s"},
            started {status.startedAt}.
          </p>
        )}
        {status.phase === "completed" && (
          <p className="hint">Job {status.jobId} completed &mdash; trained model {status.modelId}.</p>
        )}
        {status.phase === "failed" && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>Training job {status.jobId} failed: {status.message}</AlertDescription>
          </Alert>
        )}
        {trainingError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{trainingError}</AlertDescription>
          </Alert>
        )}
        {logs.length > 0 && (
          <pre className="model-lab-log" aria-label="Training log">{logs.join("\n")}</pre>
        )}
      </CardContent>
    </Card>
  );
}

import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { IntentBindingEditor } from "./IntentBindingEditor";
import {
  bindingsAreComplete,
  type GestureIntent,
  type ModelLifecycleState,
  type ModelRegistryView,
  type TrainedModelSummary,
} from "../types";

type ModelLifecycleControlsProps = {
  registry: ModelRegistryView | null;
  trainedModelById: Map<string, TrainedModelSummary>;
  bindingDrafts: Record<string, Record<string, GestureIntent>>;
  bindingError: string | null;
  isPending: (key: string) => boolean;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  onDraftChange: (modelId: string, classLabel: string, intent: GestureIntent) => void;
  onSaveBindings: (modelId: string) => Promise<void>;
  onTransition: (id: string, to: ModelLifecycleState) => Promise<void>;
  onActivate: (id: string) => Promise<void>;
  onRollback: () => Promise<void>;
};

/** Model lifecycle stages, safe intent bindings, and activation/rollback for desktop deployment. */
export function ModelLifecycleControls({
  registry,
  trainedModelById,
  bindingDrafts,
  bindingError,
  isPending,
  run,
  onDraftChange,
  onSaveBindings,
  onTransition,
  onActivate,
  onRollback,
}: ModelLifecycleControlsProps) {
  return (
    <Card id="lab-deployment" role="region" aria-label="Export and deploy" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Desktop deployment"
          description="Only a validated LiteRT bundle may be activated for desktop inference. Sensor devices remain raw-data sources: no model or gesture inference is deployed to the watch or headphones."
          help={{
            label: "About model lifecycle stages",
            content: "Draft → Evaluated → Approved → Active. A model can only be activated once approved, backed by a TFLite bundle, and given complete safe intent bindings. Archived models can be restored as a draft.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!registry || registry.models.length === 0 ? (
          <p className="hint model-lab-lifecycle-empty">No registered trained models yet.</p>
        ) : (
          <div className="vectors model-lab-models" aria-label="Model lifecycle">
            {registry.models.map((model) => {
              const backend = trainedModelById.get(model.id)?.backend;
              const bindingsEditable = model.state === "draft" || model.state === "evaluated";
              const bindingsComplete = bindingsAreComplete(model.intentBindings);
              const canActivate = model.state === "approved" && backend === "tflite" && bindingsComplete;
              const rowPending = isPending(`lifecycle:${model.id}`);
              const transition = (to: ModelLifecycleState) => {
                void run(`lifecycle:${model.id}`, () => onTransition(model.id, to));
              };
              return (
                <div className="vector-row model-lab-lifecycle-row" key={model.id}>
                  <div>
                    <span className="label">{model.id}</span>
                    <strong className="model-lab-state">{model.state}</strong>
                    <small>Registered {model.createdAt}</small>
                    {backend === "sklearn" && (
                      <p className="hint">
                        scikit-learn baseline: not deployable, cannot be bound or activated.
                      </p>
                    )}
                  </div>
                  <IntentBindingEditor
                    model={model}
                    editable={bindingsEditable}
                    draft={bindingDrafts[model.id]}
                    onDraftChange={(classLabel, intent) => onDraftChange(model.id, classLabel, intent)}
                    onSave={() => onSaveBindings(model.id)}
                  />
                  <div className="model-lab-lifecycle-actions">
                    {model.state === "draft" && (
                      <Button type="button" disabled={rowPending} onClick={() => transition("evaluated")}>Mark evaluated</Button>
                    )}
                    {model.state === "evaluated" && (
                      <Button type="button" disabled={rowPending} onClick={() => transition("approved")}>Approve</Button>
                    )}
                    {model.state === "approved" && (
                      <Button type="button" variant="outline" disabled={rowPending} onClick={() => transition("evaluated")}>Return to evaluation</Button>
                    )}
                    {(model.state === "evaluated" || model.state === "approved") && (
                      <Button type="button" variant="outline" disabled={rowPending} onClick={() => transition("archived")}>Archive</Button>
                    )}
                    {model.state === "archived" && (
                      <Button type="button" disabled={rowPending} onClick={() => transition("draft")}>Restore as draft</Button>
                    )}
                    {model.state === "approved" && (
                      <Button
                        className="model-lab-activate"
                        type="button"
                        onClick={() => void run(`lifecycle:${model.id}`, () => onActivate(model.id))}
                        disabled={!canActivate || rowPending}
                        title={canActivate ? undefined : "Activation requires a TFLite bundle and complete safe intent bindings"}
                      >
                        Activate
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="model-lab-deployment-actions">
          <span className="hint">
            Active: {registry?.activeModelId ?? "none"}. Activation requires approved lifecycle state, a validated
            LiteRT bundle, and complete safe intent bindings.
          </span>
          <Button
            type="button"
            variant="outline"
            onClick={() => void run("rollback", onRollback)}
            disabled={!registry?.previousActiveModelId || isPending("rollback")}
          >
            Rollback active model
          </Button>
        </div>
        {bindingError && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{bindingError}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}

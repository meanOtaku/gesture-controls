import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useId, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { SegmentedControl } from "../../../components/app/SegmentedControl";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { usePendingActions } from "../hooks/usePendingActions";
import {
  MODE_OPTIONS,
  actionsFor,
  groupByLabel,
  type ImportedLabelModel,
  type LabelModel,
  type LabelModelState,
  type LabelRuntimeMode,
  type LabelRuntimeStatus,
  type ModelAction,
} from "../labelModels";

const STATE_LABEL: Record<LabelModelState, string> = {
  draft: "Draft",
  evaluated: "Evaluated",
  approved: "Approved",
  active: "Active",
  archived: "Archived",
};

/**
 * One binary model per label: bring a model in, review it, approve it, activate it, and choose whether the
 * models only watch (Monitor) or can drive recipes (Live). Every step is a person's choice; importing never
 * activates anything.
 */
export function LabelModelsPanel({
  desktopAvailable,
  models,
  status,
  loadError,
  refresh,
}: {
  desktopAvailable: boolean;
  models: LabelModel[];
  status: LabelRuntimeStatus | null;
  loadError: string | null;
  refresh: () => Promise<void>;
}) {
  const modeId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const setError = setActionError;
  const [confirmLive, setConfirmLive] = useState(false);
  const { isPending, run } = usePendingActions();

  const attempt = (key: string, title: string, work: () => Promise<unknown>, success?: string) =>
    run(key, async () => {
      setError(null);
      try {
        await work();
        if (success) OperationFeedback.success(title, success);
      } catch (err) {
        setError(String(err));
        OperationFeedback.error(title, String(err));
      }
      await refresh();
    });

  const importFolder = async () => {
    const chosen = await open({ directory: true, multiple: false, title: "Choose a model bundle folder" });
    if (typeof chosen !== "string") return;
    await attempt(
      "import",
      "Import model",
      async () => {
        const imported = await invoke<ImportedLabelModel>("import_label_model", { path: chosen });
        OperationFeedback.success("Import model", `Added ${imported.label} as a draft. It is not active.`);
      },
    );
  };

  const perform = (model: LabelModel, action: ModelAction) => {
    const key = `${model.id}:${action.kind}`;
    if (action.kind === "state") {
      return attempt(key, action.label, () => invoke("set_label_model_state", { id: model.id, state: action.to }));
    }
    if (action.kind === "activate") {
      return attempt(key, "Activate", () => invoke("activate_label_model", { id: model.id }), `${model.label} is now active.`);
    }
    return attempt(key, "Deactivate", () => invoke("deactivate_label_model", { label: model.label }));
  };

  const setMode = (mode: LabelRuntimeMode) => {
    if (mode === "live" && status?.mode !== "live") {
      setConfirmLive(true);
      return;
    }
    setConfirmLive(false);
    void attempt("mode", "Change mode", () => invoke("set_label_runtime_mode", { mode }));
  };

  const mode = status?.mode ?? "off";
  const groups = groupByLabel(models);

  return (
    <Card id="lab-labels" role="region" aria-label="Label models" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Label models"
          description="One model per label. Several labels can be active at once."
          status={
            <Button type="button" variant="outline" disabled={!desktopAvailable || isPending("import")} onClick={() => void importFolder()}>
              Import a model folder
            </Button>
          }
          help={{
            label: "About label models",
            content: "A model bundle is a folder with manifest.json and one ONNX model. Importing adds it as a Draft: you then mark it evaluated, approve it and activate it yourself. Models run inside this app; nothing else needs to be installed.",
          }}
        />
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {status?.registryError && (
          <Alert variant="destructive" role="alert">
            <AlertTitle>The model registry could not be opened</AlertTitle>
            <AlertDescription>{status.registryError}</AlertDescription>
          </Alert>
        )}
        {status?.loadFailures.map((failure) => (
          <Alert key={failure.version} variant="destructive" role="alert">
            <AlertTitle>{failure.label} has no running model</AlertTitle>
            <AlertDescription>{failure.version} could not be loaded: {failure.detail}</AlertDescription>
          </Alert>
        ))}

        <div className="field">
          <div className="field-head"><span id={modeId} className="label">Model runtime</span></div>
          <SegmentedControl
            labelledBy={modeId}
            value={mode}
            disabled={!desktopAvailable || isPending("mode") || status?.registryError != null}
            options={MODE_OPTIONS.map(({ value, label }) => ({ value, label }))}
            onValueChange={setMode}
          />
          <p className="field-hint">{MODE_OPTIONS.find((option) => option.value === mode)?.summary} A restart always comes back in Monitor, never Live.</p>
        </div>
        {confirmLive && (
          <Alert role="alert">
            <AlertTitle>Let models drive recipes?</AlertTitle>
            <AlertDescription>
              <p>In Live, a detection from an active model can start any recipe that uses its label (volume, brightness, scroll, media keys). Check the models in Monitor first.</p>
              <div className="mt-2 flex gap-2">
                <Button type="button" variant="destructive" onClick={() => { setConfirmLive(false); void attempt("mode", "Change mode", () => invoke("set_label_runtime_mode", { mode: "live" })); }}>
                  Switch to Live
                </Button>
                <Button type="button" variant="outline" onClick={() => setConfirmLive(false)}>Stay in {mode}</Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {groups.length === 0 ? (
          <p className="hint">No label models yet. Import a model folder, or train one from your recordings below.</p>
        ) : (
          <ul className="flex flex-col gap-4" aria-label="Label models by label">
            {groups.map((group) => {
              const score = status?.lastScores[group.label];
              const detected = status?.activeDetections.includes(group.label) ?? false;
              return (
                <li key={group.label} className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <strong>{group.label}</strong>
                    {detected && <Badge>Detected</Badge>}
                    {score !== undefined && <small className="text-muted-foreground">score {(score * 100).toFixed(0)}%</small>}
                  </div>
                  <ul className="flex flex-col gap-2" aria-label={`${group.label} models`}>
                    {group.models.map((model) => (
                      <li key={model.id} className="recipe-item">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="text-sm">
                            {model.id} <Badge variant={model.state === "active" ? "default" : "secondary"}>{STATE_LABEL[model.state]}</Badge>{" "}
                            {model.imported && <Badge variant="outline">Imported</Badge>}
                          </span>
                          <small className="text-xs text-muted-foreground">
                            Added {model.createdAt}
                            {model.imported ? ". Imported models are not evaluated by this app: review them before approving." : ""}
                          </small>
                        </div>
                        <div className="recipe-item-actions">
                          {actionsFor(model).map((action) => (
                            <Button
                              key={action.label}
                              type="button"
                              variant="outline"
                              aria-label={`${action.label} ${model.id}`}
                              disabled={isPending(`${model.id}:${action.kind}`)}
                              onClick={() => void perform(model, action)}
                            >
                              {action.label}
                            </Button>
                          ))}
                          {model.state === "active" && (
                            <Button type="button" variant="ghost" aria-label={`Roll back ${model.label}`} disabled={isPending(`${model.label}:rollback`)}
                              onClick={() => void attempt(`${model.label}:rollback`, "Roll back", () => invoke("rollback_label_model", { label: model.label }))}>
                              Roll back
                            </Button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
        {status && status.quarantined.length > 0 && (
          <p className="field-hint">
            {status.quarantined.length} model{status.quarantined.length === 1 ? "" : "s"} from the old three-class system could not be converted and are kept aside, not used.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

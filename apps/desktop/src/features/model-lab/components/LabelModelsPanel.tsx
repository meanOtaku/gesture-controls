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
import { Input } from "../../../components/ui/input";
import { usePendingActions } from "../hooks/usePendingActions";
import {
  MAX_MODEL_NAME,
  MODE_OPTIONS,
  actionsFor,
  formatTime,
  groupByLabel,
  modelName,
  modelStats,
  runtimeSummary,
  type ImportedLabelModel,
  type LabelModel,
  type LabelModelState,
  type LabelRuntimeMode,
  type LabelRuntimeStatus,
  type ModelAction,
} from "../labelModels";
import { InputWarningNote } from "./InputWarningNote";

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
 *
 * Each label gets a slot: its active model first, with its threshold and held-out results, then its other versions as
 * rows with one next step each. Everything else about a model (rename, inspect, stepping back, archiving) is behind its
 * More button, and archived versions are folded away. A label with no active model says so, since nothing detects it.
 */
export function LabelModelsPanel({
  desktopAvailable,
  models,
  status,
  loadError,
  refresh,
  onInspect,
}: {
  desktopAvailable: boolean;
  models: LabelModel[];
  status: LabelRuntimeStatus | null;
  loadError: string | null;
  refresh: () => Promise<void>;
  /** Opens the Inspect view for a model. */
  onInspect?: (id: string) => void;
}) {
  const modeId = useId();
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const setError = setActionError;
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [moreOpen, setMoreOpen] = useState<string | null>(null);
  const [archivedOpen, setArchivedOpen] = useState<Set<string>>(new Set());
  const [justImported, setJustImported] = useState<string | null>(null);
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
        setJustImported(imported.id);
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
      return attempt(key, "Activate", () => invoke("activate_label_model", { id: model.id }), `${modelName(model)} is now the active ${model.label} model.`);
    }
    return attempt(key, "Deactivate", () => invoke("deactivate_label_model", { label: model.label }));
  };

  const saveName = (model: LabelModel, draft: string) => {
    setRenaming(null);
    const name = draft.trim();
    if (name === (model.name ?? "")) return;
    void attempt(`${model.id}:rename`, "Rename model", () => invoke("rename_label_model", { id: model.id, name: name || null }));
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
  const anyImported = models.some((model) => model.imported && model.state !== "archived" && !model.active);

  const actionButton = (model: LabelModel, action: ModelAction, emphasis: "outline" | "ghost" = "outline", text = action.label) => (
    <Button
      key={action.label}
      type="button"
      variant={emphasis}
      aria-label={`${text} ${model.id}`}
      disabled={isPending(`${model.id}:${action.kind}`)}
      onClick={() => { setMoreOpen(null); void perform(model, action); }}
    >
      {text}
    </Button>
  );

  /** The model's name (or rename box), id, badges and a line about where it came from. */
  const identity = (model: LabelModel) => (
    <div className="flex min-w-0 flex-col gap-1">
      {renaming?.id === model.id ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); saveName(model, renaming.draft); }}>
          <Input
            aria-label={`Name for ${model.id}`}
            className="max-w-xs"
            autoFocus
            maxLength={MAX_MODEL_NAME}
            placeholder={model.id}
            value={renaming.draft}
            onChange={(event) => setRenaming({ id: model.id, draft: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
          />
          <Button type="submit" variant="outline">Save name</Button>
          <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
        </form>
      ) : (
        model.name && <strong className="text-sm">{modelName(model)}</strong>
      )}
      <span className="flex flex-wrap items-center gap-2 text-sm">
        {model.name ? <small className="text-muted-foreground">{model.id}</small> : <span>{model.id}</span>}
        {!model.active && <Badge variant="secondary">{STATE_LABEL[model.state]}</Badge>}
        {model.imported && <Badge variant="outline">Imported</Badge>}
        {model.monitorOnly && <Badge variant="outline">Monitor only</Badge>}
        {justImported === model.id && <Badge>New</Badge>}
      </span>
      <small className="text-xs text-muted-foreground">
        Added {formatTime(model.createdAt)}
        {model.monitorOnly ? ". It did not pass the checks for going live: when active it scores and shows what it detects, but never starts a recipe, even in Live." : ""}
      </small>
    </div>
  );

  /** Threshold and held-out results, as a small fact list. */
  const stats = (model: LabelModel) => {
    const facts = modelStats(model);
    return facts.length === 0 ? null : (
      <dl className="grid grid-flow-col gap-x-4 text-xs" aria-label={`${model.id} figures`}>
        {facts.map(({ term, value }) => (
          <div key={term} className="flex flex-col">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="m-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    );
  };

  /** Everything but the model's next step: rename, inspect, and the lifecycle moves after the first. */
  const more = (model: LabelModel, secondary: ModelAction[]) => {
    const opened = moreOpen === model.id;
    return (
      <>
        <Button
          type="button"
          variant="ghost"
          aria-label={`More actions for ${model.id}`}
          aria-expanded={opened}
          onClick={() => setMoreOpen(opened ? null : model.id)}
        >
          More
        </Button>
        {opened && (
          <div className="flex w-full flex-wrap justify-end gap-2" role="group" aria-label={`More for ${model.id}`}>
            {onInspect && (
              <Button type="button" variant="ghost" aria-label={`Inspect ${model.id}`} onClick={() => { setMoreOpen(null); onInspect(model.id); }}>
                Inspect
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              aria-label={`Rename ${model.id}`}
              disabled={!desktopAvailable || isPending(`${model.id}:rename`)}
              onClick={() => { setMoreOpen(null); setRenaming({ id: model.id, draft: model.name ?? "" }); }}
            >
              Rename
            </Button>
            {secondary.map((action) => actionButton(model, action, "ghost"))}
          </div>
        )}
      </>
    );
  };

  const deleteControls = (model: LabelModel) =>
    confirmingDelete === model.id ? (
      <>
        <Button
          type="button"
          variant="destructive"
          disabled={isPending(`${model.id}:delete`)}
          onClick={() => {
            setConfirmingDelete(null);
            void attempt(`${model.id}:delete`, "Delete model", () => invoke("delete_label_model", { id: model.id }), `${modelName(model)} was deleted.`);
          }}
        >
          Delete {model.id} for good
        </Button>
        <Button type="button" variant="outline" onClick={() => setConfirmingDelete(null)}>Keep</Button>
      </>
    ) : (
      <Button type="button" variant="ghost" aria-label={`Delete ${model.id}`} onClick={() => setConfirmingDelete(model.id)}>
        Delete
      </Button>
    );

  return (
    <Card id="lab-labels" role="region" aria-label="Label models" className="min-w-0">
      <CardHeader>
        <SectionHeader
          title="Label models"
          description="One active model per label. Several labels can be active at once."
          status={
            <Button type="button" variant="outline" disabled={!desktopAvailable || isPending("import")} onClick={() => void importFolder()}>
              Import a model folder
            </Button>
          }
          help={{
            label: "About label models",
            content: "A model bundle is a folder with manifest.json and the model file. Importing adds it as a Draft: you then mark it evaluated, approve it and activate it yourself. Activating a model replaces the label's active one, and Roll back returns to the one before. Models run inside this app; nothing else needs to be installed.",
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
          <p className="field-hint" role="status">
            {runtimeSummary(mode, groups)} A restart always comes back in Monitor, never Live.
          </p>
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
              const active = group.models.find((model) => model.active);
              const others = group.models.filter((model) => !model.active && model.state !== "archived");
              const archived = group.models.filter((model) => model.state === "archived");
              const showArchived = archivedOpen.has(group.label);
              return (
                <li key={group.label} className="flex flex-col gap-3 rounded-md border p-3" aria-label={`${group.label} slot`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{group.label}</strong>
                    {active ? <Badge>Active</Badge> : <Badge variant="destructive">No active model</Badge>}
                    {detected && <Badge>Detected</Badge>}
                    {score !== undefined && (
                      <span className="ml-auto flex items-center gap-2">
                        <small className="text-muted-foreground">score {(score * 100).toFixed(0)}%</small>
                        <span className="block h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span className="block h-full bg-primary" style={{ width: `${Math.round(Math.min(Math.max(score, 0), 1) * 100)}%` }} />
                        </span>
                      </span>
                    )}
                  </div>
                  {(status?.inputWarnings ?? []).filter((w) => w.label === group.label).map((w) => <InputWarningNote key={w.modelId} warning={w} />)}
                  {!active && (
                    <p className="text-sm text-destructive">
                      Nothing detects {group.label}, so no recipe that uses it can start or end. {others.some((m) => m.state === "approved") ? "Activate an approved version below." : "Approve a version below, then activate it."}
                    </p>
                  )}
                  <ul className="flex flex-col gap-2" aria-label={`${group.label} models`}>
                    {active && (
                      <li className="recipe-item rounded-md bg-muted/40 p-2" aria-label={`Active ${group.label} model`}>
                        {identity(active)}
                        {stats(active)}
                        <div className="recipe-item-actions">
                          {actionsFor(active).map((action) => actionButton(active, action))}
                          <Button type="button" variant="ghost" aria-label={`Roll back ${active.label}`} disabled={isPending(`${active.label}:rollback`)}
                            onClick={() => void attempt(`${active.label}:rollback`, "Roll back", () => invoke("rollback_label_model", { label: active.label }))}>
                            Roll back
                          </Button>
                          {more(active, [])}
                        </div>
                      </li>
                    )}
                    {others.length > 0 && active && <li className="text-xs text-muted-foreground" aria-hidden="true">Other versions</li>}
                    {others.map((model) => {
                      const [next, ...secondary] = actionsFor(model);
                      const swap = next?.kind === "activate" && active != null;
                      return (
                        <li key={model.id} className={`recipe-item${justImported === model.id ? " rounded-md ring-1 ring-primary p-2" : ""}`}>
                          {identity(model)}
                          {stats(model)}
                          <div className="recipe-item-actions">
                            {next && actionButton(model, next, "outline", swap ? "Swap in" : next.label)}
                            {more(model, secondary)}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                  {archived.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <Button
                        type="button"
                        variant="ghost"
                        className="self-start"
                        aria-expanded={showArchived}
                        onClick={() => setArchivedOpen((open) => { const next = new Set(open); if (next.has(group.label)) next.delete(group.label); else next.add(group.label); return next; })}
                      >
                        {showArchived ? "Hide" : "Show"} {archived.length} archived
                      </Button>
                      {showArchived && (
                        <ul className="flex flex-col gap-2" aria-label={`${group.label} archived models`}>
                          {archived.map((model) => (
                            <li key={model.id} className="recipe-item">
                              {identity(model)}
                              <div className="recipe-item-actions">
                                {actionsFor(model).map((action) => actionButton(model, action))}
                                {deleteControls(model)}
                                {more(model, [])}
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {anyImported && (
          <p className="text-xs text-muted-foreground">Imported models are not evaluated by this app: check them with Inspect or Compare models before approving.</p>
        )}
      </CardContent>
    </Card>
  );
}

import { AnimatedNumber, AnimatedText } from "../../../components/app/AnimatedNumber";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { SectionHeader } from "../../../components/app/SectionHeader";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card, CardContent, CardHeader } from "../../../components/ui/card";
import { Input } from "../../../components/ui/input";
import { usePendingActions } from "../hooks/usePendingActions";
import { FloatingMenu } from "../../../components/app/FloatingMenu";
import {
  MAX_MODEL_NAME,
  actionsFor,
  formatTime,
  runtimeSummary,
  groupByLabel,
  multiGestureNetworks,
  newestFirst,
  modelName,
  modelStats,
  type ImportedLabelModel,
  type LabelModel,
  type LabelModelState,
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
 * One binary model per label: bring a model in, review it, approve it and activate it. Whether the models only watch
 * (Monitor) or can drive recipes (Live) is chosen with `RuntimeSwitch`. Every step is a person's choice; importing never
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
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const setError = setActionError;
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
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
      return attempt(key, "Activate", async () => {
        for (const step of action.via ?? []) await invoke("set_label_model_state", { id: model.id, state: step });
        await invoke("activate_label_model", { id: model.id });
      }, `${modelName(model)} is now the active ${model.label} model.`);
    }
    return attempt(key, "Deactivate", () => invoke("deactivate_label_model", { label: model.label }));
  };

  const saveName = (model: LabelModel, draft: string) => {
    setRenaming(null);
    const name = draft.trim();
    if (name === (model.name ?? "")) return;
    void attempt(`${model.id}:rename`, "Rename model", () => invoke("rename_label_model", { id: model.id, name: name || null }));
  };

  // A multi-gesture network's models are listed together in its own section; a label's own list keeps only its active one.
  // Multi-gesture models (one model, an output per gesture), and the per-gesture copies older runs made of one network.
  const multiModels = newestFirst(models.filter((model) => (model.outputs?.length ?? 0) > 1));
  const networks = multiGestureNetworks(models);
  const inNetwork = new Set(networks.flatMap((network) => network.models.map((model) => model.id)));
  const coveredBy = (label: string) => multiModels.find((model) => model.outputs!.some((output) => output.label === label && output.active)) ?? null;
  const groups = groupByLabel(models).filter((group) => group.models.some((model) => model.active || !inNetwork.has(model.id)));
  const anyImported = models.some((model) => model.imported && model.state !== "archived" && !model.active);

  const actionButton = (model: LabelModel, action: ModelAction, emphasis: "outline" | "ghost" = "outline", text = action.label) => (
    <Button
      key={action.label}
      type="button"
      variant={emphasis}
      aria-label={`${text} ${model.id}`}
      disabled={isPending(`${model.id}:${action.kind}`)}
      onClick={() => void perform(model, action)}
    >
      {text}
    </Button>
  );

  /** The model's name (or rename box), id, badges and a line about where it came from. */
  const identity = (model: LabelModel) => (
    <div className="flex min-w-0 flex-col gap-1">
      {renaming?.id === model.id ? (
        <form className="model-rename" onSubmit={(event) => { event.preventDefault(); saveName(model, renaming.draft); }}>
          <Input
            aria-label={`Name for ${model.id}`}
            className="h-8 max-w-xs"
            autoFocus
            maxLength={MAX_MODEL_NAME}
            placeholder="A name for it (empty: its id)"
            value={renaming.draft}
            onChange={(event) => setRenaming({ id: model.id, draft: event.target.value })}
            onKeyDown={(event) => { if (event.key === "Escape") setRenaming(null); }}
          />
          <Button type="submit" variant="outline" size="sm">Save name</Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => setRenaming(null)}>Cancel</Button>
        </form>
      ) : (
        <strong className="text-sm">{modelName(model)}</strong>
      )}
      <span className="flex flex-wrap items-center gap-2 text-sm">
        {model.name && <small className="text-muted-foreground">{model.id}</small>}
        {!model.active && <Badge variant="secondary">{STATE_LABEL[model.state]}</Badge>}
        {model.imported && <Badge variant="outline">Imported</Badge>}
        {model.monitorOnly && <Badge variant="outline">Monitor only</Badge>}
        {(model.gestures?.length ?? 0) > 1 && <Badge variant="outline" title="One network learnt these gestures together; each has a model of its own, in its label's list">Multi-gesture</Badge>}
        {justImported === model.id && <Badge>New</Badge>}
      </span>
      {(model.gestures?.length ?? 0) > 1 && (
        <small className="text-xs text-muted-foreground">
          The {model.label} output of the {model.gestures!.join(" · ")} model: see Multi-gesture models below.
        </small>
      )}
      <small className="text-xs text-muted-foreground">
        Added {formatTime(model.createdAt)}
        {model.monitorOnly ? ". It did not pass the checks for going live: when active it scores and shows what it detects, but never starts a recipe, even in Live." : ""}
      </small>
    </div>
  );

  /** Threshold and held-out results, as a small fact list. */
  const stats = (model: LabelModel) => {
    const facts = modelStats(model);
    return facts.length === 0 ? <div aria-hidden="true" /> : (
      <dl className="model-row-stats" aria-label={`${model.id} figures`}>
        {facts.map(({ term, value, note }) => (
          <div key={term} className="flex flex-col">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="m-0 tabular-nums"><AnimatedText>{value}</AnimatedText></dd>
            {note && <dd className="m-0 text-[0.7rem] text-muted-foreground">{note}</dd>}
          </div>
        ))}
      </dl>
    );
  };

  /**
   * The bar under each model, always shown: Inspect, Rename and its next lifecycle steps, with the rarer ones (going back a
   * step, archiving) in a More menu that floats over the page, so opening it moves nothing. `extra` adds controls (delete).
   */
  const actionBar = (model: LabelModel, secondary: ModelAction[], extra?: React.ReactNode) => {
    const rare = secondary.filter((action) => action.kind === "state" && (action.to === "archived" || (action.to === "evaluated" && model.state === "approved")));
    const common = secondary.filter((action) => !rare.includes(action));
    return (
      <div className="model-actions-bar" role="group" aria-label={`Actions for ${model.id}`}>
        {onInspect && (
          <Button type="button" variant="ghost" size="sm" aria-label={`Inspect ${model.id}`} onClick={() => onInspect(model.id)}>
            Inspect
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Rename ${model.id}`}
          disabled={!desktopAvailable || isPending(`${model.id}:rename`)}
          onClick={() => setRenaming({ id: model.id, draft: model.name ?? "" })}
        >
          Rename
        </Button>
        {common.map((action) => (
          <Button key={action.label} type="button" variant="ghost" size="sm" aria-label={`${action.label} ${model.id}`}
            disabled={isPending(`${model.id}:${action.kind}`)} onClick={() => void perform(model, action)}>
            {action.label}
          </Button>
        ))}
        {extra}
        <FloatingMenu
          label="More"
          ariaLabel={`More actions for ${model.id}`}
          items={rare.map((action) => ({
            label: action.label,
            danger: action.kind === "state" && action.to === "archived",
            disabled: isPending(`${model.id}:${action.kind}`),
            run: () => void perform(model, action),
          }))}
        />
      </div>
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

        <p className="field-hint" role="status">{runtimeSummary(status?.mode ?? "off", groups)}</p>
        {groups.length === 0 ? (
          <p className="hint">No label models yet. Import a model folder, or train one from your recordings below.</p>
        ) : (
          <ul className="flex flex-col gap-4" aria-label="Label models by label">
            {groups.map((group) => {
              const score = status?.lastScores[group.label];
              const detected = status?.activeDetections.includes(group.label) ?? false;
              const active = group.models.find((model) => model.active);
              const multiActive = active ? null : coveredBy(group.label);
              const others = group.models.filter((model) => !model.active && model.state !== "archived" && !inNetwork.has(model.id));
              const archived = group.models.filter((model) => model.state === "archived");
              const showArchived = archivedOpen.has(group.label);
              return (
                <li key={group.label} className="flex flex-col gap-3 rounded-md border p-3" aria-label={`${group.label} slot`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <strong>{group.label}</strong>
                    {active || multiActive ? <Badge>Active</Badge> : <Badge variant="destructive">No active model</Badge>}
                    {detected && <Badge>Detected</Badge>}
                    {score !== undefined && (
                      <span className="ml-auto flex items-center gap-2">
                        <small className="text-muted-foreground">score {<AnimatedNumber value={(score * 100)} digits={0} />}%</small>
                        <span className="block h-1.5 w-20 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                          <span className="block h-full bg-primary" style={{ width: `${Math.round(Math.min(Math.max(score, 0), 1) * 100)}%` }} />
                        </span>
                      </span>
                    )}
                  </div>
                  {(status?.inputWarnings ?? []).filter((w) => w.label === group.label).map((w) => <InputWarningNote key={w.modelId} warning={w} />)}
                  {multiActive && <p className="text-sm">Detected by {modelName(multiActive)}, a multi-gesture model (below).</p>}
                  {!active && !multiActive && (
                    <p className="text-sm text-destructive">
                      Nothing detects {group.label}, so no recipe that uses it can start or end. Activate a version below.
                    </p>
                  )}
                  <ul className="model-rows" aria-label={`${group.label} models`}>
                    {active && (
                      <li className="model-row rounded-md bg-muted/40 p-2" aria-label={`Active ${group.label} model`}>
                        {identity(active)}
                        {stats(active)}
                        <div className="recipe-item-actions">
                          {actionsFor(active).map((action) => actionButton(active, action))}
                          <Button type="button" variant="ghost" aria-label={`Roll back ${active.label}`} disabled={isPending(`${active.label}:rollback`)}
                            onClick={() => void attempt(`${active.label}:rollback`, "Roll back", () => invoke("rollback_label_model", { label: active.label }))}>
                            Roll back
                          </Button>
                        </div>
                        {actionBar(active, [])}
                      </li>
                    )}
                    {others.length > 0 && active && <li className="model-rows-heading text-xs text-muted-foreground" aria-hidden="true">Other versions</li>}
                    {others.map((model) => {
                      const [next, ...secondary] = actionsFor(model);
                      const swap = next?.kind === "activate" && active != null;
                      return (
                        <li key={model.id} className={`model-row${justImported === model.id ? " rounded-md ring-1 ring-primary p-2" : ""}`}>
                          {identity(model)}
                          {stats(model)}
                          <div className="recipe-item-actions">
                            {next && actionButton(model, next, "outline", swap ? "Swap in" : next.label)}
                          </div>
                          {actionBar(model, secondary)}
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
                        {showArchived ? "Hide" : "Show"} {<AnimatedNumber value={archived.length} />} archived
                      </Button>
                      {showArchived && (
                        <ul className="model-rows" aria-label={`${group.label} archived models`}>
                          {archived.map((model) => (
                            <li key={model.id} className="model-row">
                              {identity(model)}
                              {stats(model)}
                              <div className="recipe-item-actions">
                                {actionsFor(model).map((action) => actionButton(model, action))}
                              </div>
                              {actionBar(model, [], deleteControls(model))}
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
        {(multiModels.length > 0 || networks.length > 0) && (
          <section className="flex flex-col gap-3" aria-label="Multi-gesture models">
            <h3 className="label">Multi-gesture models</h3>
            <p className="field-hint">One CNN that tells several gestures apart: an output for each, which compete so one movement is taken for one of them at most. It is activated as one, and becomes the active model of all its gestures; each output has its own threshold.</p>
            <ul className="flex flex-col gap-4">
              {multiModels.map((model) => {
                const outputs = model.outputs!;
                const name = modelName(model);
                const [next, ...secondary] = model.active ? [] : actionsFor(model);
                const replaces = outputs.some((output) => models.some((other) => other.id !== model.id && other.active && (other.label === output.label || other.outputs?.some((o) => o.label === output.label && o.active))));
                const figure = (output: (typeof outputs)[number], term: string) =>
                  modelStats({ activation: output.activation, evaluation: output.evaluation }).find((fact) => fact.term === term)?.value ?? "–";
                return (
                  <li key={model.id} className="flex flex-col gap-3 rounded-md border p-3" aria-label={`${name} model`}>
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <strong className="text-sm">{name}</strong>
                        <span className="flex flex-wrap items-center gap-2 text-sm">
                          {model.name && <small className="text-muted-foreground">{model.id}</small>}
                          <Badge variant="outline">Multi-gesture: {outputs.map((output) => output.label).join(" · ")}</Badge>
                          {model.active ? <Badge>Active</Badge> : <Badge variant="secondary">{STATE_LABEL[model.state]}</Badge>}
                          {model.monitorOnly && <Badge variant="outline">Monitor only</Badge>}
                        </span>
                        <small className="text-xs text-muted-foreground">
                          Added {formatTime(model.createdAt)}
                          {model.monitorOnly ? ". It did not pass the checks for going live: when active it scores and shows what it detects, but never starts a recipe, even in Live." : ""}
                        </small>
                      </div>
                      <div className="recipe-item-actions">
                        {next && actionButton(model, next, "outline", next.kind === "activate" && replaces ? "Swap in" : next.label)}
                        {model.active && (
                          <Button type="button" variant="ghost" aria-label={`Deactivate ${model.id}`} disabled={isPending(`${model.label}:deactivate`)}
                            onClick={() => void attempt(`${model.label}:deactivate`, "Deactivate", () => invoke("deactivate_label_model", { label: model.label }))}>
                            Deactivate
                          </Button>
                        )}
                      </div>
                    </div>
                    {actionBar(model, secondary)}
                    <table className="coverage-grid network-outputs" aria-label={`${name} outputs`}>
                      <thead>
                        <tr><th scope="col">Output</th><th scope="col">Threshold</th><th scope="col">Held-out recall</th><th scope="col">False / hour</th></tr>
                      </thead>
                      <tbody>
                        {outputs.map((output) => (
                          <tr key={output.label}>
                            <th scope="row">{output.label}{output.active && <> <Badge>Active</Badge></>}</th>
                            <td className="tabular-nums">{output.activation.toFixed(2)}</td>
                            <td className="tabular-nums">{figure(output, "Held-out recall")}</td>
                            <td className="tabular-nums">{figure(output, "False / hour")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="field-hint">Set each output&apos;s threshold on the Threshold card (pick the model&apos;s output there).</p>
                  </li>
                );
              })}
              {networks.map((network) => {
                const name = network.gestures.join(" · ");
                const anyActive = network.models.some((model) => model.active);
                return (
                  <li key={network.key} className="flex flex-col gap-3 rounded-md border p-3" aria-label={`${name} copies`}>
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <strong className="text-sm">{name}</strong>
                        <small className="text-xs text-muted-foreground">
                          One network, registered as a model per gesture by an earlier version of the app. Combine them into one model: it keeps the file, each gesture&apos;s threshold and the training history; the copies&apos; folders are set aside, never deleted.
                          {anyActive ? " Deactivate the active one first." : ""}
                        </small>
                      </div>
                      <div className="recipe-item-actions">
                        <Button type="button" variant="outline" aria-label={`Combine ${name} into one model`} disabled={anyActive || isPending(`${network.key}:combine`)}
                          onClick={() => void attempt(`${network.key}:combine`, "Combine", () => invoke("combine_multi_gesture_copies", { ids: network.models.map((model) => model.id) }), `${name} is now one model.`)}>
                          Combine into one model
                        </Button>
                      </div>
                    </div>
                    <table className="coverage-grid network-outputs" aria-label={`${name} copies list`}>
                      <thead>
                        <tr><th scope="col">Copy</th><th scope="col">State</th><th scope="col">Threshold</th><th scope="col">Held-out recall</th><th scope="col">False / hour</th></tr>
                      </thead>
                      <tbody>
                        {network.models.map((model) => (
                          <tr key={model.id}>
                            <th scope="row">{model.label}</th>
                            <td>{model.active ? <Badge>Active</Badge> : STATE_LABEL[model.state]}</td>
                            <td className="tabular-nums">{model.activation?.toFixed(2) ?? "–"}</td>
                            <td className="tabular-nums">{modelStats(model).find((fact) => fact.term === "Held-out recall")?.value ?? "–"}</td>
                            <td className="tabular-nums">{modelStats(model).find((fact) => fact.term === "False / hour")?.value ?? "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {anyImported && (
          <p className="text-xs text-muted-foreground">Imported models are not evaluated by this app: check them with Inspect or Compare models before approving.</p>
        )}
      </CardContent>
    </Card>
  );
}

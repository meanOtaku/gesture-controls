import { datasetLabels } from "../model-lab/types";
import type { UsageSources } from "./labelUsage";
import { recipesUsing } from "./labelUsage";

/**
 * Archiving or deleting a label together with everything that uses it. A plan is the list of steps, worked out from
 * what exists, shown to the person before anything runs. Running it goes through the same desktop commands each tab
 * uses, in an order that never leaves something pointing at what is already gone, and stops at the first failure.
 */

export type CascadeMode = "archive" | "delete" | "restore";

export type CascadeStep =
  | { kind: "disableRecipe"; id: string; name: string }
  | { kind: "enableRecipe"; id: string; name: string }
  | { kind: "deleteRecipe"; id: string; name: string }
  | { kind: "deleteGesture"; id: string; name: string }
  | { kind: "deactivateModel"; label: string }
  | { kind: "setModelState"; id: string; to: "evaluated" | "archived" | "draft" }
  | { kind: "deleteModel"; id: string }
  | { kind: "deleteTrainingHistory"; label: string }
  | { kind: "deleteDataset"; id: string; name: string }
  | { kind: "removeIntervals"; recordingId: string }
  | { kind: "archiveLabel"; log: { disabledRecipes: string[]; archivedModels: string[] } }
  | { kind: "restoreLabel" }
  | { kind: "deleteLabel" };

export interface CascadePlan {
  mode: CascadeMode;
  label: string;
  steps: CascadeStep[];
  /** What will happen, in words, for the preview. */
  lines: string[];
  /** What kept the plan from being possible; nothing can run while any exist. */
  blockers: string[];
}

export interface CascadeSources extends UsageSources {
  /** The label's own record, for what an earlier archive switched off. */
  archiveLog?: { disabledRecipes: string[]; archivedModels: string[] } | null;
}

type ModelState = "draft" | "evaluated" | "approved" | "active" | "archived";

/** The moves that take a model to Archived: the lifecycle only allows some directly. */
function archivePath(model: { id: string; label: string; state: string }): CascadeStep[] {
  switch (model.state as ModelState) {
    case "draft": return [{ kind: "setModelState", id: model.id, to: "evaluated" }, { kind: "setModelState", id: model.id, to: "archived" }];
    case "evaluated":
    case "approved": return [{ kind: "setModelState", id: model.id, to: "archived" }];
    case "active": return [{ kind: "deactivateModel", label: model.label }, { kind: "setModelState", id: model.id, to: "archived" }];
    default: return [];
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const names = (items: { name: string }[]) => items.map((item) => `“${item.name}”`).join(", ");

export function planCascade(mode: CascadeMode, labelId: string, sources: CascadeSources): CascadePlan {
  const steps: CascadeStep[] = [];
  const lines: string[] = [];
  const blockers: string[] = [];
  const models = sources.models.filter((model) => model.label === labelId);
  const live = models.filter((model) => model.state !== "archived");

  if (mode === "restore") {
    const log = sources.archiveLog;
    const recipes = sources.recipes.filter((recipe) => log?.disabledRecipes.includes(recipe.id));
    for (const recipe of recipes) steps.push({ kind: "enableRecipe", id: recipe.id, name: recipe.name });
    const back = models.filter((model) => model.state === "archived" && log?.archivedModels.includes(model.id));
    for (const model of back) steps.push({ kind: "setModelState", id: model.id, to: "draft" });
    steps.push({ kind: "restoreLabel" });
    lines.push("Bring the label back into the pickers.");
    if (recipes.length > 0) lines.push(`Switch ${plural(recipes.length, "recipe")} back on: ${names(recipes)}.`);
    if (back.length > 0) lines.push(`Move ${plural(back.length, "model")} back to Draft. They need approving and activating again before they run.`);
    return { mode, label: labelId, steps, lines, blockers };
  }

  if (mode === "archive") {
    const recipes = sources.recipes.filter((recipe) => recipe.enabled !== false && recipe.stages.some((stage) => stage.kind === "model" && stage.label === labelId));
    for (const recipe of recipes) steps.push({ kind: "disableRecipe", id: recipe.id, name: recipe.name });
    for (const model of live) steps.push(...archivePath(model));
    steps.push({ kind: "archiveLabel", log: { disabledRecipes: recipes.map((recipe) => recipe.id), archivedModels: live.map((model) => model.id) } });
    if (recipes.length > 0) lines.push(`Switch off ${plural(recipes.length, "recipe")} that use its model: ${names(recipes)}.`);
    if (live.length > 0) {
      const active = live.filter((model) => model.state === "active").length;
      lines.push(`Archive ${plural(live.length, "model")}${active > 0 ? ` (${plural(active, "active one")} stops first)` : ""}.`);
    }
    lines.push("Archive the label, so it no longer appears when choosing a label.");
    const keptGestures = sources.gestures.filter((gesture) => gesture.labelId === labelId).length;
    const keptRecordings = sources.bundles.filter((bundle) => bundle.labelIds.includes(labelId)).length;
    const keptTraining = sources.datasets.filter((dataset) => datasetLabels(dataset).includes(labelId)).length;
    const kept = [keptGestures && plural(keptGestures, "gesture"), keptRecordings && plural(keptRecordings, "Recorder recording"), keptTraining && plural(keptTraining, "training recording")].filter(Boolean);
    if (kept.length > 0) lines.push(`Kept as they are: ${kept.join(", ")}.`);
    return { mode, label: labelId, steps, lines, blockers };
  }

  // delete
  const recipes = recipesUsing(labelId, sources);
  for (const recipe of recipes) steps.push({ kind: "deleteRecipe", id: recipe.id, name: recipe.name });
  const gestures = sources.gestures.filter((gesture) => gesture.labelId === labelId);
  for (const gesture of gestures) steps.push({ kind: "deleteGesture", id: gesture.id, name: gesture.name });
  for (const model of models) {
    steps.push(...archivePath(model));
    steps.push({ kind: "deleteModel", id: model.id });
  }
  const history = sources.registry?.[labelId];
  if (history && history.mappedIn.length > 0) {
    blockers.push(`“${labelId}” is used as another label in the training history of ${history.mappedIn.map((other) => `“${other}”`).join(", ")}. That history is sealed: delete the label ${history.mappedIn.length === 1 ? "it belongs to" : "they belong to"} first, or archive “${labelId}” instead.`);
  }
  if (history && history.projects > 0) steps.push({ kind: "deleteTrainingHistory", label: labelId });
  const datasets = sources.datasets.filter((dataset) => datasetLabels(dataset).includes(labelId));
  for (const dataset of datasets) {
    const others = datasetLabels(dataset).filter((other) => other !== labelId);
    if (others.length > 0) blockers.push(`The training recording “${dataset.originalFilename}” also holds ${others.join(", ")}. Delete or replace it in Model Lab first.`);
    else steps.push({ kind: "deleteDataset", id: dataset.id, name: dataset.originalFilename });
  }
  const bundles = sources.bundles.filter((bundle) => bundle.labelIds.includes(labelId));
  for (const bundle of bundles) steps.push({ kind: "removeIntervals", recordingId: bundle.recordingId });
  steps.push({ kind: "deleteLabel" });

  if (recipes.length > 0) lines.push(`Delete ${plural(recipes.length, "recipe")}: ${names(recipes)}.`);
  if (gestures.length > 0) lines.push(`Delete ${plural(gestures.length, "gesture")} from the Gesture library: ${names(gestures)}.`);
  if (models.length > 0) lines.push(`Delete ${plural(models.length, "model")}, with their files.`);
  if (history && history.projects > 0) lines.push(`Delete its training history: ${plural(history.projects, "project")}, ${plural(history.runs, "run")} and ${plural(history.snapshots, "sealed snapshot")}.`);
  if (datasets.length > 0 && blockers.length === 0) lines.push(`Delete ${plural(datasets.length, "recording")} from the training data: ${names(datasets.map((d) => ({ name: d.originalFilename })))}.`);
  if (bundles.length > 0) lines.push(`Remove this label's marks from ${plural(bundles.length, "Recorder recording")}. The recordings and their raw data stay.`);
  lines.push("Delete the label itself. This cannot be undone.");
  return { mode, label: labelId, steps, lines, blockers };
}

export type Run = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export type CascadeResult = { ok: true; done: number } | { ok: false; done: number; failedStep: CascadeStep; message: string };

const describe = (step: CascadeStep): string => {
  switch (step.kind) {
    case "disableRecipe": return `switching off “${step.name}”`;
    case "enableRecipe": return `switching on “${step.name}”`;
    case "deleteRecipe": return `deleting “${step.name}”`;
    case "deleteGesture": return `deleting the gesture “${step.name}”`;
    case "deactivateModel": return "deactivating the model";
    case "setModelState": return `moving a model to ${step.to}`;
    case "deleteModel": return "deleting a model";
    case "deleteTrainingHistory": return "deleting its training history";
    case "deleteDataset": return `deleting “${step.name}” from the training data`;
    case "removeIntervals": return "removing marks from a recording";
    case "archiveLabel": return "archiving the label";
    case "restoreLabel": return "restoring the label";
    case "deleteLabel": return "deleting the label";
  }
};

async function runStep(step: CascadeStep, labelId: string, run: Run): Promise<void> {
  switch (step.kind) {
    case "disableRecipe": await run("set_recipe_enabled", { id: step.id, enabled: false }); return;
    case "enableRecipe": await run("set_recipe_enabled", { id: step.id, enabled: true }); return;
    case "deleteRecipe": await run("delete_recipe", { id: step.id }); return;
    case "deleteGesture": await run("delete_gesture_definition", { id: step.id }); return;
    case "deactivateModel": await run("deactivate_label_model", { label: step.label }); return;
    case "setModelState": await run("set_label_model_state", { id: step.id, state: step.to }); return;
    case "deleteModel": await run("delete_label_model", { id: step.id }); return;
    case "deleteTrainingHistory": await run("delete_label_history", { label: step.label }); return;
    case "deleteDataset": await run("delete_model_dataset", { id: step.id }); return;
    case "removeIntervals": await run("remove_label_from_recording", { recordingId: step.recordingId, labelId }); return;
    case "archiveLabel":
      await run("set_model_label_archived", { id: labelId, archived: true });
      await run("save_label_archive_log", { id: labelId, log: step.log });
      return;
    case "restoreLabel": await run("set_model_label_archived", { id: labelId, archived: false }); return;
    case "deleteLabel": await run("delete_model_label", { id: labelId }); return;
  }
}

/** Runs a plan step by step. Nothing runs if the plan has blockers. Stops at the first step that fails. */
export async function executePlan(plan: CascadePlan, run: Run, onProgress?: (done: number, total: number) => void): Promise<CascadeResult> {
  if (plan.blockers.length > 0) {
    return { ok: false, done: 0, failedStep: plan.steps[0], message: plan.blockers[0] };
  }
  let done = 0;
  for (const step of plan.steps) {
    try {
      await runStep(step, plan.label, run);
    } catch (error) {
      return { ok: false, done, failedStep: step, message: `Stopped while ${describe(step)}: ${String(error)}` };
    }
    done += 1;
    onProgress?.(done, plan.steps.length);
  }
  return { ok: true, done };
}

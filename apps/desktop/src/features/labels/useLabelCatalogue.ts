import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { listRecordingBundles } from "../../shared/tauri/recordingBundle";
import { listGestureDefinitions } from "../gestureLibrary/gestureLibraryApi";
import type { NewLabel } from "../model-lab/components/LabelCoverage";
import { useLabelModels } from "../model-lab/hooks/useLabelModels";
import { datasetLabels, type DatasetLabel, type DatasetSummary } from "../model-lab/types";
import { executePlan, planCascade, type CascadeMode, type CascadePlan, type CascadeResult } from "./labelCascade";
import { usageOf, type RegistryUsage, type UsageSources } from "./labelUsage";

const LABEL_COLOR = "#65e6ff";

/**
 * The one catalogue of labels, with everything that refers to each: recordings, models and gestures. Changes go through
 * the desktop, which keeps the catalogue; every other page reads it from there.
 */
export function useLabelCatalogue() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [gestures, setGestures] = useState<{ id: string; name: string; labelId: string | null }[]>([]);
  const [bundles, setBundles] = useState<{ recordingId: string; labelIds: string[] }[]>([]);
  const [recipes, setRecipes] = useState<UsageSources["recipes"]>([]);
  const [registry, setRegistry] = useState<Record<string, RegistryUsage>>({});
  const [loadVersion, setLoadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { models } = useLabelModels(desktopAvailable);

  useEffect(() => {
    if (!desktopAvailable) return;
    let live = true;
    void (async () => {
      try {
        const [catalogue, sets, gestureList, bundleList, automation, registryUsage] = await Promise.all([
          invoke<DatasetLabel[]>("list_model_labels"),
          invoke<DatasetSummary[]>("list_model_datasets"),
          listGestureDefinitions(),
          listRecordingBundles(),
          invoke<{ recipes: UsageSources["recipes"] }>("get_automation_state").catch(() => ({ recipes: [] })),
          invoke<Record<string, RegistryUsage>>("get_label_registry_usage").catch(() => ({})),
        ]);
        if (!live) return;
        setLabels(Array.isArray(catalogue) ? catalogue : []);
        setDatasets(Array.isArray(sets) ? sets : []);
        setGestures(gestureList.map(({ id, name, labelId }) => ({ id, name, labelId })));
        setBundles(bundleList.status === "ok" && Array.isArray(bundleList.value) ? bundleList.value.map(({ recordingId, labelIds }) => ({ recordingId, labelIds })) : []);
        setRecipes(Array.isArray(automation?.recipes) ? automation.recipes : []);
        setRegistry(registryUsage && typeof registryUsage === "object" ? (registryUsage as Record<string, RegistryUsage>) : {});
      } catch (err) {
        if (live) setError(String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [desktopAvailable, loadVersion]);

  const coverageByLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const dataset of datasets) for (const label of datasetLabels(dataset)) counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, [datasets]);
  const gestureCountByLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const gesture of gestures) if (gesture.labelId) counts.set(gesture.labelId, (counts.get(gesture.labelId) ?? 0) + 1);
    return counts;
  }, [gestures]);

  const recorderCountByLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const bundle of bundles) for (const label of new Set(bundle.labelIds)) counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, [bundles]);
  const usageFor = useCallback((id: string) => usageOf(id, { bundles, datasets, gestures, models, recipes, registry }), [bundles, datasets, gestures, models, recipes, registry]);

  const planFor = useCallback(
    (mode: CascadeMode, id: string) =>
      planCascade(mode, id, { bundles, datasets, gestures, models, recipes, registry, archiveLog: labels.find((label) => label.id === id)?.archiveLog ?? null }),
    [bundles, datasets, gestures, models, recipes, registry, labels],
  );

  /** Runs a plan through the desktop, then reads everything again, since many tabs' data changed. */
  const execute = useCallback(async (plan: CascadePlan, onProgress: (done: number, total: number) => void): Promise<CascadeResult> => {
    const result = await executePlan(plan, (command, args) => invoke(command, args), onProgress);
    if (result.ok) OperationFeedback.success(`${plan.mode === "delete" ? "Delete" : plan.mode === "archive" ? "Archive" : "Restore"} label`, `Done: ${result.done} steps.`);
    setLoadVersion((version) => version + 1);
    return result;
  }, []);

  const create = useCallback(async (label: NewLabel): Promise<string | null> => {
    try {
      setLabels(await invoke<DatasetLabel[]>("create_model_label", { input: { ...label, color: LABEL_COLOR } }));
      OperationFeedback.success("Add label", `Added ${label.displayName}.`);
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  const update = useCallback(async (label: NewLabel): Promise<string | null> => {
    try {
      setLabels(await invoke<DatasetLabel[]>("update_model_label", { input: { id: label.id, displayName: label.displayName, description: label.description, role: label.role } }));
      OperationFeedback.success("Edit label", `Saved ${label.displayName}.`);
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  const setArchived = useCallback(async (id: string, archived: boolean) => {
    try {
      setLabels(await invoke<DatasetLabel[]>("set_model_label_archived", { id, archived }));
    } catch (err) {
      OperationFeedback.error(archived ? "Archive label" : "Restore label", String(err));
    }
  }, []);

  const remove = useCallback(async (id: string): Promise<string | null> => {
    try {
      setLabels(await invoke<DatasetLabel[]>("delete_model_label", { id }));
      return null;
    } catch (err) {
      return String(err);
    }
  }, []);

  return { desktopAvailable, labels, models, coverageByLabel, gestureCountByLabel, recorderCountByLabel, usageFor, planFor, execute, error, create, update, setArchived, remove };
}

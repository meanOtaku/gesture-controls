import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OperationFeedback } from "../../components/app/OperationFeedback";
import { listGestureDefinitions } from "../gestureLibrary/gestureLibraryApi";
import type { NewLabel } from "../model-lab/components/LabelCoverage";
import { useLabelModels } from "../model-lab/hooks/useLabelModels";
import { datasetLabels, type DatasetLabel, type DatasetSummary } from "../model-lab/types";

const LABEL_COLOR = "#65e6ff";

/**
 * The one catalogue of labels, with everything that refers to each: recordings, models and gestures. Changes go through
 * the desktop, which keeps the catalogue; every other page reads it from there.
 */
export function useLabelCatalogue() {
  const desktopAvailable = "__TAURI_INTERNALS__" in window;
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [gestureLabels, setGestureLabels] = useState<(string | null)[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { models } = useLabelModels(desktopAvailable);

  useEffect(() => {
    if (!desktopAvailable) return;
    let live = true;
    void (async () => {
      try {
        const [catalogue, sets, gestures] = await Promise.all([
          invoke<DatasetLabel[]>("list_model_labels"),
          invoke<DatasetSummary[]>("list_model_datasets"),
          listGestureDefinitions(),
        ]);
        if (!live) return;
        setLabels(Array.isArray(catalogue) ? catalogue : []);
        setDatasets(Array.isArray(sets) ? sets : []);
        setGestureLabels(gestures.map((gesture) => gesture.labelId));
      } catch (err) {
        if (live) setError(String(err));
      }
    })();
    return () => {
      live = false;
    };
  }, [desktopAvailable]);

  const coverageByLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const dataset of datasets) for (const label of datasetLabels(dataset)) counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, [datasets]);
  const gestureCountByLabel = useMemo(() => {
    const counts = new Map<string, number>();
    for (const label of gestureLabels) if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }, [gestureLabels]);

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

  return { desktopAvailable, labels, models, coverageByLabel, gestureCountByLabel, error, create, update, setArchived, remove };
}

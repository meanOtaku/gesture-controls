import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { inImportOrder, type DatasetLabel, type DatasetSummary } from "../types";

/** The training recordings and the labels they can have: what Model Lab and the Network lab both train from. */
export function useModelLabData(desktopAvailable: boolean) {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [labels, setLabels] = useState<DatasetLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDatasets = useCallback(async () => {
    if (!desktopAvailable) return;
    setLoading(true);
    try {
      setDatasets(inImportOrder(await invoke<DatasetSummary[]>("list_model_datasets")));
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [desktopAvailable]);

  useEffect(() => {
    void refreshDatasets();
  }, [refreshDatasets]);

  useEffect(() => {
    if (!desktopAvailable) return;
    void (async () => {
      try {
        const result = await invoke<DatasetLabel[]>("list_model_labels");
        setLabels(Array.isArray(result) ? result : []);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [desktopAvailable]);

  return { datasets, labels, loading, error, setError, refreshDatasets };
}

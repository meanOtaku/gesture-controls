import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { LABEL_MODELS_EVENT, type LabelModel, type LabelRuntimeStatus } from "../labelModels";

const POLL_MS = 1000;

/** The registered label models and the runtime's status, refreshed every second and whenever the models change. */
export function useLabelModels(desktopAvailable: boolean) {
  const [models, setModels] = useState<LabelModel[]>([]);
  const [status, setStatus] = useState<LabelRuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!desktopAvailable) return;
    try {
      const [list, current] = await Promise.all([
        invoke<LabelModel[]>("list_label_models"),
        invoke<LabelRuntimeStatus>("get_label_runtime_status"),
      ]);
      setModels(Array.isArray(list) ? list : []);
      setStatus(current ?? null);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, [desktopAvailable]);

  useEffect(() => {
    void refresh();
    if (!desktopAvailable) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void Promise.resolve(listen(LABEL_MODELS_EVENT, () => void refresh()))
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [desktopAvailable, refresh]);

  return { models, status, error, refresh };
}

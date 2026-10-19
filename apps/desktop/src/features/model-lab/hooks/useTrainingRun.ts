import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { LABEL_TRAINING_EVENT, appendLog, type TrainingEvent, type TrainingStatus } from "../training";

export type TrainingFinished = Extract<TrainingEvent, { kind: "finished" }>;

/** The training run in progress (or just finished), from the desktop's events: shared by the places that start one. */
export function useTrainingRun(desktopAvailable: boolean) {
  const [running, setRunning] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [result, setResult] = useState<TrainingFinished | null>(null);

  useEffect(() => {
    if (!desktopAvailable) return;
    void invoke<TrainingStatus>("get_label_training_status")
      .then((status) => {
        if (status?.running) setRunning(status.running.runId);
        else if (status?.last?.kind === "finished") setResult(status.last);
      })
      .catch(() => undefined);
  }, [desktopAvailable]);

  useEffect(() => {
    if (!desktopAvailable) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void Promise.resolve(
      listen<TrainingEvent>(LABEL_TRAINING_EVENT, ({ payload }) => {
        if (disposed) return;
        if (payload.kind === "started") {
          setRunning(payload.runId);
          setLog([]);
          setResult(null);
        } else if (payload.kind === "log") {
          setLog((previous) => appendLog(previous, payload.message));
        } else {
          setRunning(null);
          setResult(payload);
          if (payload.outcome === "deployable") OperationFeedback.success("Training", `A model for ${payload.label} was added as a draft.`);
          else if (payload.outcome === "monitorOnly") OperationFeedback.success("Training", `A model for ${payload.label} was added as a draft that can only run in Monitor.`);
          else if (payload.outcome === "failed") OperationFeedback.error("Training", payload.message);
        }
      }),
    )
      .then((fn) => {
        if (disposed) fn?.();
        else unlisten = fn;
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopAvailable]);

  const reset = useCallback(() => {
    setResult(null);
    setLog([]);
  }, []);
  const clearResult = useCallback(() => setResult(null), []);

  return { running, log, result, reset, clearResult };
}

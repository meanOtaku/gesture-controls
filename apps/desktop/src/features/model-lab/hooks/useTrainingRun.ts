import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { OperationFeedback } from "../../../components/app/OperationFeedback";
import { LABEL_TRAINING_EVENT, appendLog, type TrainingEvent, type TrainingStatus } from "../training";

export type TrainingFinished = Extract<TrainingEvent, { kind: "finished" }>;

/** The training run as the desktop reports it: the run going (and its label), its log, and the last run's result. */
interface RunState {
  running: string | null;
  runningLabel: string | null;
  log: string[];
  result: TrainingFinished | null;
}

const EMPTY: RunState = { running: null, runningLabel: null, log: [], result: null };

/**
 * One store for the whole app, fed by one listener that stays for the app's life. The Train panel is unmounted when its
 * tab is left; with state of its own it lost the log lines sent while it was away and showed a bare "Training…" on return.
 */
let state: RunState = EMPTY;
let started = false;
let unlisten: (() => void) | undefined;
const subscribers = new Set<() => void>();

function set(change: Partial<RunState>) {
  state = { ...state, ...change };
  for (const notify of subscribers) notify();
}

function start() {
  if (started) return;
  started = true;
  void invoke<TrainingStatus>("get_label_training_status")
    .then((status) => {
      if (status?.running) set({ running: status.running.runId, runningLabel: status.running.label });
      else if (status?.last?.kind === "finished" && state.result === null && state.running === null) set({ result: status.last });
    })
    .catch(() => undefined);
  void Promise.resolve(
    listen<TrainingEvent>(LABEL_TRAINING_EVENT, ({ payload }) => {
      if (payload.kind === "started") {
        set({ running: payload.runId, runningLabel: payload.label, log: [], result: null });
      } else if (payload.kind === "log") {
        set({ log: appendLog(state.log, payload.message) });
      } else {
        set({ running: null, runningLabel: null, result: payload });
        if (payload.outcome === "deployable") OperationFeedback.success("Training", `A model for ${payload.label} was added as a draft.`);
        else if (payload.outcome === "monitorOnly") OperationFeedback.success("Training", `A model for ${payload.label} was added as a draft that can only run in Monitor.`);
        else if (payload.outcome === "failed") OperationFeedback.error("Training", payload.message);
      }
    }),
  )
    .then((fn) => { unlisten = fn; })
    .catch(() => undefined);
}

/** Forgets everything and stops listening, so a test starts from nothing. */
export function resetTrainingRunStore() {
  unlisten?.();
  unlisten = undefined;
  started = false;
  state = EMPTY;
  subscribers.clear();
}

const subscribe = (notify: () => void) => {
  subscribers.add(notify);
  return () => { subscribers.delete(notify); };
};
const snapshot = () => state;

/** The training run in progress (or just finished), from the desktop's events: shared by the places that start one, and
 * kept while they are not on screen. */
export function useTrainingRun(desktopAvailable: boolean) {
  useEffect(() => {
    if (desktopAvailable) start();
  }, [desktopAvailable]);
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  const reset = useCallback(() => set({ result: null, log: [] }), []);
  const clearResult = useCallback(() => set({ result: null }), []);
  return { running: current.running, runningLabel: current.runningLabel, log: current.log, result: current.result, reset, clearResult };
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useSyncExternalStore } from "react";
import { LABEL_MODELS_EVENT, type LabelRuntimeMode, type LabelRuntimeStatus } from "./labelModels";

/** How often the mode is asked for while something shows it. Changing it from here updates at once. */
const POLL_MS = 2000;

export interface RuntimeModeState {
  /** Null until the runtime has answered. */
  mode: LabelRuntimeMode | null;
  /** The registry could not be opened, so the mode cannot change. */
  blocked: boolean;
  pending: boolean;
  error: string | null;
}

let state: RuntimeModeState = { mode: null, blocked: false, pending: false, error: null };
const listeners = new Set<() => void>();
const inDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

function update(next: Partial<RuntimeModeState>) {
  const merged = { ...state, ...next };
  if (merged.mode === state.mode && merged.blocked === state.blocked && merged.pending === state.pending && merged.error === state.error) return;
  state = merged;
  for (const listener of listeners) listener();
}

const MODES: readonly LabelRuntimeMode[] = ["off", "monitor", "live"];

async function refresh() {
  if (!inDesktop()) return;
  try {
    const status = await invoke<LabelRuntimeStatus>("get_label_runtime_status");
    if (!status) return;
    if (MODES.includes(status.mode)) {
      update({ mode: status.mode, blocked: status.registryError != null, error: state.pending ? state.error : null });
    } else {
      // It answered without a mode: it has not started its models, or could not open the registry. Say which.
      update({ mode: null, blocked: true, error: status.registryError ?? "The model runtime has not started its models yet; if this stays, restart the app (Model Lab's log says why)." });
    }
  } catch (err) {
    // The next poll tries again; meanwhile the switch says why it cannot show the mode.
    update({ error: `The model runtime did not answer: ${String(err)}` });
  }
}

/** Asks the runtime to change mode. Live is only reached through this after the caller has had it confirmed. */
export async function setRuntimeMode(mode: LabelRuntimeMode): Promise<void> {
  update({ pending: true, error: null });
  try {
    await invoke("set_label_runtime_mode", { mode });
    update({ mode, pending: false });
  } catch (err) {
    update({ pending: false, error: String(err) });
  }
  await refresh();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The model runtime's mode (Off, Monitor or Live), shared by every switch that shows it, so the sidebar's and Model Lab's
 * always agree.
 */
export function useRuntimeMode(): RuntimeModeState {
  useEffect(() => {
    if (!inDesktop()) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    let disposed = false;
    let unlisten: (() => void) | undefined;
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
  }, []);
  return useSyncExternalStore(subscribe, () => state, () => state);
}

/** For tests: forget what was known. */
export function resetRuntimeModeForTests() {
  state = { mode: null, blocked: false, pending: false, error: null };
}

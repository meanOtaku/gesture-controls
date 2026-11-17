import { useSyncExternalStore } from "react";

/**
 * Where the pointer is over the lanes (ms into the recording, or null), kept outside the Labelling page's state: the page
 * is large, and re-rendering all of it on every pointer move kept the processor busy and made WebKit repaint (and
 * reallocate graphics memory for) the whole window. Only what shows the cursor subscribes: the lanes' cursor layers, the
 * "Cursor at" text and the hand preview.
 */
export interface HoverStore {
  get(): number | null;
  set(at: number | null): void;
  subscribe(listener: () => void): () => void;
}

export function createHoverStore(): HoverStore {
  let at: number | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => at,
    set(next) {
      if (next === at) return;
      at = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The pointer's position from `store`, re-rendering the caller (only) when it moves. */
export function useHover(store: HoverStore): number | null {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

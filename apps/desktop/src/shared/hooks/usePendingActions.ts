import { useCallback, useRef, useState } from "react";

/**
 * Tracks in-flight operations by an arbitrary string key (e.g. `capture:center`) so
 * per-control UI can show pending state and reject duplicate clicks while their own
 * request is outstanding, without blocking unrelated keys.
 */
export function usePendingActions() {
  const pendingRef = useRef<Set<string>>(new Set());
  const [, forceRender] = useState(0);

  const isPending = useCallback((key: string) => pendingRef.current.has(key), []);

  const run = useCallback(async (key: string, action: () => Promise<void>) => {
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key);
    forceRender((count) => count + 1);
    try {
      await action();
    } finally {
      pendingRef.current.delete(key);
      forceRender((count) => count + 1);
    }
  }, []);

  return { isPending, run };
}

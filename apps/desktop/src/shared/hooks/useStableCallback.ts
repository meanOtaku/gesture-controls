import { useCallback, useInsertionEffect, useRef } from "react";

/**
 * A function with a fixed identity that always calls the latest `fn`. Passing one to a memoised child lets the child
 * be skipped when only the parent re-rendered, which matters because the main view re-renders about 15 times a second
 * while a watch streams.
 */
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useInsertionEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}

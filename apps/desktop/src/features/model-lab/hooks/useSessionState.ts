import { useCallback, useState, type SetStateAction } from "react";

/** Values kept for the app session, by key, so a panel that is unmounted (its tab left) has them again when it returns. */
const kept = new Map<string, unknown>();

/** Like `useState`, but the value outlives the component for as long as the app runs. */
export function useSessionState<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() =>
    kept.has(key) ? (kept.get(key) as T) : typeof initial === "function" ? (initial as () => T)() : initial,
  );
  const update = useCallback((next: SetStateAction<T>) => {
    setValue((previous) => {
      const value = typeof next === "function" ? (next as (previous: T) => T)(previous) : next;
      kept.set(key, value);
      return value;
    });
  }, [key]);
  return [value, update] as const;
}

/** Forgets every kept value, so a test starts from nothing. */
export function resetSessionState() {
  kept.clear();
}

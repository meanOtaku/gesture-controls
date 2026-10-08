/**
 * Where dataset CSVs are exported. It is chosen once per session and shared by everything that exports, so it survives
 * moving between tabs (the recorder page unmounts when you look at the live charts) and the headless timer that
 * auto-exports a timed capture sees the same folder the recorder page set.
 */
let folder: string | null = null;
const listeners = new Set<() => void>();

export const exportFolderStore = {
  get: (): string | null => folder,
  set(next: string | null): void {
    if (next === folder) return;
    folder = next;
    listeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests. */
  reset(): void {
    exportFolderStore.set(null);
  },
};

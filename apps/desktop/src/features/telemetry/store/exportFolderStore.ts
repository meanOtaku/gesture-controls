/**
 * Where recordings are exported, and in what form: one setting for every export (the Recorder's Export button, the export
 * at the end of a timed or guided recording, the Labelling page's Export). It is shared, so it is the same wherever it is
 * read, and remembered between launches.
 */
export type ExportFormat = "folder" | "csv";

const FOLDER_KEY = "recorder.exportFolder";
const FORMAT_KEY = "recorder.exportFormat";

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Remembering it is a convenience; it still holds for this session.
  }
}

let folder: string | null = load(FOLDER_KEY);
let format: ExportFormat = load(FORMAT_KEY) === "csv" ? "csv" : "folder";
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export const exportFolderStore = {
  get: (): string | null => folder,
  set(next: string | null): void {
    if (next === folder) return;
    folder = next;
    save(FOLDER_KEY, next);
    notify();
  },
  /** A folder of two files (`ppg.csv` and `imu.csv`, the default) or one CSV. */
  getFormat: (): ExportFormat => format,
  setFormat(next: ExportFormat): void {
    if (next === format) return;
    format = next;
    save(FORMAT_KEY, next);
    notify();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  /** For tests: no folder, the default form, nothing remembered. */
  reset(): void {
    exportFolderStore.set(null);
    exportFolderStore.setFormat("folder");
    save(FOLDER_KEY, null);
    save(FORMAT_KEY, null);
  },
};

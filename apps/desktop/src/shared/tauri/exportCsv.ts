import { join } from "@tauri-apps/api/path";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";

export type ExportCsvRequest = {
  /** Exact CSV text to write; never mutated or re-derived here. */
  content: string;
  /** File name offered in the native save dialog, e.g. "gesture-dataset-wave-2026-09-12.csv". */
  suggestedName: string;
  /** Native save dialog title. */
  title: string;
};

export type ExportCsvResult =
  | { status: "saved"; path: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

export function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Opens the native folder picker. Returns null in browser preview (no native dialog exists there) or if the user cancels. */
export async function chooseExportFolder(title: string): Promise<string | null> {
  if (!isTauriDesktop()) return null;
  const result = await open({ title, directory: true, multiple: false });
  return typeof result === "string" ? result : null;
}

export type ExportCsvToFolderRequest = {
  /** Exact CSV text to write; never mutated or re-derived here. */
  content: string;
  /** Folder chosen via `chooseExportFolder`. */
  folder: string;
  /** Generated file name, e.g. "gesture-dataset-wave-2026-09-12.csv". */
  fileName: string;
};

/**
 * Writes CSV content straight into a previously chosen folder under the
 * given file name — no save dialog per export. In browser preview (no
 * Tauri runtime, so no folder could ever have been chosen) falls back to
 * the existing Blob-anchor download; in Tauri a required folder is the
 * caller's responsibility (see `chooseExportFolder`) and this never
 * substitutes the browser fallback for a missing one.
 */
export async function exportCsvToFolder({ content, folder, fileName }: ExportCsvToFolderRequest): Promise<ExportCsvResult> {
  if (!isTauriDesktop()) {
    return exportCsvViaBrowserDownload(content, fileName);
  }

  let path: string;
  try {
    path = await join(folder, fileName);
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }

  try {
    await writeTextFile(path, content);
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }

  return { status: "saved", path };
}

/**
 * Writes CSV content through the native Tauri save dialog + filesystem plugin.
 * In browser preview (no Tauri runtime) falls back to a Blob-anchor download,
 * since there is no native dialog to invoke there. The browser fallback is
 * never used to paper over a Tauri write failure.
 */
export async function exportCsv({ content, suggestedName, title }: ExportCsvRequest): Promise<ExportCsvResult> {
  if (!isTauriDesktop()) {
    return exportCsvViaBrowserDownload(content, suggestedName);
  }

  let path: string | null;
  try {
    path = await save({
      title,
      defaultPath: suggestedName,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }

  if (!path) {
    return { status: "cancelled" };
  }

  try {
    await writeTextFile(path, content);
  } catch (error) {
    return { status: "error", message: describeError(error) };
  }

  return { status: "saved", path };
}

function exportCsvViaBrowserDownload(content: string, suggestedName: string): ExportCsvResult {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
  try {
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { status: "saved", path: suggestedName };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

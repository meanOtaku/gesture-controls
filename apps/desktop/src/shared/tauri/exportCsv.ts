import { save } from "@tauri-apps/plugin-dialog";
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

function isTauriDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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

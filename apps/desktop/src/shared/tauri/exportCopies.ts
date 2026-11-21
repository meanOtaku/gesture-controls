import { invoke } from "@tauri-apps/api/core";
import { message } from "@tauri-apps/plugin-dialog";

/**
 * Copies of the same recording in an export folder (`export_copies.rs`). Two copies are of the same recording when they hold
 * the same sensor samples, whatever their labels or names; exporting a recording again replaces its earlier copy, and the
 * Exports card can clear out the older copies already in a folder.
 */

/** One exported copy of a recording. */
export interface ExportCopy {
  path: string;
  name: string;
  /** The CSV of a single-CSV export, which goes with its folder. */
  csvPath: string | null;
  signal: string;
  /** When its files last changed (an export, or labels saved to it), ms since 1970. */
  modifiedMs: number;
  exportedAtMs: number | null;
  /** Whether its labels were changed after it was exported; null for older exports, which do not say. */
  relabelledAfterExport: boolean | null;
  ppgRows: number;
  imuRows: number;
  handLabelledRows: number;
  labels: string[];
  /** `folder` (ppg.csv and imu.csv) or `csv` (one older single-file recording). */
  kind: "folder" | "csv";
  /** Which page wrote it, from what its folder holds: the Labelling page's export carries manual_labels.json. Null for a CSV. */
  exportedFrom: "labelling" | "recorder" | null;
  /** The time in its name, ms since 1970 (for a Recorder export, when it was exported). */
  nameTimeMs: number | null;
}

/** The copies of one recording, newest first. */
export interface CopyGroup {
  signal: string;
  copies: ExportCopy[];
  /** Why the first copy is the newest (file times, a later number, a Labelling export after the Recorder's, the time in the name). */
  newestReason: string | null;
  /** Whether the first copy is known to be the newest; when not (copies with other labels written at the same time), the person picks. */
  newestKnown: boolean;
}

/** What to do with earlier copies of a recording being exported. */
export type ExistingCopies = "ask" | "replace" | "keepBoth";

/** What an export did. */
export interface ExportOutcome {
  /** Where it was written; null when nothing was, because the person must choose. */
  written: string | null;
  /** Earlier copies moved to the Trash. */
  replaced: string[];
  /** Earlier copies that may hold newer hand labels than the export: ask, then export again. */
  needsChoice: ExportCopy[];
  warning: string | null;
}

export interface TrashOutcome {
  moved: string[];
  error: string | null;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** An outcome from the desktop (or a bare path, as exports returned before). */
function toOutcome(result: ExportOutcome | string): ExportOutcome {
  return typeof result === "string" ? { written: result, replaced: [], needsChoice: [], warning: null } : result;
}

function when(ms: number): string {
  return ms > 0 ? new Date(ms).toLocaleString() : "an unknown time";
}

/**
 * Asks what to do when earlier copies of the recording may hold newer hand labels than this export. Returns the choice, or
 * null to export nothing.
 */
export async function askAboutEarlierCopies(copies: ExportCopy[]): Promise<Exclude<ExistingCopies, "ask"> | null> {
  const lines = copies.map((copy) => {
    const changed = copy.relabelledAfterExport ? ", labels changed after it was exported" : "";
    return `• ${copy.name}: ${copy.handLabelledRows.toLocaleString()} hand-labelled rows, last changed ${when(copy.modifiedMs)}${changed}`;
  });
  const answer = await message(
    [
      copies.length === 1 ? "The export folder already has a copy of this recording:" : `The export folder already has ${copies.length} copies of this recording:`,
      ...lines,
      "",
      "Its hand labels may be newer than the ones you are exporting. Replace moves it to the Trash; Keep both adds another copy.",
    ].join("\n"),
    { title: "Replace the earlier copy?", kind: "warning", buttons: { yes: "Replace", no: "Keep both", cancel: "Cancel" } },
  );
  if (answer === "Replace" || answer === "Yes") return "replace";
  if (answer === "Keep both" || answer === "No") return "keepBoth";
  return null;
}

/**
 * Runs an export, asking first when an earlier copy may hold newer hand labels. Returns the outcome, or null when the person
 * cancelled.
 */
export async function exportReplacingEarlierCopies(
  run: (existing: ExistingCopies | undefined) => Promise<ExportOutcome | string>,
  ask: (copies: ExportCopy[]) => Promise<Exclude<ExistingCopies, "ask"> | null> = askAboutEarlierCopies,
): Promise<ExportOutcome | null> {
  const first = toOutcome(await run(undefined));
  if (first.written || first.needsChoice.length === 0) return first;
  const choice = await ask(first.needsChoice);
  if (!choice) return null;
  return toOutcome(await run(choice));
}

/** A line saying what an export replaced, to go after where it was written. */
export function replacedLine(outcome: ExportOutcome): string {
  // Every copy has a folder; a single-CSV export's CSV goes with it.
  const folders = outcome.replaced.filter((path) => !/\.csv$/i.test(path));
  if (folders.length === 0) return "";
  return folders.length === 1
    ? ` Replaced the earlier copy (${basename(folders[0])}), now in the Trash.`
    : ` Replaced ${folders.length} earlier copies, now in the Trash.`;
}

/** The recordings with more than one copy in `folder` (and, with `subfolders`, every folder below it), newest first. */
export function scanExportCopies(folder: string, subfolders = false): Promise<CopyGroup[]> {
  return invoke<CopyGroup[]>("scan_export_copies", { folder, subfolders });
}

/** Moves the chosen copies to the Trash; the desktop scans `folder` again the same way and refuses anything else. */
export function trashExportCopies(folder: string, paths: string[], subfolders = false): Promise<TrashOutcome> {
  return invoke<TrashOutcome>("trash_export_copies", { folder, paths, subfolders });
}

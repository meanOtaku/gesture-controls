import { formatTime } from "./labelModels";
import { recordingNumber, type DatasetSummary } from "./types";

type Named = Pick<DatasetSummary, "originalFilename" | "importedAt" | "recordedAt" | "quality" | "sequence" | "camera"> & { name?: string };

/**
 * When the session was recorded: from its Recorder recording, else the time in its file name (when the Recorder exported
 * it), else when it was imported. Null when nothing says.
 */
export function recordingWhen(dataset: Pick<DatasetSummary, "originalFilename" | "importedAt" | "recordedAt">): string | null {
  if (dataset.recordedAt) return dataset.recordedAt;
  const stamp = /(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?Z/.exec(dataset.originalFilename);
  if (stamp) return `${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5] ?? "000"}Z`;
  return dataset.importedAt || null;
}

/** The gestures it holds, most first: "20 pinches, 15 hand open". A pinch's in, hold and out count once. */
export function gestureSummary(dataset: Pick<DatasetSummary, "quality">): string {
  const holds = dataset.quality?.holds ?? {};
  const pinches = Math.max(holds.pinch ?? 0, holds.pinch_in ?? 0, holds.pinch_hold ?? 0);
  const counted: [string, number][] = Object.entries(holds).filter(([label]) => !["pinch", "pinch_in", "pinch_hold", "pinch_out", "left_out"].includes(label));
  if (pinches > 0) counted.push([pinches === 1 ? "pinch" : "pinches", pinches]);
  return counted
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${count} ${label.replaceAll("_", " ")}`)
    .join(", ");
}

/** What to call a recording: the name you gave it, else `defaultTitle`. */
export function recordingTitle(dataset: Named): string {
  return dataset.name?.trim() || defaultTitle(dataset);
}

/** What a recording is called with no name: when it was recorded and what it holds ("03/11/2026 06:35 AM · 20 pinches"), else its file name. */
export function defaultTitle(dataset: Named): string {
  const when = recordingWhen(dataset);
  const parts = [when ? formatTime(when) : "", gestureSummary(dataset)].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : dataset.originalFilename;
}

/** A recording's number and title, for messages and plans: "#30 Monday pinches" or "#30 03/11/2026 06:35 AM · 20 pinches". */
export function recordingName(dataset: Named): string {
  return [recordingNumber(dataset), recordingTitle(dataset)].filter(Boolean).join(" ");
}

/** A recording in one line of text, for lists and pickers: "#30 03/11/2026 06:35 AM · 20 pinches · camera". */
export function recordingLine(dataset: Named): string {
  return [recordingNumber(dataset), `${recordingTitle(dataset)} · ${dataset.camera ? "camera" : "no camera"}`].filter(Boolean).join(" ");
}

/**
 * How a report from the desktop (which names a recording by its file) shows recording `id`: its line from `datasets` when
 * Model Lab still has it, else `fallback`.
 */
export function lineOf(datasets: DatasetSummary[] | undefined, id: string, fallback: string): string {
  const dataset = datasets?.find((entry) => entry.id === id);
  return dataset ? recordingLine(dataset) : fallback;
}

/** How its labels were made, in words; null when nothing says. */
export function labelsFromText(dataset: Pick<DatasetSummary, "labelsFrom" | "derivedFrom">): string | null {
  if (dataset.derivedFrom) return null; // a new version says it was labelled by hand
  switch (dataset.labelsFrom) {
    case "camera":
      return "Labels marked by the camera, where it saw the fingers meet and part";
    case "motion":
      return "Labels estimated from the watch's motion (no camera): good for testing, less exact for training";
    case "recorder":
      return "Labels marked while recording, by a button, key or cue";
    case "mixed":
      return "Labels marked partly by the camera and partly while recording";
    default:
      return null;
  }
}

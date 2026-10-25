import { describeContext } from "../telemetry/sessionContext";
import { datasetLabels, describeGaps, describeQuality, recordingDay, sameDataAs, type DatasetSummary } from "./types";

/** What the recordings list shows, and in what order. */
export interface RecordingFilter {
  text: string;
  day: string;
  label: string;
  show: "all" | "problems" | "duplicates" | "sealed" | "unsealed" | "unreviewed" | "needs_work";
  sort: "number" | "name" | "day" | "contact" | "holds";
}

export const NO_FILTER: RecordingFilter = { text: "", day: "", label: "", show: "all", sort: "number" };

/** Whether a recording has anything worth fixing: poor contact, short or no holds, a stalled stream, or a copy. */
export function hasProblem(dataset: DatasetSummary, all: DatasetSummary[]): boolean {
  return Boolean(describeQuality(dataset.quality)?.warn || describeGaps(dataset.gaps)?.warn || sameDataAs(dataset, all).length > 0);
}

const holdCount = (dataset: DatasetSummary) => Object.values(dataset.quality?.holds ?? {}).reduce((sum, count) => sum + count, 0);

/** The recordings `filter` lets through, in its order. */
export function filterRecordings(datasets: DatasetSummary[], filter: RecordingFilter): DatasetSummary[] {
  const words = filter.text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const kept = datasets.filter((dataset) => {
    if (filter.day && recordingDay(dataset) !== filter.day) return false;
    if (filter.label && !datasetLabels(dataset).includes(filter.label)) return false;
    if (filter.show === "problems" && !hasProblem(dataset, datasets)) return false;
    if (filter.show === "duplicates" && sameDataAs(dataset, datasets).length === 0) return false;
    if (filter.show === "sealed" && !dataset.sealed) return false;
    if (filter.show === "unsealed" && dataset.sealed) return false;
    if (filter.show === "unreviewed" && dataset.review) return false;
    if (filter.show === "needs_work" && dataset.review?.status !== "needs_work") return false;
    const haystack = `${dataset.originalFilename} ${dataset.label} ${dataset.context ? describeContext(dataset.context) : ""}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
  const by: Record<RecordingFilter["sort"], (a: DatasetSummary, b: DatasetSummary) => number> = {
    number: (a, b) => (a.sequence ?? 0) - (b.sequence ?? 0),
    name: (a, b) => a.originalFilename.localeCompare(b.originalFilename),
    day: (a, b) => recordingDay(a).localeCompare(recordingDay(b)) || (a.sequence ?? 0) - (b.sequence ?? 0),
    // Worst contact first.
    contact: (a, b) => (b.quality?.poorContactShare ?? 0) - (a.quality?.poorContactShare ?? 0),
    // Most holds first.
    holds: (a, b) => holdCount(b) - holdCount(a),
  };
  return [...kept].sort(by[filter.sort]);
}

/** Each set of recordings holding the same data, oldest first; only sets of two or more. */
export function duplicateGroups(datasets: DatasetSummary[]): DatasetSummary[][] {
  const groups = new Map<string, DatasetSummary[]>();
  for (const dataset of datasets) {
    if (!dataset.contentSha) continue;
    groups.set(dataset.contentSha, [...(groups.get(dataset.contentSha) ?? []), dataset]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => [...group].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || a.importedAt.localeCompare(b.importedAt)));
}

/**
 * The copies to delete so each recording is kept once: all but one of each set. The one kept is a sealed copy if there is
 * one (so the final test keeps its recordings), else the oldest.
 */
export function extraCopies(datasets: DatasetSummary[]): DatasetSummary[] {
  return duplicateGroups(datasets).flatMap((group) => {
    const keep = group.find((dataset) => dataset.sealed) ?? group[0];
    return group.filter((dataset) => dataset !== keep);
  });
}

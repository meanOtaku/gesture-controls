import { describe, expect, it } from "vitest";
import { extraCopies, filterRecordings, hasProblem, NO_FILTER } from "./recordingFilters";
import type { DatasetSummary } from "./types";

const quality = (poor: number, holds: Record<string, number> = { pinch: 10 }) => ({ poorContactShare: poor, holds, shortHolds: 0 });
const recordings: DatasetSummary[] = [
  { id: "a", sequence: 1, originalFilename: "dataset-2026-10-17T10-00", importedAt: "2026-10-18", label: "pinch", labels: ["pinch"], rowCount: 1, contentSha: "x", quality: quality(0), context: { activity: "typing" } },
  { id: "b", sequence: 2, originalFilename: "dataset-2026-10-17T11-00 (folder)", importedAt: "2026-10-18", label: "pinch", labels: ["pinch"], rowCount: 1, contentSha: "x", quality: quality(0) },
  { id: "c", sequence: 3, originalFilename: "dataset-2026-10-20T09-00", importedAt: "2026-10-20", label: "fist, pinch", labels: ["fist", "pinch"], rowCount: 1, contentSha: "y", quality: quality(0.3, { pinch: 30 }), sealed: true },
  { id: "d", sequence: 4, originalFilename: "dataset-2026-10-20T10-00", importedAt: "2026-10-20", label: "fist", labels: ["fist"], rowCount: 1, contentSha: "y", quality: quality(0) },
];
const ids = (list: DatasetSummary[]) => list.map((d) => d.id);

describe("filtering the recordings", () => {
  it("narrows by day, label, words (session details too) and what is wrong", () => {
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, day: "2026-10-20" }))).toEqual(["c", "d"]);
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, label: "fist" }))).toEqual(["c", "d"]);
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, text: "typing" }))).toEqual(["a"]);
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, show: "sealed" }))).toEqual(["c"]);
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, show: "duplicates" }))).toEqual(["a", "b", "c", "d"]);
    expect(hasProblem({ ...recordings[2], contentSha: "z" }, recordings)).toBe(true); // poor contact
    expect(hasProblem({ ...recordings[3], contentSha: "w" }, recordings)).toBe(false);
  });

  it("sorts worst contact or most holds first", () => {
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, sort: "contact" }))[0]).toBe("c");
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, sort: "holds" }))[0]).toBe("c");
    expect(ids(filterRecordings(recordings, { ...NO_FILTER, sort: "name" }))).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps one of each set of copies: the sealed one, else the oldest", () => {
    expect(ids(extraCopies(recordings))).toEqual(["b", "d"]);
  });
});

import { describe, expect, it } from "vitest";
import { extraCopies, filterRecordings, groupNames, groupRecordings, hasProblem, NO_FILTER, sessionCopies } from "./recordingFilters";
import type { DatasetSummary } from "./types";

describe("sessionCopies", () => {
  const take = (id: string, sequence: number, over: Partial<DatasetSummary> = {}): DatasetSummary => ({ id, sequence, originalFilename: `${id}.csv`, importedAt: "2026-10-18", label: "pinch", rowCount: 1, contentSha: id, ...over });
  const keepOf = (...datasets: DatasetSummary[]) => sessionCopies([datasets.map((d) => d.id)], datasets)[0];

  it("suggests nothing between copies labelled differently with nothing to tell them apart", () => {
    expect(keepOf(take("a", 1), take("b", 2))).toMatchObject({ keep: null, why: null, sameLabels: false });
  });

  it("suggests the oldest of copies that are the same in every row", () => {
    expect(keepOf(take("b", 2, { contentSha: "x" }), take("a", 1, { contentSha: "x" }))).toMatchObject({ keep: "a", why: "the oldest copy", sameLabels: true });
  });

  it("puts the sealed copy before the reviewed one, and the reviewed one before the latest version", () => {
    const reviewed = { review: { status: "reviewed", at: "2026-10-19" } } as const;
    expect(keepOf(take("a", 1, { sealed: true }), take("b", 2, reviewed)).keep).toBe("a");
    expect(keepOf(take("a", 1), take("b", 2, reviewed), take("c", 3, { derivedFrom: "a" })).keep).toBe("b");
    expect(keepOf(take("a", 1), take("b", 2, { derivedFrom: "a" })).keep).toBe("b");
  });

  it("leaves the choice to you when two copies are sealed", () => {
    expect(keepOf(take("a", 1, { sealed: true, contentSha: "x" }), take("b", 2, { sealed: true, contentSha: "x" })).keep).toBeNull();
  });

  it("drops a set with fewer than two recordings still listed", () => {
    expect(sessionCopies([["a", "gone"]], [take("a", 1)])).toEqual([]);
  });
});

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

describe("grouping the recordings", () => {
  const grouped = [{ ...recordings[0], group: "old" }, recordings[1], { ...recordings[2], group: "day b" }, { ...recordings[3], group: "old" }];

  it("lists those in no group first, then each group by name, keeping their order", () => {
    expect(groupRecordings(grouped).map((g) => [g.name, ids(g.recordings)])).toEqual([[null, ["b"]], ["day b", ["c"]], ["old", ["a", "d"]]]);
    expect(groupRecordings(recordings).map((g) => g.name)).toEqual([null]);
    expect(groupRecordings([grouped[0]]).map((g) => g.name)).toEqual(["old"]);
    expect(groupNames(grouped)).toEqual(["day b", "old"]);
  });

  it("finds recordings by their group's name", () => {
    expect(ids(filterRecordings(grouped, { ...NO_FILTER, text: "day b" }))).toEqual(["c"]);
  });
});

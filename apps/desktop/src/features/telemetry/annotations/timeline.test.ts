import { describe, expect, it } from "vitest";
import { reindexIntervalsAfterInsert, type LiveInterval } from "./timeline";

describe("reindexIntervalsAfterInsert", () => {
  const interval = (id: string, start: number, end: number | null): LiveInterval => ({
    intervalId: id,
    labelId: "idle",
    startMonotonicNs: 0,
    endMonotonicNs: end === null ? null : 1,
    startRawRow: start,
    endRawRow: end,
    creationMechanism: "hotkey_hold",
    curationStatus: "unreviewed",
    createdAt: "2026-01-01T00:00:00Z",
    revision: 1,
  });
  const bounds = (list: LiveInterval[]) => list.map((i) => [i.intervalId, i.startRawRow, i.endRawRow]);

  it("leaves an in-order append below capacity alone", () => {
    const list = [interval("a", 0, 5), interval("b", 5, null)];
    expect(bounds(reindexIntervalsAfterInsert(list, 10, 10, false))).toEqual([["a", 0, 5], ["b", 5, null]]);
  });

  it("keeps the existing out-of-order rule: bounds at or after the insert move one later", () => {
    const list = [interval("a", 0, 5), interval("b", 5, 9)];
    expect(bounds(reindexIntervalsAfterInsert(list, 3, 10, false))).toEqual([["a", 0, 6], ["b", 6, 10]]);
  });

  // Once the buffer is full every further append drops row 0, moving all rows one earlier.
  it("shifts every bound one earlier when an in-order append evicts the oldest row", () => {
    const list = [interval("a", 10, 20), interval("b", 20, null)];
    expect(bounds(reindexIntervalsAfterInsert(list, 200_000, 200_000, true))).toEqual([["a", 9, 19], ["b", 19, null]]);
  });

  it("clamps an interval that loses its first row, and removes one that was entirely evicted", () => {
    const list = [interval("gone", 0, 1), interval("front", 0, 5), interval("open", 1, null)];
    const result = reindexIntervalsAfterInsert(list, 100, 100, true);
    expect(bounds(result)).toEqual([["front", 0, 4], ["open", 0, null]]);
  });

  it("combines an out-of-order insert with eviction", () => {
    // Insert lands at 3 in a full buffer: rows after it shift later, then the evicted row shifts all earlier.
    const list = [interval("a", 0, 5), interval("b", 5, 9)];
    expect(bounds(reindexIntervalsAfterInsert(list, 3, 10, true))).toEqual([["a", 0, 5], ["b", 5, 9]]);
  });

  it("keeps rows pointing at the same data across a long run of appends at capacity", () => {
    // Simulate the buffer: an interval owns the rows whose values are 100..104; append many rows at capacity.
    const capacity = 50;
    let rows = Array.from({ length: capacity }, (_, i) => i + 90); // values 90..139
    const owned = interval("a", 10, 15); // values 100..104
    let list = [owned];
    for (let step = 0; step < 8; step += 1) {
      const previousLength = rows.length;
      rows = [...rows.slice(1), 1000 + step]; // append at capacity evicts the oldest
      list = reindexIntervalsAfterInsert(list, previousLength, previousLength, true);
    }
    const [kept] = list;
    expect(rows.slice(kept.startRawRow, kept.endRawRow as number)).toEqual([100, 101, 102, 103, 104]);
  });
});
